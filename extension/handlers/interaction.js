/**
 * Interaction handlers (extracted from background.js): click, type, press_key,
 * hover, select, click_text, dialog, drag, fill_form — the write side that
 * drives the page's event system (synthetic events) or CDP when required.
 */
import { resolveTab, requireTarget, safeExec, getFallback } from '../lib/page-exec.js';
import { autoReSnapshot } from './inspection.js';
import { PAGE_FALLBACK_INSTALL } from '../utils/smart-selector.js';
import { trustedSender, locateTarget, releaseShield, cdpClickAt, cdpKeyPress, cdpTypeText, keyDefinition } from '../lib/trusted-input.js';

export { handleDialog, handleDrag, handleFillForm } from './interaction-advanced.js';

/** Shared REF_GONE recovery: re-snapshot and hand fresh refs back (no auto-retry). */
async function refGone(tabId, res, ref, selector) {
  // A selector that matches nothing is usually the wrong page (navigation,
  // postback), not a virtualized feed — say which locator failed.
  if (!(res._ref || ref) && selector) {
    return { success: false, error: `No element matches selector ${selector} on the current page (${res.url || 'navigated?'}).` };
  }
  const fresh = await autoReSnapshot(tabId);
  return {
    success: false,
    error: `Element ${res._ref || ref} is gone from the DOM (feed scrolled/virtualized). Fresh refs captured — retry with a new ref.`,
    freshRefs: fresh,
  };
}

const BUTTONS = new Set(['left', 'right', 'middle']);

