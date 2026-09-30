/**
 * CDP-backed handlers (extracted from background.js): run_action and
 * upload_file — the two tools that cannot be implemented with
 * chrome.scripting (CSP bypass / DOM.setFileInputFiles).
 */
import { resolveTab, execDom, getFallback } from '../lib/page-exec.js';
import { MAX_RESULT_CHARS } from '../lib/state.js';
import { ensureCdp } from '../lib/cdp-session.js';

export async function handleRunAction(params, _sessionId, _agentName, signal) {
  const { tabId, code, actionParams = {} } = params;
  if (!code) throw new Error('code is required');
  const tab = await resolveTab(tabId);

  // run_action stays on CDP (plan decision: CDP-only, can't be scripted —
  // it bypasses page CSP via the debugger protocol, unlike browser_evaluate).
  const send = await ensureCdp(tab.id);
  {
    const paramsJson = JSON.stringify(actionParams);
    // Dual mode: accept EITHER a {execute:function()} tool wrapper (legacy
    // skill syntax) OR a plain JS expression/statement (simple usage like
    // "document.title" or "var x=...; JSON.stringify(x)"). Previously only
    // the wrapper worked; any plain expression returned "No execute function
    // found", making the tool unusable for simple extraction tasks.
    const expression = `(async function() {
      try {
        var result = await (${code});
        if (result && typeof result.execute === "function") {
          result = await result.execute(${paramsJson});
        }
        if (result && Array.isArray(result.content)) {
          return result;
        }
        var raw = (typeof result === 'object' && result !== null) ? JSON.stringify(result) : String(result);
        return { content: [{ type: 'text', text: raw }] };
      } catch(e) {
        return { error: e.message, stack: e.stack };
      }
    })()`;

    const { result, exceptionDetails } = await send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
    );

    // Cancellation: if the caller (daemon/bridge) aborted while the page was
    // evaluating (e.g. a long IIFE), the result is now useless — drop it so the
    // tab mutex releases immediately and the next caller isn't queued behind a
    // dead request.
    if (signal?.aborted) {
      return { success: false, error: 'aborted' };
    }
    if (exceptionDetails) {
      return { success: false, error: exceptionDetails.exception?.description || exceptionDetails.text };
    }
    // Cap oversized results (same policy as handleEvaluate).
    const raw = JSON.stringify(result.value);
    if (raw && raw.length > MAX_RESULT_CHARS) {
      return {
        success: true,
        result: { content: [{ type: 'text', text: raw.slice(0, MAX_RESULT_CHARS) + '…[truncated]' }] },
        truncated: true,
        fullLength: raw.length,
      };
    }
    return { success: true, result: result.value };
  }
}

/** Main-world expression returning the node marked data-bc-upload=token (pierces open shadow roots / same-origin frames). */
export function findMarkedExpression(token) {
  return `(() => { const s = '[data-bc-upload="${token}"]';
    const q = (root, d) => { const hit = root.querySelector(s); if (hit || d > 6) return hit;
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) { const h = q(el.shadowRoot, d + 1); if (h) return h; }
        if (el.tagName === 'IFRAME') { try { const h = el.contentDocument && q(el.contentDocument, d + 1); if (h) return h; } catch (e) {} }
      }
      return null; };
    return q(document, 0); })()`;
}

export async function handleUploadFile(params) {
  const { tabId, ref, selector, filePath, files: fileList } = params;
  const tab = await resolveTab(tabId);
  const filePaths = fileList || (filePath ? [filePath] : []);
  if (filePaths.length === 0) throw new Error('filePath or files required');

  // Resolve in the page with the shared resolver (ref registry, visible-first
  // selector across shadow roots / same-origin frames, verified fallback), then
  // hand the node to CDP through a one-shot marker attribute.
  const sel = selector || (ref ? null : 'input[type="file"]');
  const what = selector || (ref ? `ref ${ref}` : 'input[type="file"]');
  const token = `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const check = await execDom(tab.id, (_ref, _sel, _fb, _token) => {
    const D = globalThis.__bcDom;
    if (!D) return { __needDom: true };
    const el = D.resolve(_ref, _sel, _fb).el;
    if (!el) return { found: false };
    el.setAttribute('data-bc-upload', _token);
    return {
      found: true,
      isFileInput: el.tagName === 'INPUT' && el.type === 'file',
      multiple: !!el.multiple,
    };
  }, [ref || null, sel, getFallback(tab.id, ref), token]).catch(() => null);
  if (!check || !check.found) throw new Error(`File input not found: ${what}`);
  if (!check.isFileInput) throw new Error(`Element matching ${what} is not an <input type="file">.`);
  if (filePaths.length > 1 && !check.multiple) {
    throw new Error(`File input matching ${what} does not accept multiple files.`);
  }

  // upload_file stays on CDP (DOM.setFileInputFiles is CDP-only).
  let uploaded = false;
  try {
    const send = await ensureCdp(tab.id);
    // Find the marked node wherever it lives (open shadow roots, same-origin frames).
    const { result } = await send('Runtime.evaluate', { expression: findMarkedExpression(token) });
    if (!result || !result.objectId) throw new Error(`File input not found: ${what}`);
    await send('DOM.setFileInputFiles', { files: filePaths, objectId: result.objectId });
    uploaded = true;
  } finally {
    // Fire the events React/Vue file inputs listen for after a successful set,
    // and always remove the one-shot marker (and the Observation V2 handoff marker).
    try {
      await execDom(tab.id, (_token, notify) => {
        const D = globalThis.__bcDom;
        if (!D) return { __needDom: true };
        const el = (D.queryAll(`[data-bc-upload="${_token}"]`, true) || [])[0];
        if (!el) return null;
        if (notify) {
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        el.removeAttribute('data-bc-upload');
        el.removeAttribute('data-bc-v2-upload');
        return null;
      }, [token, uploaded]);
    } catch { /* page changed — CDP outcome still determines the tool result */ }
  }

  return { success: true, files: filePaths, selector: what };
}
