#!/usr/bin/env node
// Generic browser-controller MCP caller.
// Usage: node bc.mjs <tool> '<json-params>' [agentName]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [tool, paramsJson, agent = "gmail-cleanup"] = process.argv.slice(2);
if (!tool) {
  console.error("usage: bc.mjs <tool> '<json-params>' [agentName]");
  process.exit(2);
}
const params = paramsJson ? JSON.parse(paramsJson) : {};

const c = new Client({ name: "bc-cli", version: "1" });
const t = new StdioClientTransport({
  command: "node",
  args: ["/home/bobby/projects/browser-controller/mcp-server/dist/index.js", "--agent", agent],
});
await c.connect(t);
try {
  const r = await c.callTool({ name: tool, arguments: params });
  const text = (r.content || []).map((x) => (x.type === "text" ? x.text : JSON.stringify(x))).join("\n");
  console.log(text);
} catch (e) {
  console.error("ERR:", e.message);
  process.exitCode = 1;
} finally {
  await c.close();
}
