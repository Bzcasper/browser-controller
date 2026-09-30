/**
 * browser_capture — CDP-backed traffic capture with headers, bodies, WebSocket
 * frames, SSE events, live mock/header/block/redirect rules, HAR export,
 * endpoint inventory and in-page replay.
 *
 * Why CDP and not webRequest: chrome.webRequest cannot read response bodies
 * and hides most headers. The Network domain sees both, including request
 * bodies, Set-Cookie and streamed frames. Rules use the Fetch domain, which
 * (unlike declarativeNetRequest) can fulfil a request with a mock body.
 *
 * Safety model: captured data is stored raw in memory (needed for replay) but
 * every read redacts secrets unless the caller passes revealSecrets:true.
 */
import { resolveTab } from "../lib/page-exec.js";
import { ensureCdp, pinCdp, unpinCdp } from "../lib/cdp-session.js";
import { validateRuleSet, evaluateRules } from "../lib/intercept.js";
import * as eng from "../lib/capture-engine.js";

const DEFAULT_TYPES = ["Fetch", "XHR", "WebSocket", "EventSource"];
const MAX_ENTRIES = 500;
const DEFAULT_MAX_BODY = 262_144;
const HARD_MAX_BODY = 2_000_000;
const TOTAL_BYTES_CAP = 32_000_000;
const MAX_FRAMES = 200;
const MAX_EVENTS = 500;
const OUT_CAP = 20_000;

/** tabId -> capture session */
export const captureSessions = new Map();
let listening = false;

function ensureListeners() {
  if (listening) return;
  const dbg = globalThis.chrome?.debugger;
  if (!dbg?.onEvent) return;
  dbg.onEvent.addListener(onEvent);
  dbg.onDetach?.addListener((source) => {
    const s = captureSessions.get(source.tabId);
    if (s) {
      s.active = false;
      s.detached = true;
    }
  });
  listening = true;
}

function newSession(tabId, send, opts) {
  return {
    tabId,
    send,
    active: true,
    detached: false,
    startedAt: Date.now(),
    seq: 0,
    bytes: 0,
    entries: [],
    byReq: new Map(),
    early: new Map(),
    applied: new Map(),
    ruleLog: [],
    rules: [],
    fetchOn: false,
    errors: 0,
    lastError: null,
    pending: new Set(),
    ...opts,
  };
}

function wantType(s, type) {
  return s.types === "*" || s.types.has(type);
}

function wantUrl(s, url) {
  return !s.urlRe || s.urlRe.test(url);
}

function evict(s) {
  while (
    s.entries.length > MAX_ENTRIES ||
    (s.bytes > TOTAL_BYTES_CAP && s.entries.length > 1)
  ) {
    const old = s.entries.shift();
    s.bytes -= old._bytes || 0;
    if (old.requestId && s.byReq.get(old.requestId) === old) {
      s.byReq.delete(old.requestId);
    }
  }
}

function addBytes(s, e, n) {
  e._bytes = (e._bytes || 0) + n;
  s.bytes += n;
  evict(s);
}

function makeEntry(s, p, kind, extra) {
  const e = {
    id: ++s.seq,
    requestId: p.requestId,
    kind,
    method: "GET",
    url: "",
    type: kind === "ws" ? "WebSocket" : p.type,
    startedAt: p.wallTime ? p.wallTime * 1000 : Date.now(),
    t0: p.timestamp,
    requestHeaders: {},
    responseHeaders: {},
    requestBody: null,
    responseBody: null,
    status: null,
    done: false,
    ...extra,
  };
  s.entries.push(e);
  s.byReq.set(p.requestId, e);
  const early = s.early.get(p.requestId);
  if (early) {
    Object.assign(e.requestHeaders, early.req);
    Object.assign(e.responseHeaders, early.res);
    s.early.delete(p.requestId);
  }
  const applied = s.applied.get(p.requestId);
  if (applied) e.rule = applied;
  evict(s);
  return e;
}

function clip(text, max) {
  if (typeof text !== "string") return { text, truncated: false };
  return text.length > max
    ? { text: text.slice(0, max), truncated: true }
    : { text, truncated: false };
}

function track(s, promise) {
  s.pending.add(promise);
  promise.finally(() => s.pending.delete(promise));
}

