/**
 * Trusted input over CDP (Input.dispatchMouseEvent / Input.dispatchKeyEvent).
 *
 * Synthetic DOM events (el.dispatchEvent) are isTrusted:false, never move real
 * focus, never run default actions (Tab focus traversal, Enter form submit,
 * autocomplete menus) and never fire focus/blur while the window is in the
 * background. Legacy grids and lookup widgets depend on all of that, so the
 * write tools now drive the page the way a user does, like Claude in Chrome.
 * The synthetic path stays as the fallback when CDP can't attach.
 */
import { ensureCdp, ensureViewport, hasCdp } from './cdp-session.js';
import { safeExec } from './page-exec.js';

const MOD_BITS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

export function modifierBits(mods = []) {
  return mods.reduce((bits, m) => bits | (MOD_BITS[m] || 0), 0);
}

const NAMED_KEYS = {
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  Tab: { code: 'Tab', vk: 9 },
  Escape: { code: 'Escape', vk: 27 },
  Backspace: { code: 'Backspace', vk: 8 },
  Delete: { code: 'Delete', vk: 46 },
  Insert: { code: 'Insert', vk: 45 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
  Home: { code: 'Home', vk: 36 },
  End: { code: 'End', vk: 35 },
  PageUp: { code: 'PageUp', vk: 33 },
  PageDown: { code: 'PageDown', vk: 34 },
  ' ': { code: 'Space', vk: 32, text: ' ' },
  Space: { code: 'Space', vk: 32, text: ' ', key: ' ' },
  Shift: { code: 'ShiftLeft', vk: 16 },
  Control: { code: 'ControlLeft', vk: 17 },
  Alt: { code: 'AltLeft', vk: 18 },
  Meta: { code: 'MetaLeft', vk: 91 },
};
for (let i = 1; i <= 12; i++) NAMED_KEYS[`F${i}`] = { code: `F${i}`, vk: 111 + i };
const KEY_ALIASES = { Esc: 'Escape', Return: 'Enter', Del: 'Delete', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight' };

/** CDP key definition for a key name ("Enter", "a", "7", "ب"). */
export function keyDefinition(rawKey) {
  const name = KEY_ALIASES[rawKey] || rawKey;
  const named = NAMED_KEYS[name];
  if (named) return { key: named.key || name, code: named.code, vk: named.vk, text: named.text };
  if ([...name].length !== 1) throw new Error(`Unknown key "${rawKey}"`);
  const ch = name;
  const upper = ch.toUpperCase();
  if (/^[a-z]$/i.test(ch)) return { key: ch, code: `Key${upper}`, vk: upper.charCodeAt(0), text: ch };
  if (/^[0-9]$/.test(ch)) return { key: ch, code: `Digit${ch}`, vk: ch.charCodeAt(0), text: ch };
  return { key: ch, code: '', vk: 0, text: ch };
}

/** One full key press (keyDown[+char] / keyUp). With ctrl/alt/meta no text is produced. */
export async function cdpKeyPress(send, rawKey, mods = []) {
  const def = keyDefinition(rawKey);
  const modifiers = modifierBits(mods);
  const printable = def.text && !(modifiers & (MOD_BITS.ctrl | MOD_BITS.alt | MOD_BITS.meta));
  const base = { key: def.key, code: def.code, windowsVirtualKeyCode: def.vk, nativeVirtualKeyCode: def.vk, modifiers };
  await send('Input.dispatchKeyEvent', {
    type: printable ? 'keyDown' : 'rawKeyDown',
    ...base,
    ...(printable ? { text: def.text, unmodifiedText: def.text } : {}),
  });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

/** Up to this length text is typed key by key (keydown/keypress/input/keyup per char). */
export const PER_KEY_MAX = 300;

export async function cdpTypeText(send, text) {
  if ([...text].length > PER_KEY_MAX) {
    await send('Input.insertText', { text });
    return;
  }
  for (const ch of text) {
    if (ch === '\n') { await cdpKeyPress(send, 'Enter'); continue; }
    if (ch === '\t') { await cdpKeyPress(send, 'Tab'); continue; }
    await cdpKeyPress(send, ch);
  }
}

export async function cdpClickAt(send, x, y, { button = 'left', clickCount = 1, modifiers = 0 } = {}) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers });
  for (let n = 1; n <= clickCount; n++) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: n, modifiers });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: n, modifiers });
  }
}

/**
 * Page-side: resolve the target (ref → selector → smart fallback, piercing
 * same-origin iframes), scroll it into view, optionally focus/select it, and
 * return its centre in TOP-level viewport coordinates (what CDP expects).
 * Also opens the lock shield for the agent's own trusted input for a few
 * seconds, since trusted events are otherwise blocked by it.
 * Kept self-contained: it is serialized into the page by chrome.scripting.
 */