export async function handleClick(params) {
  const { tabId, ref, selector, button = 'left', doubleClick = false, trusted } = params;
  await resolveTab(tabId);
  requireTarget(params);
  const fb = getFallback(tabId, ref);
  // Install the fallback page runtime only when a descriptor exists (v2
  // install-once pattern — eval rebuilding is impossible under MV3 CSP).
  if (fb) await safeExec(tabId, PAGE_FALLBACK_INSTALL, []);

  // Trusted path: a real mouse click at the element's centre over CDP, so
  // focus moves, default actions run and the page sees isTrusted:true.
  const send = await trustedSender(tabId, trusted);
  if (send && BUTTONS.has(button)) {
    const loc = await locateTarget(tabId, { ref, selector, fb });
    if (loc && loc.success === false && loc.error === 'REF_GONE') return refGone(tabId, loc, ref, selector);
    if (loc?.success && loc.visible) {
      try {
        await cdpClickAt(send, loc.x, loc.y, { button, clickCount: doubleClick ? 2 : 1 });
      } finally {
        await releaseShield(tabId);
      }
      return {
        success: true,
        input: 'cdp',
        ...(loc.via ? { via: loc.via } : {}),
        ...(loc.occludedBy ? { warning: `click point is covered by ${loc.occludedBy}` } : {}),
      };
    }
    await releaseShield(tabId);
    // Zero-size element: no point to hit — fall through to the synthetic path.
  }

  const res = await safeExec(tabId, async (_ref, _sel, _btn, _dbl, _fb) => {
    // Same-origin iframe piercing (field report: legacy UIs live inside
    // #mainFrame — top-document lookups missed every element).
    function deepQuery(sel) {
      const q = (doc, depth) => {
        try { const el = doc.querySelector(sel); if (el) return el; } catch {}
        if (depth >= 3) return null;
        for (const f of doc.querySelectorAll('iframe')) {
          try { const d = f.contentDocument; if (d) { const el = q(d, depth + 1); if (el) return el; } } catch {}
        }
        return null;
      };
      return q(document, 0);
    }

    let el = _ref ? deepQuery(`[data-mcp-ref="${_ref}"]`) : null;
    let via = 'ref';
    if (!el && _sel) { el = deepQuery(_sel); via = 'selector'; }
    // Resolver comes from the pre-installed page runtime (no eval).
    const resolveFallback = (globalThis.__browserControllerFallbackRuntime || {}).resolveFallback || null;
    // Smart-selector fallback (plan task 3): ref broke → try robust selector,
    // then text+role+tag scan. The agent doesn't request this; it's automatic.
    if (!el && _fb && resolveFallback) { el = resolveFallback(_fb); if (el) via = 'fallback'; }
    if (!el) {
      // Element is gone (likely virtualized away on scroll). Abort WITHOUT
      // clicking — the background auto-re-snapshots and embeds fresh refs.
      return { success: false, error: 'REF_GONE', _ref };
    }

    el.scrollIntoView({ behavior: 'instant', block: 'center' });

    // Fix #2 (visibility retry): after scrollIntoView, the element may still be
    // off-screen or zero-size if layout hasn't reflowed yet. Give it one short
    // settle (200ms) and re-read the element once. This kills the common "element
    // present but click landed nowhere" failure on lazy-rendered lists. Bounded
    // to a single retry so a truly-hidden element still surfaces honestly.
    const rect0 = el.getBoundingClientRect();
    const visible0 = rect0.width > 0 && rect0.height > 0;
    if (!visible0) {
      await new Promise((r) => setTimeout(r, 200));
      // re-resolve the element (it may have been re-rendered with a new node)
      el = _ref ? deepQuery(`[data-mcp-ref="${_ref}"]`) : el;
      if (el) el.scrollIntoView({ behavior: 'instant', block: 'center' });
    }
    if (!el) return { success: false, error: 'REF_GONE', _ref };

    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const btnVal = _btn === 'left' ? 0 : _btn === 'right' ? 2 : 1;
    const init = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: btnVal };

    el.dispatchEvent(new MouseEvent('mouseover', init));
    el.dispatchEvent(new MouseEvent('mousedown', init));
    if (el.focus) el.focus();
    el.dispatchEvent(new MouseEvent('mouseup', init));
    el.dispatchEvent(new MouseEvent('click', init));

    // A real right-click opens the context menu via a contextmenu event —
    // mousedown/mouseup/click alone never trigger it.
    if (_btn === 'right') {
      el.dispatchEvent(new MouseEvent('contextmenu', init));
    }

    if (_dbl) {
      el.dispatchEvent(new MouseEvent('mousedown', init));
      el.dispatchEvent(new MouseEvent('mouseup', init));
      el.dispatchEvent(new MouseEvent('click', init));
      el.dispatchEvent(new MouseEvent('dblclick', init));
    }

    return { success: true, ...(via !== 'ref' ? { via } : {}) };
  }, [ref, selector, button, doubleClick, fb]);

  // The page function returns REF_GONE when the element (and all fallbacks)
  // can't be found — typical of virtualized feeds (FB/IG) after scrolling.
  // Auto-re-snapshot and embed fresh refs so the agent retries in ONE step.
  // We do NOT auto-retry the click: it's non-idempotent and the element that
  // re-appears may be a different post after the scroll shifted the feed.
  if (res && res.success === false && res.error === 'REF_GONE') return refGone(tabId, res, ref, selector);
  return res;
}

