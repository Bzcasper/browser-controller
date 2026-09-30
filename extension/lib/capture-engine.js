/**
 * Pure capture engine (no chrome deps — unit-testable).
 *
 * Everything the browser_capture handler needs that is not CDP plumbing:
 * secret redaction, URL → endpoint templating, JSON shape inference,
 * curl / fetch() snippet generation and HAR 1.2 export.
 *
 * Redaction is applied on OUTPUT (never on storage) so `revealSecrets:true`
 * and `replay` can use the raw values, while every default read is safe to
 * paste into a chat, a ticket or a skill.
 */

export const REDACTED = "[redacted]";

const SENSITIVE_HEADER_RE =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token|x-amz-security-token)$|token|secret|api[-_]?key|session/i;

const SENSITIVE_KEY_RE =
  /pass(word|wd|phrase)?|secret|token|api[-_]?key|authorization|cookie|session|credential|otp|\bssn\b|card[-_]?(number|num)|cvv|cvc/i;

const BINARY_MIME_RE =
  /^(image|video|audio|font)\/|application\/(octet-stream|zip|gzip|pdf|wasm|x-protobuf|vnd\.google\.protobuf)/i;

export function isBinaryMime(mime) {
  return !!mime && BINARY_MIME_RE.test(mime);
}

export function isJsonMime(mime) {
  return !!mime && /json|\+json|javascript\/json/i.test(mime);
}

export function redactHeaders(headers, reveal = false) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    out[k] = !reveal && SENSITIVE_HEADER_RE.test(k) ? REDACTED : v;
  }
  return out;
}

export function redactUrl(url, reveal = false) {
  if (reveal || !url) return url;
  try {
    const u = new URL(url);
    let changed = false;
    for (const key of [...u.searchParams.keys()]) {
      if (SENSITIVE_KEY_RE.test(key)) {
        u.searchParams.set(key, REDACTED);
        changed = true;
      }
    }
    return changed ? u.toString() : url;
  } catch {
    return url;
  }
}

export function redactJson(value, depth = 0) {
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactJson(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] =
      SENSITIVE_KEY_RE.test(k) && (v === null || typeof v !== "object")
        ? REDACTED
        : redactJson(v, depth + 1);
  }
  return out;
}

/** Redact a text body (JSON keys, form-encoded keys). Unknown formats pass through. */
export function redactBody(text, mime, reveal = false) {
  if (reveal || typeof text !== "string" || text === "") return text;
  const looksJson = isJsonMime(mime) || /^\s*[[{]/.test(text);
  if (looksJson) {
    try {
      return JSON.stringify(redactJson(JSON.parse(text)));
    } catch {
      /* not JSON after all — fall through */
    }
  }
  if (/x-www-form-urlencoded/i.test(mime || "")) {
    try {
      const p = new URLSearchParams(text);
      for (const key of [...p.keys()]) {
        if (SENSITIVE_KEY_RE.test(key)) p.set(key, REDACTED);
      }
      return p.toString();
    } catch {
      /* ignore */
    }
  }
  return text;
}

export function headerValue(headers, name) {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers || {})) {
    if (k.toLowerCase() === want) return v;
  }
  return undefined;
}

function templateSegment(seg) {
  if (/^\d+$/.test(seg)) return "{id}";
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)
  )
    return "{uuid}";
  if (seg.length >= 16 && /\d/.test(seg) && /^[A-Za-z0-9_-]+$/.test(seg))
    return "{token}";
  return seg;
}

/** "https://api.x.com/v1/users/123/posts?limit=5" → { host, path:"/v1/users/{id}/posts", query:["limit"] } */
export function endpointOf(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.split("/").map(templateSegment).join("/") || "/";
    return { host: u.host, path, query: [...new Set(u.searchParams.keys())] };
  } catch {
    return { host: "", path: String(url), query: [] };
  }
}

/** Compact structural type of a JSON value (arrays → first element, objects capped). */
export function inferShape(value, depth = 0) {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return value.length === 0 || depth >= 4
      ? "array"
      : [inferShape(value[0], depth + 1)];
  }
  if (typeof value === "object") {
    if (depth >= 4) return "object";
    const out = {};
    for (const key of Object.keys(value).slice(0, 40)) {
      out[key] = inferShape(value[key], depth + 1);
    }
    return out;
  }
  return typeof value;
}

/** Union two shapes so one endpoint's shape covers every observed sample. */
export function mergeShapes(a, b) {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const aObj = a && typeof a === "object" && !Array.isArray(a);
  const bObj = b && typeof b === "object" && !Array.isArray(b);
  if (aObj && bObj) {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = mergeShapes(a[k], v);
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) return [mergeShapes(a[0], b[0])];
  if (JSON.stringify(a) === JSON.stringify(b)) return a;
  const parts = new Set(
    [a, b].flatMap((x) => (typeof x === "string" ? x.split("|") : ["mixed"])),
  );
  return [...parts].join("|");
}

