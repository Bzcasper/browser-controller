/**
 * Tab + debug-capture handlers (extracted from background.js): tabs
 * lifecycle (list/create/close/focus/lock/unlock), console/network reads,
 * screenshot.
 */
import { resolveTab } from "../lib/page-exec.js";
import {
  tabLocks,
  windowCaptureMutex,
  consoleByTab,
  networkByTab,
  getTabBuffer,
  persistSessionState,
} from "../lib/state.js";
import { showLockShield, hideLockShield } from "../lib/overlay.js";
import { broadcastStatus } from "../lib/connection.js";
import { lockTabUi, releaseTabUi } from "../lib/lock-ops.js";
import { withCdp, ensureViewport } from '../lib/cdp-session.js';

const CDP_CAPTURE_TIMEOUT_MS = 4000;

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * CDP capture (Page.captureScreenshot): works on a tab that is NOT the active
 * one in its window, so the user's view is never switched, and can downscale
 * (`scale`) or cap the width (`maxWidth`) to save image tokens.
 */
async function cdpScreenshot(tabId, { format, quality, scale, maxWidth, fullPage }) {
  return withCdp(tabId, async (send) => {
    let metrics = await send('Page.getLayoutMetrics');
    if (!(metrics?.cssVisualViewport?.clientWidth > 0)) {
      await ensureViewport(tabId);
      metrics = await send('Page.getLayoutMetrics');
    }
    const vv = metrics.cssVisualViewport;
    const content = metrics.cssContentSize || metrics.contentSize;
    const width = fullPage ? Math.ceil(content.width) : vv.clientWidth;
    const height = fullPage ? Math.min(Math.ceil(content.height), 16_000) : vv.clientHeight;
    let s = Math.min(1, Math.max(0.05, scale ?? 1));
    if (maxWidth && width * s > maxWidth) s = maxWidth / width;
    const { data } = await withTimeout(send('Page.captureScreenshot', {
      format,
      ...(format === 'jpeg' ? { quality } : {}),
      captureBeyondViewport: !!fullPage,
      clip: { x: fullPage ? 0 : vv.pageX, y: fullPage ? 0 : vv.pageY, width, height, scale: s },
    }), CDP_CAPTURE_TIMEOUT_MS, 'Page.captureScreenshot');
    return { data, width: Math.round(width * s), height: Math.round(height * s) };
  });
}

export async function handleScreenshot(params) {
  const { tabId, format = "png", quality = 80, scale, maxWidth, fullPage = false } = params;
  const tab = await resolveTab(tabId);
  const protectedPage = /^(chrome|chrome-extension|devtools|edge|about):/i.test(tab.url || '');
  let cdpError = null;
  if (!protectedPage) {
    // The shield is shown during EVERY agent action (router), not only while
    // locked — always take it out of the picture; the router restores it.
    const wasLocked = !!tabLocks.owner(tabId);
    await hideLockShield(tabId);
    const opts = { format, quality, scale, maxWidth, fullPage };
    const done = (shot, via) => ({ success: true, format, via, width: shot.width, height: shot.height, data: shot.data });
    try {
      if (tab.active) {
        const shot = await cdpScreenshot(tabId, opts);
        if (shot?.data) return done(shot, 'cdp');
      } else {
        // A background tab produces no compositor frames (Page.captureScreenshot
        // just hangs, fromSurface:false too), so show it for a moment, capture
        // over CDP (keeps scale/maxWidth/fullPage) and switch straight back.
        const fg = await windowCaptureMutex.run(tab.windowId, async () => {
          const [previousActive] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
          await chrome.tabs.update(tabId, { active: true });
          try {
            await new Promise((r) => setTimeout(r, 150));
            return await cdpScreenshot(tabId, opts);
          } finally {
            if (previousActive?.id != null && previousActive.id !== tabId) {
              await chrome.tabs.update(previousActive.id, { active: true }).catch(() => {});
            }
          }
        });
        if (fg?.data) return done(fg, 'cdp-activated');
      }
    } catch (err) {
      // debugger unavailable or the hidden tab would not paint: fall back below
      cdpError = String(err?.message || err).slice(0, 200);
    } finally {
      if (wasLocked) await showLockShield(tabId);
    }
  }
  return windowCaptureMutex.run(tab.windowId, async () => {
    const [previousActive] = await chrome.tabs.query({
      active: true,
      windowId: tab.windowId,
    });
    const changedActiveTab = previousActive?.id !== tabId;
    if (changedActiveTab) {
      await chrome.tabs.update(tabId, { active: true });
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    const wasLocked = !!tabLocks.owner(tabId);
    if (wasLocked) await hideLockShield(tabId);
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format,
        quality: format === "jpeg" ? quality : undefined,
      });
      return { success: true, format, data: dataUrl.split(",")[1], ...(cdpError ? { cdpFallback: cdpError } : {}) };
    } finally {
      if (wasLocked) await showLockShield(tabId);
      if (changedActiveTab && previousActive?.id != null) {
        const [currentActive] = await chrome.tabs.query({
          active: true,
          windowId: tab.windowId,
        });
        if (currentActive?.id === tabId) {
          await chrome.tabs
            .update(previousActive.id, { active: true })
            .catch(() => {});
        }
      }
    }
  });
}

