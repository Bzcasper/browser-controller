(function () {
  'use strict';
  if (window.__browserControllerInjected) return;
  window.__browserControllerInjected = true;

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__browserControllerConsole !== true) return;
    if (!['log', 'warn', 'error', 'info', 'debug'].includes(data.level)) return;
    if (typeof data.text !== 'string') return;
    try {
      chrome.runtime.sendMessage({
        type: 'console',
        level: data.level,
        text: data.text.length > 2000 ? data.text.slice(0, 2000) + '…[truncated]' : data.text,
      });
    } catch {}
  });
})();
