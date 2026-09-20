/**
 * Advanced interaction handlers that rely on the debugger API or multi-field
 * orchestration. Kept separate from the common pointer/keyboard handlers so
 * each module stays focused and reviewable.
 */
import { resolveTab, safeExec } from '../lib/page-exec.js';

export async function handleDialog(params) {
  const { tabId, action = 'accept', promptText } = params;
  const tab = await resolveTab(tabId);

  // An ALREADY-OPEN native dialog freezes the page's JS thread — overrides
  // can't help in that state. CDP handles it out-of-band, so try it first.
  try {
    await chrome.debugger.attach({ tabId: tab.id }, '1.3');
    try {
      await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.enable', {});
      await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.handleJavaScriptDialog', {
        accept: action === 'accept',
        promptText: promptText || '',
      });
      return { success: true, handled: 'open-dialog', action };
    } finally {
      try { await chrome.debugger.detach({ tabId: tab.id }); } catch {}
    }
  } catch {
    // No dialog showing (or debugger unavailable) — arm future overrides.
  }

  // MAIN world is required: the page must see the overridden dialog methods.
  return safeExec(tabId, (_action, _promptText) => {
    window.__mcpDialogLog = window.__mcpDialogLog || [];
    window.__mcpDialogAction = _action;
    window.__mcpDialogPromptText = _promptText || '';

    if (!window.__mcpDialogOverrides) {
      window.__mcpDialogOverrides = true;
      window.alert = function (msg) {
        window.__mcpDialogLog.push({ type: 'alert', message: String(msg), timestamp: Date.now(), handled: window.__mcpDialogAction });
      };
      window.confirm = function (msg) {
        const accepted = window.__mcpDialogAction === 'accept';
        window.__mcpDialogLog.push({ type: 'confirm', message: String(msg), timestamp: Date.now(), result: accepted });
        return accepted;
      };
      window.prompt = function (msg, def) {
        const accepted = window.__mcpDialogAction === 'accept';
        const text = accepted ? (window.__mcpDialogPromptText || def || '') : null;
        window.__mcpDialogLog.push({ type: 'prompt', message: String(msg), timestamp: Date.now(), result: text });
        return accepted ? text : null;
      };
    }

    const log = [...window.__mcpDialogLog];
    window.__mcpDialogLog = [];
    return { success: true, dialogs: log, message: log.length ? 'Retrieved dialog history' : 'Overrides configured' };
  }, [action, promptText], { world: 'MAIN' });
}

export async function handleDrag(params) {
  const { tabId, startRef, startSelector, endRef, endSelector, startX, startY, endX, endY } = params;
  // Direct WebSocket callers bypass the MCP schema, so clamp invalid steps.
  const steps = Math.max(1, Number.isInteger(params.steps) ? params.steps : 10);
  const tab = await resolveTab(tabId);

  let sx = startX, sy = startY, ex = endX, ey = endY;
  if (sx == null || sy == null || ex == null || ey == null) {
    const coords = await safeExec(tabId, (_sRef, _sSel, _eRef, _eSel) => {
      function deepQuery(sel) {
        const query = (doc, depth) => {
          try { const el = doc.querySelector(sel); if (el) return el; } catch {}
          if (depth >= 3) return null;
          for (const frame of doc.querySelectorAll('iframe')) {
            try {
              const child = frame.contentDocument;
              if (child) { const el = query(child, depth + 1); if (el) return el; }
            } catch {}
          }
          return null;
        };
        return query(document, 0);
      }

      function find(ref, selector) {
        let el = ref ? deepQuery(`[data-mcp-ref="${ref}"]`) : null;
        if (!el && selector) el = deepQuery(selector);
        if (!el) return null;
        el.scrollIntoView({ behavior: 'instant', block: 'center' });
        const rect = el.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }
      return { start: find(_sRef, _sSel), end: find(_eRef, _eSel) };
    }, [startRef, startSelector, endRef, endSelector]);

    if (coords.start) { sx = coords.start.x; sy = coords.start.y; }
    if (coords.end) { ex = coords.end.x; ey = coords.end.y; }
  }

  if (sx == null || sy == null || ex == null || ey == null) {
    throw new Error('Could not determine drag coordinates. Provide refs/selectors or explicit x,y coordinates.');
  }

  await chrome.debugger.attach({ tabId: tab.id }, '1.3');
  try {
    await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x: sx, y: sy, button: 'left', clickCount: 1,
    });
    for (let i = 1; i <= steps; i++) {
      const progress = i / steps;
      await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(sx + (ex - sx) * progress),
        y: Math.round(sy + (ey - sy) * progress),
        button: 'left',
      });
    }
    await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: ex, y: ey, button: 'left', clickCount: 1,
    });
    return { success: true, from: { x: sx, y: sy }, to: { x: ex, y: ey } };
  } finally {
    try { await chrome.debugger.detach({ tabId: tab.id }); } catch {}
  }
}

export async function handleFillForm(params) {
  const { tabId, fields, submit } = params;
  if (!fields || !Array.isArray(fields) || fields.length === 0) {
    throw new Error('fields array is required');
  }
  await resolveTab(tabId);

  return safeExec(tabId, (_fields, _submit) => {
    function deepQuery(sel) {
      const query = (doc, depth) => {
        try { const el = doc.querySelector(sel); if (el) return el; } catch {}
        if (depth >= 3) return null;
        for (const frame of doc.querySelectorAll('iframe')) {
          try {
            const child = frame.contentDocument;
            if (child) { const el = query(child, depth + 1); if (el) return el; }
          } catch {}
        }
        return null;
      };
      return query(document, 0);
    }

    const setNativeValue = (target, nextValue) => {
      const prototype = target instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(target, nextValue);
      else target.value = nextValue;
    };
    const results = [];
    let containingForm = null;
    for (const field of _fields) {
      const { ref, selector, value, clear } = field;
      let el = ref ? deepQuery(`[data-mcp-ref="${ref}"]`) : null;
      if (!el && selector) el = deepQuery(selector);
      if (!el) {
        results.push({ selector: selector || ref, success: false, error: 'Not found' });
        continue;
      }

      el.focus();
      if (el.form && !containingForm) containingForm = el.form;
      if (clear !== false) {
        if (el.isContentEditable) el.textContent = '';
        else setNativeValue(el, '');
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }

      if (el.tagName === 'SELECT') {
        const option = Array.from(el.options).find((candidate) => candidate.value === String(value));
        if (!option) {
          results.push({ selector: selector || ref, success: false, error: `Option "${value}" not found` });
          continue;
        }
        setNativeValue(el, String(value));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (el.type === 'checkbox' || el.type === 'radio') {
        const checked = value === true || value === 'true';
        if (el.checked !== checked) el.click();
      } else if (el.isContentEditable) {
        document.execCommand('insertText', false, value);
      } else {
        setNativeValue(el, String(value));
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }

      el.dispatchEvent(new Event('change', { bubbles: true }));
      results.push({ selector: selector || ref, success: true, value });
    }

    if (_submit) {
      const form = containingForm || document.querySelector('form');
      if (form) {
        const submitButton = form.querySelector('[type="submit"]') || form.querySelector('button:not([type="button"])');
        if (submitButton) submitButton.click();
        else form.submit();
      }
    }

    const failed = results.filter((result) => !result.success).length;
    return failed === 0
      ? { success: true, fields: results }
      : { success: false, error: `${failed} of ${results.length} fields failed`, fields: results };
  }, [fields, submit]);
}
