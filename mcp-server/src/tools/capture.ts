import { z } from "zod";
import type { ToolDefinition } from "./types.js";
import { forwardHandler, requireTabId } from "./types.js";

const ruleSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  match: z.string().min(1).max(500).describe("URL regex (match-all is rejected)"),
  types: z
    .array(z.string().min(1).max(32))
    .max(20)
    .optional()
    .describe("CDP resource types, e.g. Fetch, XHR, Document, Script"),
  action: z.enum(["log", "block", "redirect", "header", "mock"]),
  redirectUrl: z.string().max(2000).optional(),
  headers: z
    .record(z.string(), z.string())
    .optional()
    .describe("header action: request headers to set; mock action: may set Content-Type"),
  mockStatus: z.number().int().min(100).max(599).optional(),
  mockBody: z.string().max(20_000).optional(),
  enabled: z.boolean().optional().default(true),
});

export const captureTool: ToolDefinition = {
  name: "browser_capture",
  summary: "Record tab API traffic with bodies; mock, replay, HAR",
  description: `Record what a page's JavaScript says to its servers, using the real logged-in session (CDP Network domain).
Unlike browser_network (URLs only), this captures request/response headers and bodies, WebSocket frames and SSE events.

Typical flow: start (reload:true) → drive the UI → summarize → list/get the interesting calls → replay or export-har.

Actions:
- start: begin capture. Options: urlFilter (regex), types (default Fetch,XHR,WebSocket,EventSource; ["*"] = everything), bodies (default true), includeBinary, maxBodyBytes (default 262144), reload (catch page-load traffic), rules (live mock/header/block/redirect).
- status | stop | clear: session control. Data stays readable after stop until clear.
- list: rows (id, method, url, status, mime, ms). Filters: filter, method, type, status (200 | "4xx" | "error"), hasBody, since (poll for new ids), limit/offset, preview (chars of body).
- get: one entry in full. part: all|request|response|frames|events. format: json|curl|fetch.
- summarize: endpoint inventory — templated paths ({id}, {uuid}), status counts, query params, request/response JSON shapes.
- export-har: HAR 1.2 including headers and bodies.
- replay: re-send a captured call from inside the tab (same cookies/origin). Non-GET needs confirmMutating:true. overrides: url, method, headers, body.
- set-rules: change live rules (mock/header/block/redirect via the Fetch domain; empty array clears).

Secrets: Authorization/Cookie/token headers and password/token/secret JSON keys are redacted in every read. revealSecrets:true returns raw values — only use when the user asked for them and never paste them into files, commits or chat logs.`,
  inputSchema: z.object({
    tabId: requireTabId(),
    action: z.enum([
      "start",
      "stop",
      "status",
      "list",
      "get",
      "summarize",
      "export-har",
      "replay",
      "set-rules",
      "clear",
    ]),
    urlFilter: z.string().max(500).optional().describe("start: only record URLs matching this regex"),
    types: z.array(z.string().min(1).max(32)).max(20).optional().describe("start: CDP resource types to record"),
    bodies: z.boolean().optional().describe("start: capture response bodies (default true)"),
    includeBinary: z.boolean().optional().describe("start: also keep binary bodies as base64 (default false)"),
    maxBodyBytes: z.number().int().min(1024).max(2_000_000).optional(),
    reload: z.boolean().optional().describe("start: reload the tab after enabling capture"),
    rules: z.array(ruleSchema).max(50).optional().describe("start/set-rules: live request rules"),
    filter: z.string().max(500).optional().describe("URL regex filter for list/summarize/export-har"),
    method: z.string().max(10).optional(),
    type: z.string().max(32).optional(),
    status: z.union([z.number().int(), z.string()]).optional().describe('200, "4xx" or "error"'),
    hasBody: z.boolean().optional(),
    since: z.number().int().optional().describe("list: only entries with id greater than this"),
    limit: z.number().int().min(1).max(500).optional(),
    offset: z.number().int().min(0).optional(),
    preview: z.number().int().min(0).max(2000).optional().describe("list: chars of response body per row"),
    id: z.number().int().optional().describe("get/replay: entry id from list"),
    part: z.enum(["all", "request", "response", "frames", "events"]).optional(),
    format: z.enum(["json", "curl", "fetch"]).optional(),
    maxChars: z.number().int().min(100).max(200_000).optional().describe("cap for returned body text"),
    revealSecrets: z.boolean().optional().describe("Return raw headers/tokens instead of [redacted]"),
    overrides: z
      .object({
        url: z.string().max(4000).optional(),
        method: z.string().max(10).optional(),
        headers: z.record(z.string(), z.string()).optional(),
        body: z.string().max(1_000_000).optional(),
      })
      .optional()
      .describe("replay: change the request before re-sending"),
    confirmMutating: z.boolean().optional().describe("replay: required for non-GET/HEAD methods"),
  }),
  // start/stop/clear/replay/set-rules mutate state; the whole tool is non-idempotent.
  idempotent: false,
  timeoutMs: 30_000,
  handler: forwardHandler("browser_capture"),
};
