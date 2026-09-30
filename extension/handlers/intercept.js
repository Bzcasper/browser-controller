/**
 * Intercept handler: rule CRUD + capture ledger + HAR export.
 * Enforcement via declarativeNetRequest is best-effort — when DNR is absent
 * (tests, denied permission) every response reports enforcement:'capture-only'
 * and matches are ledger-marked instead of applied (arch ADR-1/ADR-2).
 */
import { resolveTab } from "../lib/page-exec.js";
import { getTabBuffer, networkByTab, PER_TAB_CAP } from "../lib/state.js";
import { validateRuleSet, evaluateRules, scopeKey } from "../lib/intercept.js";

/** scopeKey -> rules[] */
export const rulesByScope = new Map();
/** tabId -> enriched capture entries (capped) */
export const interceptLedgerByTab = new Map();

// Privacy note: captures store method/url/status/type/timestamp (+ intercept
// metadata) only — headers and bodies are never captured, so HAR export is
// redacted by omission (response._redacted: true marks this guarantee).

function allRules() {
  const out = [];
  for (const rules of rulesByScope.values()) out.push(...rules);
  return out;
}

function rulesForTab(tabId) {
  const out = [];
  for (const [scope, rules] of rulesByScope) {
    if (scope === "global") {
      out.push(...rules);
      continue;
    }
    const ids = scope
      .replace(/^tabs:/, "")
      .split(",")
      .map(Number);
    if (tabId != null && ids.includes(tabId)) out.push(...rules);
  }
  return out;
}

function dnrAvailable() {
  try {
    return !!globalThis.chrome?.declarativeNetRequest?.updateDynamicRules;
  } catch {
    return false;
  }
}

/** Best-effort DNR dynamic-rule sync; never throws (degrades to capture-only). */
async function syncDnr() {
  if (!dnrAvailable())
    return { ok: false, enforcement: "capture-only", reason: "no-dnr" };
  try {
    const rules = allRules().filter(
      (r) =>
        r.enabled !== false &&
        (r.action === "block" || r.action === "redirect"),
    );
    const dynamic = rules.slice(0, 50).map((r, i) => ({
      id: 1000 + i,
      priority: 1,
      action:
        r.action === "block"
          ? { type: "block" }
          : { type: "redirect", redirect: { url: r.redirectUrl } },
      condition: { regexFilter: r.match, resourceTypes: undefined },
    }));
    await globalThis.chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: dynamic.map((d) => d.id),
      addRules: dynamic,
    });
    return { ok: true, enforcement: "full" };
  } catch (err) {
    return {
      ok: false,
      enforcement: "capture-only",
      reason: err?.message || String(err),
    };
  }
}

/** Enrich one network capture with rule matches (called from events.js; never throws). */
export function enrichCapture(tabId, entry) {
  try {
    const matches = evaluateRules(rulesForTab(tabId), {
      url: entry.url,
      type: entry.type,
      tabId,
    });
    if (matches.length === 0) return entry;
    const full = dnrAvailable();
    entry.intercept = {
      matchedRuleIds: matches.map((m, i) => m.id ?? `r${i + 1}`),
      applied: matches.map((m, i) => ({
        ruleId: m.id ?? `r${i + 1}`,
        outcome:
          full &&
          (m.action === "block" ||
            m.action === "redirect" ||
            m.action === "header")
            ? "enforced"
            : "ledger-only",
      })),
    };
    const ledger = getTabBuffer(interceptLedgerByTab, tabId);
    ledger.push({ ...entry, timestamp: entry.timestamp ?? Date.now() });
    if (ledger.length > PER_TAB_CAP)
      ledger.splice(0, ledger.length - PER_TAB_CAP);
    return entry;
  } catch {
    return entry;
  }
}

function captureKey(e) {
  return `${e.method || "GET"}|${e.url}|${e.status ?? 0}|${e.timestamp ?? 0}`;
}

