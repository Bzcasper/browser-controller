(function () {
  'use strict';
  if (window.__browserControllerPageConsoleInjected) return;
  window.__browserControllerPageConsoleInjected = true;

  const levels = ['log', 'warn', 'error', 'info', 'debug'];
  const original = Object.fromEntries(levels.map((level) => [level, console[level]]));

  function serialize(args) {
    const text = args.map((value) => {
      if (typeof value === 'object' && value !== null) {
        try { return JSON.stringify(value); } catch { return String(value); }
      }
      return String(value);
    }).join(' ');
    return text.length > 2000 ? text.slice(0, 2000) + '…[truncated]' : text;
  }

  function emit(level, args) {
    const text = serialize(args);
    if (text.includes('ResizeObserver loop')) return;
    if (text.includes('message channel closed before a response was received')) return;
    window.postMessage({
      __browserControllerConsole: true,
      level,
      text,
    }, window.location.origin === 'null' ? '*' : window.location.origin);
  }

  for (const level of levels) {
    console[level] = (...args) => {
      original[level].apply(console, args);
      try { emit(level, args); } catch {}
    };
  }

  window.addEventListener('error', (event) => {
    if (typeof event?.message === 'string' && event.message.includes('ResizeObserver loop')) return;
    try { emit('error', [`Uncaught: ${event?.message || 'Unknown error'} at ${event?.filename || ''}:${event?.lineno || 0}`]); } catch {}
  });

  window.addEventListener('unhandledrejection', (event) => {
    try { emit('error', [`Unhandled rejection: ${String(event?.reason)}`]); } catch {}
  });
})();
