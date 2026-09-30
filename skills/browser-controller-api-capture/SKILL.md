---
name: browser-controller-api-capture
description: Discover, record, mock and replay the private/undocumented APIs behind any website using the user's real logged-in Chrome via Browser Controller's browser_capture tool (headers, request/response bodies, WebSocket frames, SSE, HAR, endpoint inventory, replay, live mocks). Use to reverse-engineer a site's API, build a script or n8n HTTP node from real traffic, debug a failing web request, or test a page against mocked responses.
---

# API capture and interception with browser_capture

Use `browser_capture` (CDP Network + Fetch domains). It sees what `browser_network` and `browser_intercept` cannot: request and response **bodies**, full headers, Set-Cookie, WebSocket frames, SSE events. Old tools stay for cheap jobs: `browser_network` = URL list, `browser_intercept` = block/redirect via declarativeNetRequest, metadata-only HAR.

## The loop

```
start → drive the UI → summarize → list (narrow) → get (one call in full) → replay / export-har → stop → clear
```

1. **Find the tab by URL**: `browser_tabs {action:"list"}`; match `url`, never hardcode `tabId`.
2. **Start narrow.** `browser_capture {action:"start", tabId, urlFilter:"/api/|/graphql|/v[0-9]+/", reload:true}`. `reload:true` catches page-load calls; omit it when a reload would lose state (unsaved forms, one-time flows). Defaults record Fetch, XHR, WebSocket, EventSource with bodies up to 256 KB. Add `types:["*"]` only to hunt for odd transports (Document, Script, Ping).
3. **Trigger the behaviour** with `browser_observe` / `browser_act` (or the user). One user action per capture window keeps attribution easy.
4. **Inventory first**: `{action:"summarize"}` returns endpoints like `POST api.site.com/v2/items/{id}/comments`, status counts, query params, and merged JSON request/response shapes. This is usually all you need to write a client.
5. **Drill in**: `{action:"list", status:"4xx"}` / `{method:"POST", hasBody:true, preview:200}` / `{since:<lastId>}` to poll new traffic. Then `{action:"get", id}` for one call; `part:"request"` or `"response"` to save tokens; `format:"curl"` or `"fetch"` for a ready snippet.
6. **Prove it**: `{action:"replay", id}` re-sends the call from inside the tab (same cookies, same origin). Use `overrides:{body:"…", headers:{…}}` to vary one parameter. Non-GET requires `confirmMutating:true`; only set it after you have read the request and the user's intent covers side effects.
7. **Export** when asked: `{action:"export-har", filter}` (HAR 1.2 with bodies). Keep secrets redacted.
8. **Clean up**: `stop`, then `clear`. The debugger banner disappears when the session detaches (30 s idle after stop).

## Techniques by target

- **Auth model**: look at `get part:"request"` headers (redacted names still show what exists): `Authorization` Bearer, `X-CSRF-Token`, custom `x-*` headers, cookie-only. Find where the token comes from by capturing from a fresh reload with `types:["*"]` and searching earlier calls' responses. In a script, prefer "read the token from the page then fetch" or `replay` in the tab over copying tokens out.
- **Pagination**: compare `summarize` query lists and response shapes across consecutive calls: `cursor`, `next`, `page`, `offset`, `after`. Confirm by replaying with the next cursor from the last response.
- **GraphQL**: everything is `POST /graphql`, so `summarize` groups them together. Use `list {filter:"/graphql", preview:120}` and read `operationName`; persisted queries send `extensions.persistedQuery.sha256Hash` instead of a query. Replay with `overrides.body` changing `variables`.
- **WebSocket**: `get {id, part:"frames"}` shows `send`/`recv` payloads (200 frames kept, oldest wins, `framesDropped` reports overflow). Look for a subscribe/auth frame first, then message types. Socket.IO frames are prefixed with numeric engine codes (`42["event",…]`).
- **SSE / streaming** (LLM chats, feeds): `get {id, part:"events"}`; body is intentionally not captured for `text/event-stream`. To capture the initial request body use the same entry's `part:"request"`.
- **gRPC-web / protobuf**: bodies are binary; `start {includeBinary:true}` keeps base64. Decode offline; don't try to read it inline.
- **Uploads / multipart**: request body is truncated at `maxBodyBytes`; the shape is usually enough. Keep `includeBinary` off.
- **Service-worker or cached responses**: `fromCache:true` in `get` means the network never saw it; reload with cache disabled by using a fresh navigation via `browser_navigate` to a URL with a cache-busting query, or accept the cached body.
- **Anti-bot / signed requests**: if replay works in-tab but the same call fails in a script, the site signs requests in page JS (header like `x-signature`, `x-bogus`). Keep the integration in-tab (`browser_run_action` / `replay`) instead of porting it out.

## Mock and rewrite (test the UI against fake or altered responses)

Pass `rules` to `start` or `set-rules` later (Fetch domain, request stage):

```json
{"action":"set-rules","tabId":123,"rules":[
  {"id":"flag-on","match":"/api/features","action":"mock","mockStatus":200,
   "mockBody":"{\"newCheckout\":true}"},
  {"id":"slow-cdn","match":"analytics\\.example\\.com","action":"block"},
  {"id":"ab","match":"/api/search","action":"header","headers":{"x-experiment":"B"}}
]}
```

- `mock` returns your body with `X-Mocked-By: browser-controller` and CORS headers echoing the request Origin; `block` fails with BlockedByClient; `redirect` needs `redirectUrl`; `header` overrides request headers; `log` only records.
- `match` is a URL regex; match-all (`.*`) is rejected on purpose. Scope tightly.
- Unmatched requests are continued automatically. `status` shows `rulesApplied` and `enforcement:"fetch-domain"`.
- Mocking changes what the *page* sees. Never leave rules on a tab the user is actively working in. `set-rules` with `[]` or `stop` removes them.
- Preflight (OPTIONS) requests are not intercepted; same-origin mocks are the reliable case.

## Turning captures into something durable

- **Script**: emit `format:"fetch"` (in-tab) or `format:"curl"` and replace redacted headers with env vars.
- **n8n HTTP Request node**: take method, URL template from `summarize` (`{id}` → expression), JSON body from the request shape, auth from credentials, never from pasted tokens.
- **Contract doc**: paste the `summarize` output into `docs/api/<site>.md` with the date. Endpoints drift; note the capture date.

## Safety rules (non-negotiable)

- Reads redact `Authorization`, `Cookie`, `Set-Cookie`, `*token*`, `*secret*`, `*session*`, `x-api-key` headers and `password/token/secret/api_key/authorization/cookie/session` JSON and query keys. `revealSecrets:true` returns raw values: use it only when the user explicitly asks, use it in memory, and **never** write raw values to files, commits, PRs, memory, or chat summaries.
- This is the user's real session. Prefer reads and replays of GETs. Don't replay purchases, sends, deletes, likes, follows, or anything that spends money or messages a person without the user's explicit go-ahead in this conversation.
- Respect site terms and rate limits; do not loop replay faster than a human would click.
- Capture only the tab you were asked to look at; stop when done.

## Limits to remember

Session state lives in the extension service worker's memory (500 entries / ~32 MB per tab, oldest evicted). A service-worker restart, DevTools attach, or navigation to a protected page ends capture: `status` shows `detached`. Restart with `start`.