export async function handleType(params) {
  const { tabId, ref, selector, text, clear = false, trusted } = params;
  await resolveTab(tabId);
  requireTarget(params);
  const fb = getFallback(tabId, ref);
  // Install the fallback page runtime only when a descriptor exists (v2
  // install-once pattern — eval rebuilding is impossible under MV3 CSP).
  if (fb) await safeExec(tabId, PAGE_FALLBACK_INSTALL, []);

  // Trusted path: focus the field, then real key presses over CDP (keydown /
  // keypress / input / keyup per character). Like a user, this does NOT fire
  // `change` until focus leaves the field — press Tab to commit.
  const send = await trustedSender(tabId, trusted);
  if (send) {
    const loc = await locateTarget(tabId, { ref, selector, fb, mode: clear ? 'clear' : 'focus' });
    if (loc && loc.success === false && loc.error === 'REF_GONE') return refGone(tabId, loc, ref, selector);
    if (loc?.success && (loc.focused || loc.visible)) {
      let after;
      try {
        // Not focusable by script (custom widget): click it like a user would.
        if (!loc.focused) await cdpClickAt(send, loc.x, loc.y);
        if (clear && loc.needsSelectAll) await cdpKeyPress(send, 'a', ['ctrl']);
        if (clear && loc.hasText && !text) await cdpKeyPress(send, 'Backspace');
        await cdpTypeText(send, text);
      } finally {
        after = await releaseShield(tabId);
      }
      return {
        success: true,
        typed: text,
        input: 'cdp',
        ...(after?.value != null ? { value: after.value } : {}),
        ...(loc.via ? { via: loc.via } : {}),
      };
    }
    await releaseShield(tabId);
  }

  const res = await safeExec(tabId, (_ref, _sel, _text, _clear, _fb) => {
    // Same-origin iframe piercing (field report: legacy UIs live inside
    // #mainFrame — top-document lookups missed every element).
    function deepQuery(sel) {
      const q = (doc, depth) => {
        try { const el = doc.querySelector(sel); if (el) return el; } catch {}
        if (depth >= 3) return null;
        for (const f of doc.querySelectorAll('iframe')) {
          try { const d = f.contentDocument; if (d) { const el = q(d, depth + 1); if (el) return el; } } catch {}
        }
        return null;
      };
      return q(document, 0);
    }

    let el = _ref ? deepQuery(`[data-mcp-ref="${_ref}"]`) : null;
    let via = 'ref';
    if (!el && _sel) { el = deepQuery(_sel); via = 'selector'; }
    const resolveFallback = (globalThis.__browserControllerFallbackRuntime || {}).resolveFallback || null;
    if (!el && _fb && resolveFallback) { el = resolveFallback(_fb); if (el) via = 'fallback'; }
    if (!el) {
      // Element gone (virtualized feed) — abort WITHOUT typing; background
      // auto-re-snapshots and embeds fresh refs for a one-step retry.
      return { success: false, error: 'REF_GONE', _ref };
    }

    el.focus();

    const setNativeValue = (target, nextValue) => {
      const prototype = target instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(target, nextValue);
      else target.value = nextValue;
    };

    if (_clear) {
      if (el.isContentEditable) el.textContent = '';
      else setNativeValue(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }

    if (el.isContentEditable) {
      document.execCommand('insertText', false, _text);
    } else {
      for (const ch of _text) {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
        setNativeValue(el, `${el.value}${ch}`);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
      }
    }

    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { success: true, typed: _text, ...(via !== 'ref' ? { via } : {}) };
  }, [ref, selector, text, clear, fb]);

  // Virtualization recovery (same as click): type target is gone, so
  // auto-re-snapshot and embed fresh refs. No auto-retry (non-idempotent).
  if (res && res.success === false && res.error === 'REF_GONE') return refGone(tabId, res, ref, selector);
  return res;
}

/** "ctrl+a" / "Control+Shift+Tab" -> { key: 'a', mods: ['ctrl'] }; plain keys pass through. */
export function parseKeyCombo(key, modifiers = []) {
  const mods = [...modifiers];
  if (typeof key !== 'string' || key.length < 3 || !key.includes('+')) return { key, mods };
  const parts = key.split('+');
  const last = parts.pop() || '+';
  const alias = { control: 'ctrl', ctrl: 'ctrl', alt: 'alt', option: 'alt', shift: 'shift', meta: 'meta', cmd: 'meta', command: 'meta', win: 'meta' };
  for (const part of parts) {
    const m = alias[part.trim().toLowerCase()];
    if (!m) return { key, mods: [...modifiers] };
    if (!mods.includes(m)) mods.push(m);
  }
  return { key: last, mods };
}

export async function handlePressKey(params) {
  const { tabId, ref, selector, trusted } = params;
  const { key, mods: modifiers } = parseKeyCombo(params.key, params.modifiers || []);
  await resolveTab(tabId);

  // Trusted path: a real key press, so default actions run (Tab moves focus
  // and fires blur/focusout, Enter submits, arrows drive autocomplete menus).
  let knownKey = true;
  try { keyDefinition(key); } catch { knownKey = false; }
  const send = knownKey ? await trustedSender(tabId, trusted) : null;
  if (send) {
    const loc = await locateTarget(tabId, { ref, selector, mode: ref || selector ? 'focus' : 'active' });
    if (!loc || loc.success === false) {
      await releaseShield(tabId);
      if (ref || selector) return { success: false, error: `Element ${ref ? `with ref ${ref}` : `with selector ${selector}`} not found` };
    }
    let after;
    try {
      await cdpKeyPress(send, key, modifiers);
    } finally {
      after = await releaseShield(tabId);
    }
    return { success: true, key, ...(modifiers.length ? { modifiers } : {}), input: 'cdp', ...(after?.focusedTag ? { focused: after.focusedTag } : {}) };
  }

  return safeExec(tabId, (_key, _mods, _ref, _sel) => {
    // Same-origin iframe piercing (field report: legacy UIs live inside
    // #mainFrame — top-document lookups missed every element).
    function deepQuery(sel) {
      const q = (doc, depth) => {
        try { const el = doc.querySelector(sel); if (el) return el; } catch {}
        if (depth >= 3) return null;
        for (const f of doc.querySelectorAll('iframe')) {
          try { const d = f.contentDocument; if (d) { const el = q(d, depth + 1); if (el) return el; } } catch {}
        }
        return null;
      };
      return q(document, 0);
    }

    let target = document.activeElement || document.body;
    // When the caller names a target, an unresolved ref/selector must FAIL —
    // silently falling back to activeElement sent Enter to the wrong control
    // with a success result. (Omitting both is still legitimate: intentional
    // activeElement targeting.)
    if (_ref) {
      const el = deepQuery(`[data-mcp-ref="${_ref}"]`);
      if (!el) return { success: false, error: `Element with ref ${_ref} not found` };
      el.focus();
      target = el;
    } else if (_sel) {
      const el = deepQuery(_sel);
      if (!el) return { success: false, error: `Element with selector ${_sel} not found` };
      el.focus();
      target = el;
    }

    const init = {
      key: _key,
      code: _key.length === 1 ? `Key${_key.toUpperCase()}` : _key,
      bubbles: true,
      cancelable: true,
      ctrlKey: _mods.includes('ctrl'),
      altKey: _mods.includes('alt'),
      shiftKey: _mods.includes('shift'),
      metaKey: _mods.includes('meta'),
    };

    target.dispatchEvent(new KeyboardEvent('keydown', init));
    target.dispatchEvent(new KeyboardEvent('keypress', init));
    target.dispatchEvent(new KeyboardEvent('keyup', init));

    return { success: true, key: _key };
  }, [key, modifiers, ref, selector]);
}

export async function handleHover(params) {
  const { tabId, ref, selector, trusted } = params;
  await resolveTab(tabId);
  requireTarget(params);

  const send = await trustedSender(tabId, trusted);
  if (send) {
    const loc = await locateTarget(tabId, { ref, selector });
    if (loc?.success && loc.visible) {
      try {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: loc.x, y: loc.y });
      } finally {
        await releaseShield(tabId);
      }
      return { success: true, input: 'cdp' };
    }
    await releaseShield(tabId);
    if (loc && loc.success === false) return { success: false, error: 'Element not found' };
  }

  return safeExec(tabId, (_ref, _sel) => {
    // Same-origin iframe piercing (field report: legacy UIs live inside
    // #mainFrame — top-document lookups missed every element).
    function deepQuery(sel) {
      const q = (doc, depth) => {
        try { const el = doc.querySelector(sel); if (el) return el; } catch {}
        if (depth >= 3) return null;
        for (const f of doc.querySelectorAll('iframe')) {
          try { const d = f.contentDocument; if (d) { const el = q(d, depth + 1); if (el) return el; } } catch {}
        }
        return null;
      };
      return q(document, 0);
    }

    let el = _ref ? deepQuery(`[data-mcp-ref="${_ref}"]`) : null;
    if (!el && _sel) el = deepQuery(_sel);
    if (!el) return { success: false, error: 'Element not found' };

    el.scrollIntoView({ behavior: 'instant', block: 'center' });
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const init = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };

    el.dispatchEvent(new MouseEvent('mouseenter', { ...init, bubbles: false }));
    el.dispatchEvent(new MouseEvent('mouseover', init));
    el.dispatchEvent(new MouseEvent('mousemove', init));

    return { success: true };
  }, [ref, selector]);
}