export async function handleConsole(params) {
  const { tabId, clear = false } = params;
  // Validate the tab (audit finding, seen live): a wrong tabId used to return
  // an empty success instead of an actionable error.
  await resolveTab(tabId);
  const buf = getTabBuffer(consoleByTab, tabId);
  const msgs = [...buf];
  if (clear) consoleByTab.set(tabId, []);
  return { success: true, messages: msgs };
}

export async function handleNetwork(params) {
  const { tabId, filter, clear = false, limit } = params;
  await resolveTab(tabId); // same as handleConsole — no empty fake successes
  let reqs = [...getTabBuffer(networkByTab, tabId)];
  if (filter) {
    // An invalid pattern used to throw a raw SyntaxError out of the handler;
    // surface it as an actionable error instead.
    let re;
    try {
      re = new RegExp(filter);
    } catch (err) {
      throw new Error(`Invalid filter regex: ${err?.message || err}`);
    }
    reqs = reqs.filter((r) => re.test(r.url));
  }
  if (limit && Number.isInteger(limit) && limit > 0) {
    reqs = reqs.slice(-limit); // most recent N
  }
  if (clear) networkByTab.set(tabId, []);
  return { success: true, requests: reqs };
}

export async function handleTabs(params, sessionId) {
  const { action, tabId, url } = params;
  switch (action) {
    case "list": {
      // ALL windows, not {currentWindow:true}: "current window" is ill-defined
      // in an MV3 service worker, and tabs in other windows were invisible and
      // unfocusable. windowId disambiguates duplicates across windows.
      const tabs = await chrome.tabs.query({});
      return {
        success: true,
        // Compact: truncate long tracking URLs, omit lockedBy when null (saves
        // tokens — a 20-tab list with full FB/Google URLs was ~3K tokens).
        tabs: tabs.map((t) => {
          const entry = {
            id: t.id,
            windowId: t.windowId,
            title: t.title,
            active: t.active,
          };
          const url = String(t.url || "");
          entry.url = url.length > 80 ? url.slice(0, 77) + "..." : url;
          const owner = tabLocks.owner(t.id);
          if (owner) entry.lockedBy = owner; // omit when null — saves tokens
          return entry;
        }),
      };
    }
    case "create": {
      const t = await chrome.tabs.create({ url: url || "about:blank" });
      return { success: true, tabId: t.id, url: t.url };
    }
    case "close": {
      if (!tabId) throw new Error("tabId required");
      // A locked tab belongs to its owner session — closing it from another
      // session (or from an anonymous no-session caller) would destroy the
      // work the lock exists to protect.
      const closerOwner = tabLocks.owner(tabId);
      if (closerOwner && closerOwner !== sessionId) {
        throw new Error(`Tab ${tabId} is locked by ${closerOwner} — unlock it from that session before closing.`);
      }
      await chrome.tabs.remove(tabId);
      releaseTabUi(tabId); // release + persist + shield removal
      return { success: true, closed: tabId };
    }
    case "focus": {
      if (!tabId) throw new Error("tabId required");
      const focusOwner = tabLocks.owner(tabId);
      if (focusOwner && focusOwner !== sessionId) {
        throw new Error(`Tab ${tabId} is locked by ${focusOwner} — unlock it from that session before focusing.`);
      }
      await chrome.tabs.update(tabId, { active: true });
      return { success: true, focused: tabId };
    }
    case "lock": {
      if (!tabId) throw new Error("tabId required");
      const owner = sessionId;
      if (!owner) throw new Error("lock requires an authenticated session");
      // Validate the tab exists — locking a phantom id would create an entry
      // that onRemoved never cleans (it only fires for real tabs).
      await resolveTab(tabId);
      const shielded = await lockTabUi(
        tabId,
        owner,
        `Tab ${tabId} locked by ${owner}`,
      );
      return { success: true, locked: tabId, owner, shielded };
    }
    case "unlock": {
      if (!tabId) throw new Error("tabId required");
      if (!sessionId)
        throw new Error("unlock requires an authenticated session");
      const was = tabLocks.owner(tabId);
      tabLocks.unlock(tabId, sessionId);
      if (tabLocks.owner(tabId)) {
        throw new Error(`Tab ${tabId} is locked by another session`);
      }
      persistSessionState();
      hideLockShield(tabId);
      broadcastStatus(`Tab ${tabId} unlocked (was ${was || "-"})`);
      return { success: true, unlocked: tabId, previousSession: was || null };
    }
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}