async function fetchBody(s, e) {
  try {
    const { body, base64Encoded } = await s.send("Network.getResponseBody", {
      requestId: e.requestId,
    });
    if (base64Encoded && !s.includeBinary && eng.isBinaryMime(e.mimeType)) return;
    const { text, truncated } = clip(body, s.maxBody);
    e.responseBody = text;
    e.responseBodyEncoding = base64Encoded ? "base64" : "utf8";
    e.responseBodyLength = body.length;
    if (truncated) e.responseBodyTruncated = true;
    addBytes(s, e, text.length);
  } catch (err) {
    e.bodyError = String(err?.message || err).slice(0, 200);
  }
}

async function fetchPostData(s, e) {
  try {
    const { postData } = await s.send("Network.getRequestPostData", {
      requestId: e.requestId,
    });
    const { text, truncated } = clip(postData, s.maxBody);
    e.requestBody = text;
    if (truncated) e.requestBodyTruncated = true;
    addBytes(s, e, text.length);
  } catch {
    /* body not retained by the browser (e.g. streamed upload) */
  }
}

function wantBody(s, e) {
  if (!s.bodies) return false;
  if (e.method === "OPTIONS" || e.status === 204 || e.status === 304) return false;
  if (e.status >= 300 && e.status < 400) return false;
  if (/event-stream/i.test(e.mimeType || "")) return false;
  if (!s.includeBinary && eng.isBinaryMime(e.mimeType)) return false;
  return true;
}

async function onPaused(s, p) {
  const { requestId, request, resourceType, networkId } = p;
  try {
    const rule = evaluateRules(s.rules, {
      url: request.url,
      type: resourceType,
      tabId: s.tabId,
    }).find((r) => r.action !== "log");
    if (!rule) {
      await s.send("Fetch.continueRequest", { requestId });
      return;
    }
    const info = { ruleId: rule.id, action: rule.action, at: Date.now() };
    if (networkId) {
      s.applied.set(networkId, info);
      const e = s.byReq.get(networkId);
      if (e) e.rule = info;
    }
    s.ruleLog.push({ ...info, url: request.url, method: request.method });
    if (s.ruleLog.length > 200) s.ruleLog.shift();
    if (rule.action === "block") {
      await s.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
    } else if (rule.action === "redirect") {
      await s.send("Fetch.continueRequest", { requestId, url: rule.redirectUrl });
    } else if (rule.action === "header") {
      const merged = { ...request.headers };
      for (const key of Object.keys(merged)) {
        if (Object.keys(rule.headers || {}).some((h) => h.toLowerCase() === key.toLowerCase())) {
          delete merged[key];
        }
      }
      Object.assign(merged, rule.headers || {});
      await s.send("Fetch.continueRequest", {
        requestId,
        headers: Object.entries(merged).map(([name, value]) => ({ name, value: String(value) })),
      });
    } else if (rule.action === "mock") {
      const origin = eng.headerValue(request.headers, "origin");
      const headers = [
        { name: "Content-Type", value: rule.headers?.["Content-Type"] || "application/json" },
        { name: "X-Mocked-By", value: "browser-controller" },
        ...(origin
          ? [
              { name: "Access-Control-Allow-Origin", value: origin },
              { name: "Access-Control-Allow-Credentials", value: "true" },
              { name: "Vary", value: "Origin" },
            ]
          : []),
      ];
      const body = typeof rule.mockBody === "string" ? rule.mockBody : "";
      await s.send("Fetch.fulfillRequest", {
        requestId,
        responseCode: rule.mockStatus ?? 200,
        responseHeaders: headers,
        body: btoa(unescape(encodeURIComponent(body))),
      });
    } else {
      await s.send("Fetch.continueRequest", { requestId });
    }
  } catch (err) {
    s.errors++;
    s.lastError = String(err?.message || err);
    // Never leave a request paused — that would hang the page.
    await s.send("Fetch.continueRequest", { requestId }).catch(() => {});
  }
}

function onEvent(source, method, p) {
  const s = captureSessions.get(source.tabId);
  if (!s || !s.active) return;
  try {
    handle(s, method, p);
  } catch (err) {
    s.errors++;
    s.lastError = String(err?.message || err);
  }
}

