// Boot shell. Makes sure the browser is about to run the current game code,
// then starts it.
//
// The host lets browsers reuse a cached file for ten minutes without asking.
// Right after a deploy that could pair a new page with old scripts. So before
// starting the game this walks the game's own import graph and asks the server
// about every module (a conditional request: an unchanged file answers "not
// modified" with no body). The module loader that runs next then finds only
// current copies. It also checks that this page itself is current, and reloads
// once if it is not.
(() => {
  const diag = window.__diag;
  const ENTRY = 'src/main.js';
  const GIVE_UP_MS = 3000;
  const params = new URLSearchParams(location.search);

  if (params.has('safe')) {
    // ?safe=1: load nothing heavy, just show the log of the run that crashed.
    diag?.log('safe-mode', 'game not loaded; see the previous run below');
    diag?.show();
    return;
  }

  async function refreshModule(url, seen) {
    if (seen.has(url)) return;
    seen.add(url);
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) return;
    const source = await response.text();
    const imports = [...source.matchAll(/(?:\bfrom|\bimport)\s*['"](\.{1,2}\/[^'"]+\.js)['"]/g)]
      .map((match) => new URL(match[1], url).href);
    await Promise.all(imports.map((dependency) => refreshModule(dependency, seen)));
  }

  async function pageIsCurrent() {
    const response = await fetch(location.pathname, { cache: 'no-cache' });
    if (!response.ok) return true;
    const stamp = (await response.text()).match(/__BUILD_VERSION = '([^']+)'/)?.[1];
    return !stamp || stamp === window.__BUILD_VERSION;
  }

  let started = false;
  function start() {
    if (started) return;
    started = true;
    const script = document.createElement('script');
    script.type = 'module';
    script.src = ENTRY;
    document.body.append(script);
  }

  const startedAt = performance.now();
  const seen = new Set();
  Promise.all([refreshModule(new URL(ENTRY, location.href).href, seen), pageIsCurrent()])
    .then(([, current]) => {
      diag?.log('freshness', `${seen.size} modules checked in ${Math.round(performance.now() - startedAt)} ms`);
      const RELOADED_KEY = `bestiary-reloaded-for:${window.__BUILD_VERSION}`;
      let alreadyReloaded = true;
      try {
        alreadyReloaded = sessionStorage.getItem(RELOADED_KEY) === '1';
        sessionStorage.setItem(RELOADED_KEY, '1');
      } catch { /* no storage: never auto-reload */ }
      if (!current && !alreadyReloaded) {
        diag?.log('freshness', 'this page is an old cached copy; reloading once');
        location.reload();
        return;
      }
      start();
    })
    .catch((error) => {
      diag?.log('freshness', `check failed (${error.message}); starting anyway`);
      start();
    });
  // Offline or a slow network must not hold the game back.
  setTimeout(start, GIVE_UP_MS);
})();
