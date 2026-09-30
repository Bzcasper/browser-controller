/**
 * Page-execution primitives (extracted from background.js): tab resolution,
 * the locator guard, and safeExec. Everything a handler needs to touch a page.
 */
import { fallbackByTab } from './state.js';
import { PAGE_DOM_INSTALL, PAGE_DOM_VERSION } from './page-dom.js';

/**
 * Resolve a tab by id, throwing a clear, actionable error if it's gone.
 * Replaces the old getActiveTab()-style silent fallback — the root cause of
 * agents acting on the wrong page.
 */
export async function resolveTab(tabId) {
  if (tabId == null || typeof tabId !== 'number') {
    throw new Error('tabId is required. Call browser_tabs list first to get a tabId.');
  }
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab) throw new Error(`Tab ${tabId} not found, call browser_tabs list first.`);
    return tab;
  } catch (err) {
    throw new Error(`Tab ${tabId} not found, call browser_tabs list first. (${err.message || err})`);
  }
}

/**
 * Locator guard for element-targeting tools. The MCP SDK receives the raw
 * zod shape, so schema-level superRefine never runs — and direct WS clients
 * bypass the schema entirely. Without this, "neither given" surfaced as the
 * misleading "Element undefined is gone from the DOM" after a wasted
 * round-trip (critical audit #10).
 */
export function requireTarget(params) {
  if (!params.ref && !params.selector) {
    throw new Error('ref or selector is required (get refs from browser_snapshot / browser_find).');
  }
}

/**
 * Get the stored smart-selector fallback for a (tabId, ref). Returns null if
 * the ref was never snapshotted or the snapshot pre-dates the fallback feature.
 */
export function getFallback(tabId, ref) {
  if (tabId == null || !ref) return null;
  const map = fallbackByTab.get(tabId);
  if (!map) return null;
  return map.get(ref) || null;
}

/**
 * safeExec (task 2.5): run chrome.scripting.executeScript against a tab,
 * turning "can't access chrome:// / webstore / devtools pages" into a clear
 * error instead of a silent timeout. `opts.world: 'MAIN'` runs the function in
 * the page's own JS context — required when the page must OBSERVE the effect
 * (e.g. handleDialog's window.alert overrides: in the default ISOLATED world
 * the page keeps its native alert() and real dialogs still block).
 */
export async function safeExec(tabId, func, args = [], opts = {}) {
  const tab = await resolveTab(tabId);
  if (/^(chrome|chrome-extension|devtools|edge|about):/i.test(tab.url || '')) {
    throw new Error(`Cannot access protected page (${tab.url}). Tab ${tabId} is a browser-internal page.`);
  }
  const sanitized = args.map((a) => (a === undefined ? null : a));
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func,
      args: sanitized,
      ...(opts.world ? { world: opts.world } : {}),
    });
    return results[0]?.result;
  } catch (err) {
    const msg = err?.message || String(err);
    if (/cannot access|Cannot access|not allowed|No tab with id/i.test(msg)) {
      throw new Error(`Cannot execute on tab ${tabId}: ${msg}`);
    }
    throw err;
  }
}

/**
 * Run a page function that uses the shared DOM runtime (globalThis.__bcDom,
 * lib/page-dom.js). Page functions start with
 *   `if (!globalThis.__bcDom) return { __needDom: true };`
 * so the steady state costs one executeScript; the runtime is installed and
 * the call repeated only when the document doesn't have it yet.
 */
export async function execDom(tabId, func, args = [], opts = {}) {
  const res = await safeExec(tabId, func, args, opts);
  if (!res || res.__needDom !== true) return res;
  await safeExec(tabId, PAGE_DOM_INSTALL, [PAGE_DOM_VERSION], opts);
  return safeExec(tabId, func, args, opts);
}