function handle(s, method, p) {
  switch (method) {
    case "Fetch.requestPaused":
      track(s, onPaused(s, p));
      return;
    case "Network.requestWillBeSent": {
      const prev = s.byReq.get(p.requestId);
      if (prev && p.redirectResponse) {
        prev.status = p.redirectResponse.status;
        prev.statusText = p.redirectResponse.statusText;
        Object.assign(prev.responseHeaders, p.redirectResponse.headers);
        prev.done = true;
        s.byReq.delete(p.requestId);
      }
      if (!wantType(s, p.type) || !wantUrl(s, p.request.url)) return;
      const e = makeEntry(s, p, "http", {
        method: p.request.method,
        url: p.request.url,
        requestHeaders: { ...p.request.headers },
        initiator: p.initiator
          ? { type: p.initiator.type, url: p.initiator.url, line: p.initiator.lineNumber }
          : null,
      });
      if (typeof p.request.postData === "string") {
        const { text, truncated } = clip(p.request.postData, s.maxBody);
        e.requestBody = text;
        if (truncated) e.requestBodyTruncated = true;
        addBytes(s, e, text.length);
      } else if (p.request.hasPostData) {
        track(s, fetchPostData(s, e));
      }
      return;
    }
    case "Network.requestWillBeSentExtraInfo":
    case "Network.responseReceivedExtraInfo": {
      const isReq = method === "Network.requestWillBeSentExtraInfo";
      const e = s.byReq.get(p.requestId);
      if (e) {
        Object.assign(isReq ? e.requestHeaders : e.responseHeaders, p.headers);
      } else {
        const slot = s.early.get(p.requestId) || { req: {}, res: {} };
        Object.assign(isReq ? slot.req : slot.res, p.headers);
        s.early.set(p.requestId, slot);
        if (s.early.size > 500) s.early.delete(s.early.keys().next().value);
      }
      return;
    }
    case "Network.responseReceived": {
      const e = s.byReq.get(p.requestId);
      if (!e) return;
      e.status = p.response.status;
      e.statusText = p.response.statusText;
      e.mimeType = p.response.mimeType;
      e.protocol = p.response.protocol;
      e.remoteIP = p.response.remoteIPAddress;
      e.fromCache = !!(p.response.fromDiskCache || p.response.fromServiceWorker);
      Object.assign(e.responseHeaders, p.response.headers);
      return;
    }
    case "Network.loadingFinished": {
      const e = s.byReq.get(p.requestId);
      if (!e) return;
      e.done = true;
      e.size = p.encodedDataLength;
      if (typeof e.t0 === "number") e.durationMs = Math.round((p.timestamp - e.t0) * 1000);
      if (wantBody(s, e)) track(s, fetchBody(s, e));
      return;
    }
    case "Network.loadingFailed": {
      const e = s.byReq.get(p.requestId);
      if (!e) return;
      e.done = true;
      e.error = p.blockedReason ? `blocked:${p.blockedReason}` : p.errorText || "failed";
      if (p.canceled) e.canceled = true;
      return;
    }
    case "Network.webSocketCreated": {
      if (!wantType(s, "WebSocket") || !wantUrl(s, p.url)) return;
      makeEntry(s, { requestId: p.requestId }, "ws", { url: p.url, frames: [], mimeType: "websocket" });
      return;
    }
    case "Network.webSocketWillSendHandshakeRequest": {
      const e = s.byReq.get(p.requestId);
      if (e) Object.assign(e.requestHeaders, p.request?.headers);
      return;
    }
    case "Network.webSocketHandshakeResponseReceived": {
      const e = s.byReq.get(p.requestId);
      if (!e) return;
      e.status = p.response.status;
      Object.assign(e.responseHeaders, p.response.headers);
      return;
    }
    case "Network.webSocketFrameSent":
    case "Network.webSocketFrameReceived": {
      const e = s.byReq.get(p.requestId);
      if (!e || !e.frames) return;
      if (e.frames.length >= MAX_FRAMES) {
        e.framesDropped = (e.framesDropped || 0) + 1;
        return;
      }
      const { text } = clip(p.response.payloadData, s.maxBody);
      e.frames.push({
        dir: method.endsWith("Sent") ? "send" : "recv",
        t: Date.now(),
        opcode: p.response.opcode,
        data: text,
      });
      addBytes(s, e, text.length);
      return;
    }
    case "Network.webSocketClosed": {
      const e = s.byReq.get(p.requestId);
      if (e) e.done = true;
      return;
    }
    case "Network.webSocketFrameError": {
      const e = s.byReq.get(p.requestId);
      if (e) e.error = p.errorMessage;
      return;
    }
    case "Network.eventSourceMessageReceived": {
      const e = s.byReq.get(p.requestId);
      if (!e) return;
      e.events = e.events || [];
      if (e.events.length >= MAX_EVENTS) {
        e.eventsDropped = (e.eventsDropped || 0) + 1;
        return;
      }
      const { text } = clip(p.data, s.maxBody);
      e.events.push({ t: Date.now(), event: p.eventName, id: p.eventId, data: text });
      addBytes(s, e, text.length);
      return;
    }
    default:
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function need(tabId) {
  const s = captureSessions.get(tabId);
  if (!s) {
    throw new Error(
      `No capture session for tab ${tabId}. Call browser_capture {action:"start", tabId} first (a service-worker restart also drops sessions).`,
    );
  }
  return s;
}

async function applyRules(s, rules) {
  validateRuleSet(rules);
  s.rules = rules.map((r, i) => ({ enabled: true, ...r, id: r.id ?? `r${i + 1}` }));
  const active = s.rules.some((r) => r.action !== "log" && r.enabled !== false);
  if (active && !s.fetchOn) {
    await s.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
    s.fetchOn = true;
  } else if (!active && s.fetchOn) {
    await s.send("Fetch.disable").catch(() => {});
    s.fetchOn = false;
  }
}

async function start(params) {
  const tab = await resolveTab(params.tabId);
  const tabId = tab.id;
  ensureListeners();
  const existing = captureSessions.get(tabId);
  if (existing?.active) {
    throw new Error(`Capture already running on tab ${tabId}. Use action:"stop" first or "clear" to reset.`);
  }
  let urlRe = null;
  if (params.urlFilter) {
    try {
      urlRe = new RegExp(params.urlFilter);
    } catch (err) {
      throw new Error(`Invalid urlFilter regex: ${err?.message || err}`, { cause: err });
    }
  }
  const types =
    !params.types || params.types.length === 0
      ? new Set(DEFAULT_TYPES)
      : params.types.includes("*")
        ? "*"
        : new Set(params.types);
  const send = await ensureCdp(tabId);
  const s = newSession(tabId, send, {
    urlRe,
    types,
    bodies: params.bodies !== false,
    includeBinary: !!params.includeBinary,
    maxBody: Math.min(Math.max(params.maxBodyBytes ?? DEFAULT_MAX_BODY, 1024), HARD_MAX_BODY),
  });
  captureSessions.set(tabId, s);
  pinCdp(tabId);
  try {
    await send("Network.enable", {
      maxTotalBufferSize: 50_000_000,
      maxResourceBufferSize: 10_000_000,
    });
    if (params.rules?.length) await applyRules(s, params.rules);
    if (params.reload) await chrome.tabs.reload(tabId);
  } catch (err) {
    unpinCdp(tabId);
    captureSessions.delete(tabId);
    throw err;
  }
  return {
    success: true,
    tabId,
    types: types === "*" ? ["*"] : [...types],
    bodies: s.bodies,
    maxBodyBytes: s.maxBody,
    rules: s.rules.length,
    enforcement: s.fetchOn ? "fetch-domain" : "capture-only",
    note: params.reload
      ? "Page reloading so the initial load is captured."
      : "Only requests made from now on are captured; pass reload:true (or navigate) to catch page-load traffic.",
  };
}

async function stop(params) {
  const s = need(params.tabId);
  if (s.fetchOn) await s.send("Fetch.disable").catch(() => {});
  await Promise.allSettled([...s.pending]);
  await s.send("Network.disable").catch(() => {});
  s.active = false;
  s.fetchOn = false;
  unpinCdp(s.tabId);
  return { success: true, tabId: s.tabId, entries: s.entries.length, kept: "Data stays readable until action:\"clear\"" };
}

function status(params) {
  const s = need(params.tabId);
  return {
    success: true,
    tabId: s.tabId,
    active: s.active,
    detached: s.detached,
    startedAt: s.startedAt,
    entries: s.entries.length,
    pendingBodies: s.pending.size,
    bytes: s.bytes,
    rules: s.rules.length,
    rulesApplied: s.ruleLog.length,
    enforcement: s.fetchOn ? "fetch-domain" : "capture-only",
    errors: s.errors,
    lastError: s.lastError,
    hint: s.detached
      ? "Debugger detached (banner dismissed, tab navigated to a protected page, or DevTools took over). Call start again."
      : undefined,
  };
}

function selectEntries(s, params) {
  let list = s.entries;
  if (params.filter) {
    let re;
    try {
      re = new RegExp(params.filter);
    } catch (err) {
      throw new Error(`Invalid filter regex: ${err?.message || err}`, { cause: err });
    }
    list = list.filter((e) => re.test(e.url));
  }
  if (params.method) list = list.filter((e) => e.method === params.method.toUpperCase());
  if (params.type) list = list.filter((e) => e.type === params.type);
  if (params.status !== undefined && params.status !== null) {
    const st = String(params.status).toLowerCase();
    list = list.filter((e) => {
      if (st === "error") return !!e.error;
      if (/^[1-5]xx$/.test(st)) return String(e.status ?? "").startsWith(st[0]);
      return String(e.status) === st;
    });
  }
  if (params.hasBody) list = list.filter((e) => !!e.responseBody);
  if (typeof params.since === "number") list = list.filter((e) => e.id > params.since);
  return list;
}

function row(e, reveal, preview) {
  const r = {
    id: e.id,
    method: e.method,
    url: eng.redactUrl(e.url, reveal),
    type: e.type,
    status: e.error ? "error" : e.status,
    mime: e.mimeType,
    ms: e.durationMs,
    reqBytes: e.requestBody?.length,
    resBytes: e.responseBodyLength ?? e.responseBody?.length,
    done: e.done,
    frames: e.frames?.length,
    events: e.events?.length,
    rule: e.rule?.ruleId,
    error: e.error,
  };
  if (preview > 0 && e.responseBody) {
    r.preview = eng.redactBody(e.responseBody, e.mimeType, reveal).slice(0, preview);
  }
  return r;
}

function list(params) {
  const s = need(params.tabId);
  const reveal = !!params.revealSecrets;
  const all = selectEntries(s, params);
  const offset = params.offset ?? 0;
  const limit = params.limit ?? 50;
  const slice = all.slice(offset, offset + limit);
  return {
    success: true,
    total: all.length,
    returned: slice.length,
    active: s.active,
    lastId: s.entries.length ? s.entries[s.entries.length - 1].id : 0,
    entries: slice.map((e) => row(e, reveal, params.preview ?? 0)),
  };
}

function get(params) {
  const s = need(params.tabId);
  const e = s.entries.find((x) => x.id === params.id);
  if (!e) throw new Error(`No captured entry with id ${params.id} (evicted or cleared?)`);
  const reveal = !!params.revealSecrets;
  const format = params.format || "json";
  if (format === "curl") return { success: true, id: e.id, curl: eng.toCurl(e, reveal) };
  if (format === "fetch") return { success: true, id: e.id, fetch: eng.toFetch(e, reveal) };
  const max = params.maxChars ?? OUT_CAP;
  const part = params.part || "all";
  const out = { success: true, id: e.id, method: e.method, url: eng.redactUrl(e.url, reveal), type: e.type };
  if (part === "all" || part === "request") {
    const reqMime = eng.headerValue(e.requestHeaders, "content-type");
    out.request = {
      headers: eng.redactHeaders(e.requestHeaders, reveal),
      body: clip(eng.redactBody(e.requestBody, reqMime, reveal), max).text,
      bodyTruncated: e.requestBodyTruncated || undefined,
      initiator: e.initiator || undefined,
    };
  }
  if (part === "all" || part === "response") {
    const body = eng.redactBody(e.responseBody, e.mimeType, reveal);
    const c = clip(body, max);
    out.response = {
      status: e.status,
      statusText: e.statusText,
      mime: e.mimeType,
      protocol: e.protocol,
      remoteIP: e.remoteIP,
      fromCache: e.fromCache || undefined,
      headers: eng.redactHeaders(e.responseHeaders, reveal),
      body: c.text,
      bodyEncoding: e.responseBodyEncoding,
      bodyTruncated: c.truncated || e.responseBodyTruncated || undefined,
      bodyLength: e.responseBodyLength,
      bodyError: e.bodyError,
      error: e.error,
      ms: e.durationMs,
    };
  }
  if ((part === "all" || part === "frames") && e.frames) {
    out.frames = e.frames.map((f) => ({ ...f, data: clip(eng.redactBody(f.data, "", reveal), 2000).text }));
    out.framesDropped = e.framesDropped;
  }
  if ((part === "all" || part === "events") && e.events) {
    out.events = e.events.map((v) => ({ ...v, data: clip(eng.redactBody(v.data, "", reveal), 2000).text }));
    out.eventsDropped = e.eventsDropped;
  }
  if (e.rule) out.rule = e.rule;
  return out;
}

function summarize(params) {
  const s = need(params.tabId);
  const list_ = selectEntries(s, params);
  return { success: true, total: list_.length, endpoints: eng.summarizeEndpoints(list_) };
}

function exportHar(params) {
  const s = need(params.tabId);
  let entries = selectEntries(s, params);
  if (params.limit) entries = entries.slice(-params.limit);
  return {
    success: true,
    entries: entries.length,
    har: eng.buildHar(s.tabId, entries, {
      reveal: !!params.revealSecrets,
      bodyMaxChars: params.maxChars ?? 50_000,
    }),
  };
}

async function replay(params) {
  const s = need(params.tabId);
  const e = s.entries.find((x) => x.id === params.id);
  if (!e) throw new Error(`No captured entry with id ${params.id}`);
  if (e.kind !== "http") throw new Error("Only HTTP entries can be replayed (not WebSocket).");
  const o = params.overrides || {};
  const method = (o.method || e.method).toUpperCase();
  if (!["GET", "HEAD"].includes(method) && !params.confirmMutating) {
    throw new Error(
      `Replaying ${method} can change server state. Pass confirmMutating:true once you have checked the target.`,
    );
  }
  const url = o.url || e.url;
  const headers = { ...eng.replayableHeaders(e.requestHeaders), ...(o.headers || {}) };
  const body = o.body !== undefined ? o.body : e.requestBody;
  const init = { method, headers, credentials: "include" };
  if (body != null && !["GET", "HEAD"].includes(method)) init.body = body;
  const expression = `(async () => {
    try {
      const r = await fetch(${JSON.stringify(url)}, ${JSON.stringify(init)});
      const text = await r.text();
      const headers = {};
      r.headers.forEach((v, k) => { headers[k] = v; });
      return { ok: true, status: r.status, statusText: r.statusText, headers, body: text.slice(0, ${HARD_MAX_BODY}), length: text.length };
    } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
  })()`;
  const { result, exceptionDetails } = await s.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) {
    return { success: false, error: exceptionDetails.exception?.description || exceptionDetails.text };
  }
  const v = result.value;
  if (!v?.ok) {
    return {
      success: false,
      error: v?.error,
      hint: "fetch runs inside the tab: cross-origin targets need CORS, so replay from a tab already on the API's origin.",
    };
  }
  const reveal = !!params.revealSecrets;
  const mime = v.headers["content-type"];
  const c = clip(eng.redactBody(v.body, mime, reveal), params.maxChars ?? OUT_CAP);
  return {
    success: true,
    id: e.id,
    request: { method, url: eng.redactUrl(url, reveal) },
    status: v.status,
    statusText: v.statusText,
    headers: eng.redactHeaders(v.headers, reveal),
    body: c.text,
    bodyTruncated: c.truncated || undefined,
    bodyLength: v.length,
  };
}

async function setRules(params) {
  const s = need(params.tabId);
  if (!s.active) throw new Error("Capture is stopped; start it before changing rules.");
  await applyRules(s, params.rules || []);
  return { success: true, rules: s.rules.length, enforcement: s.fetchOn ? "fetch-domain" : "capture-only" };
}

function clear(params) {
  const s = need(params.tabId);
  const n = s.entries.length;
  s.entries.length = 0;
  s.byReq.clear();
  s.early.clear();
  s.applied.clear();
  s.ruleLog.length = 0;
  s.bytes = 0;
  return { success: true, cleared: n };
}

export async function handleCapture(params) {
  const { action } = params;
  switch (action) {
    case "start":
      return start(params);
    case "stop":
      return stop(params);
    case "status":
      return status(params);
    case "list":
      return list(params);
    case "get":
      return get(params);
    case "summarize":
      return summarize(params);
    case "export-har":
      return exportHar(params);
    case "replay":
      return replay(params);
    case "set-rules":
      return setRules(params);
    case "clear":
      return clear(params);
    default:
      throw new Error(`Unknown browser_capture action: ${action}`);
  }
}