function pageLocate(ref, sel, fb, mode) {
  function deepQuery(s) {
    const q = (doc, depth) => {
      try { const el = doc.querySelector(s); if (el) return el; } catch {}
      if (depth >= 3) return null;
      for (const f of doc.querySelectorAll('iframe')) {
        try { const d = f.contentDocument; if (d) { const el = q(d, depth + 1); if (el) return el; } } catch {}
      }
      return null;
    };
    return q(document, 0);
  }
  let el = ref ? deepQuery(`[data-mcp-ref="${ref}"]`) : null;
  let via = 'ref';
  if (!el && sel) { el = deepQuery(sel); via = 'selector'; }
  const resolveFallback = (globalThis.__browserControllerFallbackRuntime || {}).resolveFallback || null;
  if (!el && fb && resolveFallback) { el = resolveFallback(fb); if (el) via = 'fallback'; }
  if (!el && mode === 'active') { el = document.activeElement; via = 'active'; }
  if (!el) return { success: false, error: 'REF_GONE', _ref: ref };

  // Agent input pass-through for the lock shield (see overlay.js).
  window.__bcAgentInputUntil = Date.now() + 8000;
  const shield = document.getElementById('__bc-lock-shield');
  if (shield) shield.style.pointerEvents = 'none';

  if (mode !== 'active') el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
  if (mode === 'focus' || mode === 'clear') {
    if (typeof el.focus === 'function') el.focus();
    if (mode === 'clear') {
      if (el.isContentEditable) {
        const r = el.ownerDocument.createRange();
        r.selectNodeContents(el);
        const s = el.ownerDocument.defaultView.getSelection();
        s.removeAllRanges();
        s.addRange(r);
      } else if (typeof el.select === 'function') {
        el.select();
      }
    }
  }

  const rect = el.getBoundingClientRect();
  let x = rect.left + rect.width / 2;
  let y = rect.top + rect.height / 2;
  // Add the offsets of every enclosing same-origin iframe.
  let win = el.ownerDocument.defaultView;
  while (win && win !== window && win.frameElement) {
    const fr = win.frameElement.getBoundingClientRect();
    const cs = win.frameElement.ownerDocument.defaultView.getComputedStyle(win.frameElement);
    x += fr.left + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0);
    y += fr.top + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.paddingTop) || 0);
    win = win.parent;
  }
  const doc = el.ownerDocument;
  const focused = doc.activeElement === el || (el.contains && el.contains(doc.activeElement));
  const hasValue = 'value' in el && !el.isContentEditable && typeof el.value === 'string';
  let fullySelected = false;
  try { fullySelected = el.selectionStart === 0 && el.selectionEnd === el.value.length; } catch { /* number/email inputs */ }
  // What a real click at (x, y) would hit (top document only).
  let occludedBy = null;
  if (win === window || !el.ownerDocument.defaultView.frameElement) {
    const hit = document.elementFromPoint(x, y);
    if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
      occludedBy = hit.tagName.toLowerCase() + (hit.id ? `#${hit.id}` : '')
        + (typeof hit.className === 'string' && hit.className.trim() ? `.${hit.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '');
    }
  }
  return {
    success: true,
    x, y,
    zeroViewport: window.innerWidth === 0 || window.innerHeight === 0,
    visible: rect.width > 0 && rect.height > 0,
    focused,
    // clear: a value that select() could not select still needs Ctrl+A.
    needsSelectAll: hasValue && el.value.length > 0 && !fullySelected,
    hasText: hasValue ? el.value.length > 0 : (el.textContent || '').length > 0,
    ...(occludedBy ? { occludedBy } : {}),
    ...(via !== 'ref' ? { via } : {}),
  };
}

/** Close the shield pass-through; report the focused field's value for verification. */
function pageRelease() {
  window.__bcAgentInputUntil = 0;
  const shield = document.getElementById('__bc-lock-shield');
  if (shield) shield.style.pointerEvents = 'auto';
  let a = document.activeElement;
  while (a && a.tagName === 'IFRAME') {
    try { a = a.contentDocument.activeElement; } catch { break; }
  }
  if (!a || a === document.body) return { value: null };
  const value = typeof a.value === 'string' ? a.value : a.isContentEditable ? a.textContent : null;
  return { value: value == null ? null : value.slice(0, 500), focusedTag: a.tagName.toLowerCase() + (a.id ? `#${a.id}` : '') };
}

export async function locateTarget(tabId, { ref, selector, fb, mode = 'none' }) {
  const loc = await safeExec(tabId, pageLocate, [ref, selector, fb, mode]);
  // Never-shown background tab: size its viewport, then measure again.
  if (loc?.success && loc.zeroViewport && hasCdp(tabId)) {
    await ensureViewport(tabId).catch(() => {});
    return safeExec(tabId, pageLocate, [ref, selector, fb, mode]);
  }
  return loc;
}

/** Let the agent's own trusted input through the lock shield (for raw-coordinate tools like drag). */
export async function openShield(tabId) {
  try {
    await safeExec(tabId, () => {
      window.__bcAgentInputUntil = Date.now() + 8000;
      const shield = document.getElementById('__bc-lock-shield');
      if (shield) shield.style.pointerEvents = 'none';
    }, []);
  } catch { /* protected page: CDP input still works, no shield there */ }
}

export async function releaseShield(tabId) {
  try { return (await safeExec(tabId, pageRelease, [])) || {}; } catch { return {}; /* page navigated away */ }
}

/**
 * Attach the tab's CDP session or return null when CDP is unavailable
 * (another debugger owns the tab, policy blocks chrome.debugger…) so callers
 * fall back to synthetic events. `trusted:false` forces the synthetic path.
 */
export async function trustedSender(tabId, trusted) {
  if (trusted === false) return null;
  try {
    return await ensureCdp(tabId);
  } catch {
    return null;
  }
}
