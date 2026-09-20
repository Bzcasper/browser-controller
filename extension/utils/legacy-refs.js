export function createLegacyRefRuntime() {
  const KEY = '__browserControllerLegacyRefRegistry';
  const root = globalThis;
  const registry = root[KEY] instanceof Map ? root[KEY] : new Map();
  root[KEY] = registry;

  function cssEscape(value) {
    if (root.CSS && typeof root.CSS.escape === 'function') return root.CSS.escape(String(value));
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function deepQuery(selector, doc = document, depth = 0) {
    try {
      const el = doc.querySelector(selector);
      if (el) return el;
    } catch {}
    if (depth >= 3) return null;
    let frames = [];
    try { frames = Array.from(doc.querySelectorAll('iframe')); } catch {}
    for (const frame of frames) {
      try {
        const childDoc = frame.contentDocument;
        if (childDoc) {
          const found = deepQuery(selector, childDoc, depth + 1);
          if (found) return found;
        }
      } catch {}
    }
    return null;
  }

  function isConnected(el) {
    if (!el) return false;
    if (typeof el.isConnected === 'boolean') return el.isConnected;
    return true;
  }

  function registerRef(ref, el) {
    if (ref && el) registry.set(ref, el);
    return ref;
  }

  function resolveRef(ref) {
    if (!ref) return null;
    const remembered = registry.get(ref);
    if (isConnected(remembered)) return remembered;
    registry.delete(ref);
    return deepQuery(`[data-mcp-ref="${cssEscape(ref)}"]`);
  }

  return { registerRef, resolveRef, deepQuery };
}

export function PAGE_LEGACY_REF_INSTALL() {
  if (globalThis.__browserControllerLegacyRefRuntime) return false;
  globalThis.__browserControllerLegacyRefRuntime = createLegacyRefRuntime();
  return true;
}
