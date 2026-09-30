import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * browser_capture: pure engine + CDP-driven handler with a fake chrome.debugger.
 */

type Listener = (source: { tabId: number }, method: string, params: unknown) => void;
const listeners: Listener[] = [];
const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
let responses: Record<string, (params: Record<string, unknown>) => unknown> = {};

(globalThis as unknown as { chrome: unknown }).chrome = {
  tabs: {
    get: async (id: number) => ({ id, windowId: 1, url: "https://app.test/", title: "t", active: true }),
    query: async () => [],
    reload: vi.fn(async () => {}),
    update: async () => ({}),
    remove: async () => ({}),
    create: async () => ({}),
    onRemoved: { addListener: () => {} },
  },
  scripting: { executeScript: async () => [{ result: null }] },
  storage: { session: { get: async () => ({}), set: async () => {} } },
  debugger: {
    attach: async () => {},
    detach: async () => {},
    sendCommand: async (_t: unknown, method: string, params: Record<string, unknown> = {}) => {
      sent.push({ method, params });
      if (responses[method]) return responses[method](params);
      if (method === "Runtime.evaluate") return { result: { value: 1 } };
      return {};
    },
    onEvent: { addListener: (l: Listener) => listeners.push(l) },
    onDetach: { addListener: () => {} },
  },
  windows: { get: async () => ({ width: 1280, height: 900 }) },
};

const eng = await import("../extension/lib/capture-engine.js");
const { handleCapture, captureSessions } = await import("../extension/handlers/capture.js");

const emit = (method: string, params: unknown, tabId = 7) =>
  listeners.forEach((l) => l({ tabId }, method, params));
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("capture engine", () => {
  it("redacts sensitive headers but keeps normal ones", () => {
    const out = eng.redactHeaders({ Authorization: "Bearer x", Cookie: "a=b", "Content-Type": "application/json", "X-Api-Key": "k" });
    expect(out.Authorization).toBe("[redacted]");
    expect(out.Cookie).toBe("[redacted]");
    expect(out["X-Api-Key"]).toBe("[redacted]");
    expect(out["Content-Type"]).toBe("application/json");
    expect(eng.redactHeaders({ Authorization: "Bearer x" }, true).Authorization).toBe("Bearer x");
  });

  it("redacts JSON keys, form keys and URL query params", () => {
    expect(JSON.parse(eng.redactBody('{"user":"a","password":"p","nested":{"access_token":"t"}}', "application/json"))).toEqual({
      user: "a",
      password: "[redacted]",
      nested: { access_token: "[redacted]" },
    });
    expect(eng.redactBody("user=a&password=p", "application/x-www-form-urlencoded")).toContain("password=%5Bredacted%5D");
    expect(eng.redactUrl("https://x.test/a?token=abc&q=1")).toContain("token=%5Bredacted%5D");
  });

  it("templates ids, uuids and tokens in paths", () => {
    expect(eng.endpointOf("https://api.x.com/v1/users/123/posts?limit=5&page=2")).toEqual({
      host: "api.x.com",
      path: "/v1/users/{id}/posts",
      query: ["limit", "page"],
    });
    expect(eng.endpointOf("https://x.test/o/3f2504e0-4f89-11d3-9a0c-0305e82c3301").path).toBe("/o/{uuid}");
    expect(eng.endpointOf("https://x.test/s/abc123def456ghi789").path).toBe("/s/{token}");
  });

  it("infers and merges shapes", () => {
    const a = eng.inferShape({ id: 1, tags: ["a"], meta: { ok: true } });
    expect(a).toEqual({ id: "number", tags: ["string"], meta: { ok: "boolean" } });
    expect(eng.mergeShapes(a, eng.inferShape({ id: "x", extra: null }))).toEqual({
      id: "number|string",
      tags: ["string"],
      meta: { ok: "boolean" },
      extra: "null",
    });
  });

  it("summarizes endpoints and builds curl/fetch/HAR without leaking secrets", () => {
    const entries = [
      { id: 1, kind: "http", method: "GET", url: "https://api.x.com/u/1", status: 200, mimeType: "application/json", responseBody: '{"a":1}', requestHeaders: { Authorization: "Bearer s3cret" }, durationMs: 10 },
      { id: 2, kind: "http", method: "GET", url: "https://api.x.com/u/2", status: 404, mimeType: "application/json", responseBody: '{"a":"x"}', requestHeaders: {}, durationMs: 20 },
    ];
    const s = eng.summarizeEndpoints(entries);
    expect(s).toHaveLength(1);
    expect(s[0].endpoint).toBe("GET api.x.com/u/{id}");
    expect(s[0].count).toBe(2);
    expect(s[0].statuses).toEqual({ 200: 1, 404: 1 });
    expect(s[0].responseShape).toEqual({ a: "number|string" });
    expect(eng.toCurl(entries[0])).not.toContain("s3cret");
    expect(eng.toFetch(entries[0])).not.toContain("s3cret");
    expect(eng.toCurl(entries[0], true)).toContain("s3cret");
    const har = eng.buildHar(7, entries);
    expect(JSON.stringify(har)).not.toContain("s3cret");
    expect(har.log.entries[0].response.content.text).toBe('{"a":1}');
  });
});