function tryParseJson(text) {
  if (typeof text !== "string" || text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Endpoint inventory: what API surface did this page actually talk to? */
export function summarizeEndpoints(entries) {
  const groups = new Map();
  for (const e of entries) {
    const ep = endpointOf(e.url);
    const key = `${e.kind === "ws" ? "WS" : e.method} ${ep.host}${ep.path}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        endpoint: key,
        count: 0,
        statuses: {},
        mimeTypes: new Set(),
        query: new Set(),
        requestShape: undefined,
        responseShape: undefined,
        firstId: e.id,
        lastId: e.id,
        _ms: 0,
        _msN: 0,
        frames: 0,
        events: 0,
      };
      groups.set(key, g);
    }
    g.count++;
    g.lastId = e.id;
    const st = e.error ? "error" : String(e.status ?? "pending");
    g.statuses[st] = (g.statuses[st] || 0) + 1;
    if (e.mimeType) g.mimeTypes.add(e.mimeType);
    ep.query.forEach((q) => g.query.add(q));
    if (typeof e.durationMs === "number") {
      g._ms += e.durationMs;
      g._msN++;
    }
    g.frames += e.frames?.length || 0;
    g.events += e.events?.length || 0;
    const rq = tryParseJson(e.requestBody);
    if (rq !== undefined)
      g.requestShape = mergeShapes(g.requestShape, inferShape(rq));
    const rs = tryParseJson(e.responseBody);
    if (rs !== undefined)
      g.responseShape = mergeShapes(g.responseShape, inferShape(rs));
  }
  return [...groups.values()]
    .map((g) => ({
      endpoint: g.endpoint,
      count: g.count,
      statuses: g.statuses,
      mimeTypes: [...g.mimeTypes],
      query: [...g.query],
      avgMs: g._msN ? Math.round(g._ms / g._msN) : null,
      requestShape: g.requestShape,
      responseShape: g.responseShape,
      frames: g.frames || undefined,
      events: g.events || undefined,
      firstId: g.firstId,
      lastId: g.lastId,
    }))
    .sort((a, b) => b.count - a.count);
}

const SKIP_REPLAY_HEADER_RE =
  /^(host|content-length|connection|cookie|origin|referer|user-agent|accept-encoding|sec-.*|proxy-.*|:.*)$/i;

/** Headers safe to hand to fetch() (raw values — callers redact on output). */
export function replayableHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (!SKIP_REPLAY_HEADER_RE.test(k)) out[k] = v;
  }
  return out;
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function toCurl(e, reveal = false) {
  const headers = redactHeaders(replayableHeaders(e.requestHeaders), reveal);
  const parts = [`curl -X ${e.method} ${shq(redactUrl(e.url, reveal))}`];
  for (const [k, v] of Object.entries(headers)) parts.push(`-H ${shq(`${k}: ${v}`)}`);
  if (e.requestBody) {
    parts.push(
      `--data-raw ${shq(redactBody(e.requestBody, headerValue(e.requestHeaders, "content-type"), reveal))}`,
    );
  }
  return parts.join(" \\\n  ");
}

export function toFetch(e, reveal = false) {
  const init = {
    method: e.method,
    headers: redactHeaders(replayableHeaders(e.requestHeaders), reveal),
    credentials: "include",
  };
  if (e.requestBody) {
    init.body = redactBody(
      e.requestBody,
      headerValue(e.requestHeaders, "content-type"),
      reveal,
    );
  }
  return `await fetch(${JSON.stringify(redactUrl(e.url, reveal))}, ${JSON.stringify(init, null, 2)});`;
}

const toPairs = (obj) =>
  Object.entries(obj || {}).map(([name, value]) => ({ name, value: String(value) }));

/** HAR 1.2 with real headers/bodies (redacted unless reveal). */
export function buildHar(tabId, entries, { reveal = false, bodyMaxChars = 50_000 } = {}) {
  const cap = (s) =>
    typeof s === "string" && s.length > bodyMaxChars ? s.slice(0, bodyMaxChars) : s;
  const har = entries.map((e) => {
    const reqMime = headerValue(e.requestHeaders, "content-type");
    const out = {
      startedDateTime: new Date(e.startedAt ?? Date.now()).toISOString(),
      time: e.durationMs ?? 0,
      request: {
        method: e.method,
        url: redactUrl(e.url, reveal),
        httpVersion: e.protocol || "HTTP/1.1",
        headers: toPairs(redactHeaders(e.requestHeaders, reveal)),
        queryString: [],
        cookies: [],
        headersSize: -1,
        bodySize: e.requestBody ? e.requestBody.length : 0,
      },
      response: {
        status: e.status ?? 0,
        statusText: e.statusText || "",
        httpVersion: e.protocol || "HTTP/1.1",
        headers: toPairs(redactHeaders(e.responseHeaders, reveal)),
        cookies: [],
        content: {
          size: e.size ?? 0,
          mimeType: e.mimeType || "",
          text: cap(redactBody(e.responseBody, e.mimeType, reveal)),
          ...(e.responseBodyEncoding === "base64" ? { encoding: "base64" } : {}),
        },
        redirectURL: headerValue(e.responseHeaders, "location") || "",
        headersSize: -1,
        bodySize: e.size ?? -1,
      },
      cache: {},
      timings: { send: 0, wait: e.durationMs ?? 0, receive: 0 },
      _resourceType: e.type,
    };
    if (e.requestBody) {
      out.request.postData = {
        mimeType: reqMime || "",
        text: cap(redactBody(e.requestBody, reqMime, reveal)),
      };
    }
    if (e.frames?.length) {
      out._webSocketMessages = e.frames.map((f) => ({
        type: f.dir === "send" ? "send" : "receive",
        time: f.t / 1000,
        opcode: f.opcode,
        data: cap(f.data),
      }));
    }
    if (e.events?.length) out._eventSourceMessages = e.events;
    if (e.error) out._error = e.error;
    if (e.rule) out._intercept = e.rule;
    return out;
  });
  return {
    log: {
      version: "1.2",
      creator: { name: "browser-controller/browser_capture", version: "2.4.0" },
      pages: [{ id: `tab-${tabId}`, title: `Tab ${tabId}` }],
      entries: har,
    },
  };
}