export async function handleSelect(params) {
  const { tabId, ref, selector, value, label, index } = params;
  await resolveTab(tabId);
  requireTarget(params);
  if (value === undefined && label === undefined && index === undefined) {
    throw new Error('One of value, label, or index is required to pick an option.');
  }

  return safeExec(tabId, (_ref, _sel, _val, _lbl, _idx) => {
    // Same-origin iframe piercing (field report: legacy UIs live inside
    // #mainFrame — top-document lookups missed every element).
    function deepQuery(sel) {
      const q = (doc, depth) => {
        try { const el = doc.querySelector(sel); if (el) return el; } catch {}
        if (depth >= 3) return null;
        for (const f of doc.querySelectorAll('iframe')) {
          try { const d = f.contentDocument; if (d) { const el = q(d, depth + 1); if (el) return el; } } catch {}
        }
        return null;
      };
      return q(document, 0);
    }

    let el = _ref ? deepQuery(`[data-mcp-ref="${_ref}"]`) : null;
    if (!el && _sel) el = deepQuery(_sel);
    if (!el) return { success: false, error: 'Element not found' };
    if (el.tagName !== 'SELECT') return { success: false, error: 'Not a select element' };

    if (_val !== null) el.value = _val;
    else if (_lbl !== null) {
      const opt = Array.from(el.options).find((o) => o.textContent.trim() === _lbl);
      if (opt) el.value = opt.value;
      else return { success: false, error: `Option "${_lbl}" not found` };
    } else if (_idx !== null) {
      if (_idx >= 0 && _idx < el.options.length) el.selectedIndex = _idx;
      else return { success: false, error: `Index ${_idx} out of range` };
    }

    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return { success: true, selected: el.value };
  }, [ref, selector, value, label, index]);
}