describe("browser_capture handler", () => {
  beforeEach(() => {
    sent.length = 0;
    responses = {};
    captureSessions.clear();
  });

  it("rejects list before start with an actionable error", async () => {
    await expect(handleCapture({ action: "list", tabId: 7 })).rejects.toThrow(/start/);
  });

  it("captures request/response with headers and body, redacts on read", async () => {
    responses["Network.getResponseBody"] = () => ({ body: '{"token":"zzz","name":"bob"}', base64Encoded: false });
    const started = await handleCapture({ action: "start", tabId: 7 });
    expect(started.success).toBe(true);
    expect(sent.map((c) => c.method)).toContain("Network.enable");

    emit("Network.requestWillBeSent", {
      requestId: "r1", type: "Fetch", timestamp: 1, wallTime: 1000,
      request: { url: "https://api.test/v1/users/42?token=abc", method: "POST", headers: { Authorization: "Bearer raw" }, postData: '{"password":"pw"}' },
    });
    emit("Network.requestWillBeSentExtraInfo", { requestId: "r1", headers: { Cookie: "sid=1" } });
    emit("Network.responseReceived", { requestId: "r1", response: { status: 200, statusText: "OK", mimeType: "application/json", headers: { "content-type": "application/json" } } });
    emit("Network.loadingFinished", { requestId: "r1", timestamp: 1.25, encodedDataLength: 30 });
    await flush();
    await flush();

    const l = await handleCapture({ action: "list", tabId: 7 });
    expect(l.total).toBe(1);
    expect(l.entries[0]).toMatchObject({ id: 1, method: "POST", status: 200, ms: 250 });
    expect(l.entries[0].url).toContain("token=%5Bredacted%5D");

    const g = await handleCapture({ action: "get", tabId: 7, id: 1 });
    expect(g.request.headers.Authorization).toBe("[redacted]");
    expect(g.request.headers.Cookie).toBe("[redacted]");
    expect(JSON.parse(g.request.body).password).toBe("[redacted]");
    expect(JSON.parse(g.response.body)).toEqual({ token: "[redacted]", name: "bob" });

    const raw = await handleCapture({ action: "get", tabId: 7, id: 1, revealSecrets: true });
    expect(raw.request.headers.Authorization).toBe("Bearer raw");
    expect(JSON.parse(raw.response.body).token).toBe("zzz");

    const curl = await handleCapture({ action: "get", tabId: 7, id: 1, format: "curl" });
    expect(curl.curl).not.toContain("Bearer raw");
  });

  it("filters by type and urlFilter at capture time", async () => {
    await handleCapture({ action: "start", tabId: 7, urlFilter: "/api/" });
    emit("Network.requestWillBeSent", { requestId: "a", type: "Image", timestamp: 1, request: { url: "https://x.test/api/logo.png", method: "GET", headers: {} } });
    emit("Network.requestWillBeSent", { requestId: "b", type: "XHR", timestamp: 1, request: { url: "https://x.test/static/app.js", method: "GET", headers: {} } });
    emit("Network.requestWillBeSent", { requestId: "c", type: "XHR", timestamp: 1, request: { url: "https://x.test/api/items", method: "GET", headers: {} } });
    const l = await handleCapture({ action: "list", tabId: 7 });
    expect(l.entries.map((e: { url: string }) => e.url)).toEqual(["https://x.test/api/items"]);
  });

  it("records websocket frames and SSE events", async () => {
    await handleCapture({ action: "start", tabId: 7 });
    emit("Network.webSocketCreated", { requestId: "w1", url: "wss://x.test/live" });
    emit("Network.webSocketFrameSent", { requestId: "w1", response: { opcode: 1, payloadData: '{"sub":"a"}' } });
    emit("Network.webSocketFrameReceived", { requestId: "w1", response: { opcode: 1, payloadData: '{"tick":1}' } });
    emit("Network.requestWillBeSent", { requestId: "s1", type: "EventSource", timestamp: 1, request: { url: "https://x.test/stream", method: "GET", headers: {} } });
    emit("Network.eventSourceMessageReceived", { requestId: "s1", eventName: "message", eventId: "1", data: "hello" });
    const list = await handleCapture({ action: "list", tabId: 7 });
    expect(list.entries.find((e: { frames?: number }) => e.frames)?.frames).toBe(2);
    const ws = await handleCapture({ action: "get", tabId: 7, id: 1, part: "frames" });
    expect(ws.frames.map((f: { dir: string }) => f.dir)).toEqual(["send", "recv"]);
    const sse = await handleCapture({ action: "get", tabId: 7, id: 2, part: "events" });
    expect(sse.events[0].data).toBe("hello");
  });

  it("applies mock rules through the Fetch domain and never leaves a request paused", async () => {
    await handleCapture({
      action: "start",
      tabId: 7,
      rules: [{ id: "m1", match: "/api/flag", action: "mock", mockStatus: 201, mockBody: '{"on":true}' }],
    });
    expect(sent.some((c) => c.method === "Fetch.enable")).toBe(true);
    emit("Fetch.requestPaused", { requestId: "f1", resourceType: "Fetch", request: { url: "https://x.test/api/flag", method: "GET", headers: { Origin: "https://app.test" } } });
    emit("Fetch.requestPaused", { requestId: "f2", resourceType: "Fetch", request: { url: "https://x.test/other", method: "GET", headers: {} } });
    await flush();
    const ful = sent.find((c) => c.method === "Fetch.fulfillRequest");
    expect(ful?.params.responseCode).toBe(201);
    expect(atob(ful?.params.body as string)).toBe('{"on":true}');
    expect(sent.filter((c) => c.method === "Fetch.continueRequest")).toHaveLength(1);
    const status = await handleCapture({ action: "status", tabId: 7 });
    expect(status.rulesApplied).toBe(1);
  });

  it("refuses to replay non-GET without confirmMutating", async () => {
    await handleCapture({ action: "start", tabId: 7 });
    emit("Network.requestWillBeSent", { requestId: "p", type: "Fetch", timestamp: 1, request: { url: "https://x.test/api/order", method: "POST", headers: {}, postData: "{}" } });
    await expect(handleCapture({ action: "replay", tabId: 7, id: 1 })).rejects.toThrow(/confirmMutating/);
    responses["Runtime.evaluate"] = () => ({ result: { value: { ok: true, status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body: '{"ok":1}', length: 8 } } });
    const r = await handleCapture({ action: "replay", tabId: 7, id: 1, confirmMutating: true });
    expect(r.status).toBe(200);
  });

  it("stop disables domains and keeps data readable", async () => {
    await handleCapture({ action: "start", tabId: 7 });
    emit("Network.requestWillBeSent", { requestId: "k", type: "XHR", timestamp: 1, request: { url: "https://x.test/a", method: "GET", headers: {} } });
    await handleCapture({ action: "stop", tabId: 7 });
    expect(sent.map((c) => c.method)).toContain("Network.disable");
    expect((await handleCapture({ action: "list", tabId: 7 })).total).toBe(1);
    expect((await handleCapture({ action: "clear", tabId: 7 })).cleared).toBe(1);
  });
});
