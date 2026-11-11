// Diagnostics shell. A plain script that runs before any game code, so it can
// record and show what happened on a device where the game never starts.
//
//   window.__diag.log(tag, detail)   add a line to the log
//   window.__diag.show()             open the report overlay
//   window.__diag.report()           the report as text
//   window.__diag.markLoaded()       the game reached its start button
//
// The report opens by itself on an error before the game has loaded, if loading
// takes longer than 20 s, or with ?diag=1; triple-tapping the start screen
// toggles it. The last lines are saved every 250 ms, so after a crash the next
// load (try ?safe=1) can show how far the previous one got.
(() => {
  const BUILD = window.__BUILD_VERSION ?? 'unknown';
  const STORE_KEY = 'bestiary-diag-last';
  const LOAD_COUNT_KEY = 'bestiary-diag-loads';
  const MAX_LINES = 400;
  const SAVED_LINES = 150;
  const WATCHDOG_MS = 20000;
  const TRIPLE_TAP_MS = 1200;

  const startedAt = performance.now();
  const lines = [];
  let loaded = false;
  let overlay = null;
  let reportEl = null;
  let saveTimer = 0;

  const read = (storage, key) => { try { return storage.getItem(key); } catch { return null; } };
  const write = (storage, key, value) => { try { storage.setItem(key, value); } catch { /* private mode */ } };

  let previousRun = null;
  try { previousRun = JSON.parse(read(localStorage, STORE_KEY) ?? 'null'); } catch { /* corrupt entry */ }
  const loadCount = Number(read(sessionStorage, LOAD_COUNT_KEY) ?? 0) + 1;
  write(sessionStorage, LOAD_COUNT_KEY, String(loadCount));

  function save() {
    saveTimer = 0;
    write(localStorage, STORE_KEY, JSON.stringify({ at: new Date().toISOString(), loaded, lines: lines.slice(-SAVED_LINES) }));
  }
  function log(tag, detail) {
    const ms = String(Math.round(performance.now() - startedAt)).padStart(6);
    lines.push(`+${ms}ms  ${tag}${detail ? `  ${detail}` : ''}`);
    if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
    if (!saveTimer) saveTimer = setTimeout(save, 250);
    if (reportEl) reportEl.textContent = report();
  }

  function report() {
    const parts = [
      `bestiary diagnostics — ${new Date().toISOString()}`,
      location.href,
      `build ${BUILD}`,
      `load #${loadCount} in this tab (above 1 without you reloading means the browser killed and reloaded the page)`,
      '', '--- this run ---', ...lines,
    ];
    if (previousRun?.lines) {
      parts.push('', `--- previous run (${previousRun.at}, ${previousRun.loaded ? 'completed' : 'DID NOT FINISH LOADING'}) ---`, ...previousRun.lines);
    }
    return parts.join('\n');
  }

  function show() {
    if (overlay) {
      overlay.hidden = false;
      reportEl.textContent = report();
      return;
    }
    overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(4,6,6,0.94);color:#cfe9df;' +
      'font:11px/1.45 ui-monospace,Menlo,monospace;display:flex;flex-direction:column;' +
      'padding:calc(10px + env(safe-area-inset-top)) 10px calc(10px + env(safe-area-inset-bottom));';
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:8px;margin-bottom:8px;';
    const button = (label, onClick) => {
      const el = document.createElement('button');
      el.textContent = label;
      el.style.cssText = 'font:inherit;color:inherit;background:#12201c;border:1px solid #2c4a40;border-radius:4px;padding:6px 12px;';
      el.addEventListener('click', onClick);
      bar.append(el);
      return el;
    };
    const copy = button('copy', async () => {
      try {
        await navigator.clipboard.writeText(report());
        copy.textContent = 'copied';
      } catch {
        // No clipboard permission: select the text so it can be copied by hand.
        getSelection().selectAllChildren(reportEl);
        copy.textContent = 'select + copy';
      }
    });
    button('close', () => { overlay.hidden = true; });
    reportEl = document.createElement('pre');
    reportEl.style.cssText = 'flex:1;margin:0;overflow:auto;white-space:pre-wrap;word-break:break-word;user-select:text;-webkit-user-select:text;';
    reportEl.textContent = report();
    overlay.append(bar, reportEl);
    document.body.append(overlay);
  }
  const toggle = () => (overlay && !overlay.hidden ? (overlay.hidden = true) : show());

  log('boot', `build ${BUILD} — load #${loadCount}`);
  log('env', JSON.stringify({
    ua: navigator.userAgent,
    screen: `${screen.width}x${screen.height}@${devicePixelRatio}`,
    cores: navigator.hardwareConcurrency,
    visibility: document.visibilityState,
    online: navigator.onLine,
  }));
  if (!(HTMLScriptElement.supports && HTMLScriptElement.supports('importmap'))) {
    log('fatal', 'this browser does not support import maps; the game cannot load (needs iOS 16.4+ or a 2023+ browser)');
  }

  addEventListener('error', (event) => {
    const target = event.target;
    if (target && target !== window && (target.src || target.href)) log('resource-error', String(target.src || target.href));
    else log('js-error', `${event.message} @ ${event.filename ?? '?'}:${event.lineno ?? '?'}`);
    if (!loaded) show();
  }, true);
  addEventListener('unhandledrejection', (event) => {
    log('unhandled-rejection', String(event.reason?.stack ?? event.reason).slice(0, 600));
    if (!loaded) show();
  });
  addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', () => log('visibility', document.visibilityState));
  document.addEventListener('DOMContentLoaded', () => log('dom', 'ready'));
  for (const level of ['warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      log(`console.${level}`, args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' ').slice(0, 400));
      original(...args);
    };
  }

  setTimeout(() => {
    if (loaded) return;
    log('watchdog', `still not loaded after ${WATCHDOG_MS / 1000} s`);
    show();
  }, WATCHDOG_MS);
  if (new URLSearchParams(location.search).has('diag')) addEventListener('DOMContentLoaded', show);

  // Triple-tap the start screen to toggle the report.
  const taps = [];
  document.addEventListener('pointerup', (event) => {
    if (!event.target.closest?.('#startScreen')) return;
    const now = performance.now();
    taps.push(now);
    while (taps.length && now - taps[0] > TRIPLE_TAP_MS) taps.shift();
    if (taps.length >= 3) {
      taps.length = 0;
      toggle();
    }
  });

  window.__diag = {
    buildVersion: BUILD,
    log,
    show,
    report,
    markLoaded() {
      loaded = true;
      log('ready', 'start button shown');
      save();
    },
  };
})();