export async function handleClickByText(params) {
  const { tabId, text, index = 0, exact = false } = params;
  await resolveTab(tabId);

  return safeExec(tabId, (_text, _index, _exact) => {
    const textLower = _text.toLowerCase();
    const candidates = [];
    // Same-origin iframe piercing — walk every frame body, not just the top.
    const roots = [document.body];
    (function collectFrames(doc, depth) {
      if (depth >= 3) return;
      for (const f of doc.querySelectorAll('iframe')) {
        try { const d = f.contentDocument; if (d && d.body) { roots.push(d.body); collectFrames(d, depth + 1); } } catch {}
      }
    })(document, 0);
    let node;
    for (const root of roots) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    while ((node = walker.nextNode())) {
      const s = getComputedStyle(node);
      if (s.display === 'none' || s.visibility === 'hidden') continue;
      const r = node.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;

      const nodeText = (node.innerText || node.textContent || '').trim();
      const firstLine = nodeText.split('\n')[0].trim();
      const match = _exact
        ? firstLine === _text
        : firstLine.toLowerCase().includes(textLower);

      if (match) {
        candidates.push({ el: node, text: firstLine, depth: getDepth(node) });
      }
    }
    }

    function getDepth(el) { let d = 0; let p = el; while ((p = p.parentElement)) d++; return d; }

    candidates.sort((a, b) => b.depth - a.depth);

    if (candidates.length === 0) return { success: false, error: `No element found with text "${_text}"` };
    // Guard the full range: a negative index used to read candidates[-1] and
    // crash with a raw TypeError (schema bounds only protect MCP callers).
    if (!Number.isInteger(_index) || _index < 0 || _index >= candidates.length) {
      return { success: false, error: `Only ${candidates.length} matches, index ${_index} out of range` };
    }

    const target = candidates[_index].el;
    target.scrollIntoView({ behavior: 'instant', block: 'center' });
    const rect = target.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const init = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };

    target.dispatchEvent(new MouseEvent('mouseover', init));
    target.dispatchEvent(new MouseEvent('mousedown', init));
    if (target.focus) target.focus();
    target.dispatchEvent(new MouseEvent('mouseup', init));
    target.dispatchEvent(new MouseEvent('click', init));

    return { success: true, clicked: candidates[_index].text, matchCount: candidates.length };
  }, [text, index, exact]);
}
