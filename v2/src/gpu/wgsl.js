const INCLUDE_LINE = /^[ \t]*\/\/#include[ \t]+"([^"]+)"[ \t]*$/gm;
const CONSTANT_TOKEN = /\$\{([A-Z][A-Z0-9_]*)\}/g;

export async function preprocessWgsl(source, {
  constants = {},
  resolveInclude,
  sourceName = '<inline>',
} = {}) {
  const expanded = await expandIncludes(String(source), sourceName, [], resolveInclude);
  return expanded.replace(CONSTANT_TOKEN, (_, name) => {
    if (!Object.hasOwn(constants, name)) {
      throw new Error(`Missing WGSL constant ${name} in ${sourceName}`);
    }
    return formatConstant(constants[name], name);
  });
}

export async function fetchWgsl(url, {
  constants = {},
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchWgsl requires fetch');
  const cache = new Map();

  async function load(resourceUrl) {
    const absoluteUrl = String(resourceUrl);
    if (cache.has(absoluteUrl)) return cache.get(absoluteUrl);
    const response = await fetchImpl(absoluteUrl, { cache: 'no-store' });
    if (!response.ok) throw new Error(`WGSL fetch failed (${response.status}) for ${absoluteUrl}`);
    const text = await response.text();
    cache.set(absoluteUrl, text);
    return text;
  }

  const entryUrl = new URL(url, globalThis.location?.href || 'http://local/').href;
  const source = await load(entryUrl);
  return preprocessWgsl(source, {
    constants,
    sourceName: entryUrl,
    resolveInclude: async (includePath, parentName) => {
      const includeUrl = new URL(includePath, parentName).href;
      return { source: await load(includeUrl), sourceName: includeUrl };
    },
  });
}

async function expandIncludes(source, sourceName, stack, resolveInclude) {
  if (stack.includes(sourceName)) {
    throw new Error(`WGSL include cycle: ${[...stack, sourceName].join(' -> ')}`);
  }
  const nextStack = [...stack, sourceName];
  const includeLine = new RegExp(INCLUDE_LINE.source, INCLUDE_LINE.flags);
  let output = '';
  let cursor = 0;
  for (let match = includeLine.exec(source); match; match = includeLine.exec(source)) {
    output += source.slice(cursor, match.index);
    if (!resolveInclude) throw new Error(`Cannot resolve WGSL include "${match[1]}" from ${sourceName}`);
    const resolved = await resolveInclude(match[1], sourceName);
    if (resolved === undefined || resolved === null) {
      throw new Error(`Missing WGSL include "${match[1]}" from ${sourceName}`);
    }
    const includedSource = typeof resolved === 'string' ? resolved : resolved.source;
    const includedName = typeof resolved === 'string' ? match[1] : (resolved.sourceName || match[1]);
    output += await expandIncludes(String(includedSource), includedName, nextStack, resolveInclude);
    cursor = match.index + match[0].length;
  }
  return output + source.slice(cursor);
}

function formatConstant(value, name) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return value;
  throw new TypeError(`WGSL constant ${name} must be a finite number, boolean, or string`);
}
