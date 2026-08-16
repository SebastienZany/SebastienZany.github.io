// Recording storage that works on the real site, not just the dev server.
//
// The Render button used to POST the recording to /__save and then reload into
// ?render&replay=<file>, which the offline harness fetched back from
// replay/out/. That only ever worked against replay/devserver.mjs. On
// bestiaryofvanishings.com the POST 404s, the reload fetches a file that does not
// exist, GitHub Pages answers with its HTML 404 page, and the harness dies on
//   SyntaxError: JSON.parse: unexpected character at line 1 column 1
// which is the 404 page's leading '<'.
//
// IndexedDB survives the reload in the same tab and needs no server, so the
// hand-off works anywhere the piece is hosted. The dev-server path is still
// tried first so existing .cvr files on disk keep working.

const DB = 'cuttle-replay';
const STORE = 'recordings';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

export async function saveRecording(name, recording) {
  const db = await open();
  await new Promise((resolve, reject) => {
    const req = tx(db, 'readwrite').put(recording, name);
    req.onsuccess = resolve;
    req.onerror = () => reject(req.error);
  });
  db.close();
  return { name, ok: true };
}

/**
 * Load by name: the dev server's file first, then IndexedDB.
 *
 * The fetch is validated by PARSING it, not by response.ok — a static host
 * answers a missing file with a 200-ish HTML error page often enough that
 * checking the status is not sufficient.
 */
export async function loadRecording(name) {
  try {
    const res = await fetch(`/replay/out/${name}`, { cache: 'no-store' });
    if (res.ok) {
      const text = await res.text();
      if (text.trimStart().startsWith('{')) return JSON.parse(text);
    }
  } catch { /* fall through to IndexedDB */ }

  const db = await open();
  const rec = await new Promise((resolve, reject) => {
    const req = tx(db, 'readonly').get(name);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  if (!rec) throw new Error(`recording "${name}" not found on disk or in IndexedDB`);
  return rec;
}

export async function listRecordings() {
  const db = await open();
  const keys = await new Promise((resolve, reject) => {
    const req = tx(db, 'readonly').getAllKeys();
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return keys;
}

/**
 * Deliver a finished render. Writes through the dev server when one is there,
 * otherwise hands the file to the browser as a download — on a static host there
 * is nowhere to POST it, and silently succeeding while dropping a ten-minute
 * render on the floor is the worst possible outcome.
 */
export async function deliverFile(name, data, mime = 'video/mp4') {
  try {
    const res = await fetch(`/__save?name=${encodeURIComponent(name)}`, { method: 'POST', body: data });
    if (res.ok) {
      const text = await res.text();
      if (text.trimStart().startsWith('{')) return { via: 'devserver', ...JSON.parse(text) };
    }
  } catch { /* no dev server — download instead */ }

  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return { via: 'download', ok: true, name, bytes: blob.size };
}