/**
 * All captures for a tab, deduplicated. enrichCapture mutates the network
 * buffer entry in place AND ledgers a copy, so a naive concat would return
 * every matched request twice. The network buffer is the base; the ledger
 * only contributes entries not already present (e.g. injected in tests or by
 * future capture sources).
 */
export function collectCaptures(tabId) {
  const buffered = getTabBuffer(networkByTab, tabId);
  const seen = new Set(buffered.map(captureKey));
  const extra = (interceptLedgerByTab.get(tabId) ?? []).filter(
    (e) => !seen.has(captureKey(e)),
  );
  return [...buffered, ...extra];
}

function filterByPattern(entries, filter) {
  if (!filter) return entries;
  let re;
  try {
    re = new RegExp(filter);
  } catch (err) {
    throw new Error(`Invalid filter regex: ${err?.message || err}`);
  }
  return entries.filter((e) => re.test(e.url));
}

function buildHar(tabId, entries) {
  const harEntries = entries.map((e) => ({
    startedDateTime: new Date(e.timestamp ?? Date.now()).toISOString(),
    request: { method: e.method || "GET", url: e.url, headers: [] },
    response: { status: e.status ?? 0, headers: [], _redacted: true },
    timings: { wait: 0 },
    _intercept: e.intercept ?? null,
  }));
  return {
    log: {
      version: "1.2",
      creator: { name: "browser-controller", version: "2.2.0" },
      pages: [{ id: `tab-${tabId}`, title: `Tab ${tabId}` }],
      entries: harEntries,
    },
  };
}

export async function handleIntercept(params) {
  const { action, tabId, rules, filter, limit } = params;
  switch (action) {
    case "set-rules": {
      validateRuleSet(rules ?? []);
      const withIds = (rules ?? []).map((r, i) => ({
        enabled: true,
        ...r,
        id: r.id ?? `r${i + 1}`,
      }));
      const scope = scopeKey(
        withIds.flatMap((r) => r.tabIds ?? (tabId != null ? [tabId] : [])),
      );
      rulesByScope.set(scope, withIds);
      const sync = await syncDnr();
      return {
        success: true,
        enforcement: sync.enforcement,
        reason: sync.reason,
        scope,
        ruleCount: withIds.length,
      };
    }
    case "list-rules": {
      const out = tabId != null ? rulesForTab(tabId) : allRules();
      return {
        success: true,
        enforcement: dnrAvailable() ? "full" : "capture-only",
        rules: out,
      };
    }
    case "clear-rules": {
      if (tabId != null) {
        let cleared = 0;
        for (const [scope, scopeRules] of [...rulesByScope]) {
          if (scope === "global") continue;
          const ids = scope
            .replace(/^tabs:/, "")
            .split(",")
            .map(Number);
          if (ids.includes(tabId)) {
            cleared += scopeRules.length;
            rulesByScope.delete(scope);
          }
        }
        // Global rules stay (they are not tab-scoped); report honestly.
        await syncDnr();
        return {
          success: true,
          cleared,
          note: "global rules retained; omit tabId to clear all",
        };
      }
      const cleared = allRules().length;
      rulesByScope.clear();
      await syncDnr();
      return { success: true, cleared };
    }
    case "list-captures": {
      if (tabId == null) throw new Error("tabId required for list-captures");
      await resolveTab(tabId);
      let entries = collectCaptures(tabId);
      entries = filterByPattern(entries, filter);
      if (limit && Number.isInteger(limit) && limit > 0)
        entries = entries.slice(-limit);
      return {
        success: true,
        enforcement: dnrAvailable() ? "full" : "capture-only",
        captures: entries,
      };
    }
    case "export-har": {
      if (tabId == null) throw new Error("tabId required for export-har");
      await resolveTab(tabId);
      const entries = collectCaptures(tabId);
      const har = buildHar(tabId, entries);
      return { success: true, entries: har.log.entries.length, har };
    }
    default:
      throw new Error(`Unknown intercept action: ${action}`);
  }
}
