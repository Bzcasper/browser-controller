import { z } from 'zod';
import type { ToolDefinition, ToolResult } from './types.js';
import { optionalTabId } from './types.js';
import { toolMap } from './index.js';
import { parseToolParams } from '../register-tools.js';

/** Tools that must not run inside a batch (recursion / discovery only). */
const NOT_BATCHABLE = new Set(['browser_batch', 'browser_tools']);
const MAX_STEPS = 50;

/**
 * Run several browser tool calls in one round-trip (like Claude in Chrome's
 * browser_batch). Steps run strictly in order; the batch stops at the first
 * failing step so the agent never acts on a page that didn't reach the
 * expected state. Each step is validated and executed exactly as if it had
 * been called on its own, so per-tool timeouts, retries and error payloads
 * are unchanged.
 */
export const batchTool: ToolDefinition = {
  name: 'browser_batch',
  summary: 'Run several browser actions in one call (stops at first error)',
  description:
    'Run a sequence of browser tool calls in ONE call, in order, and get all their results back. Use it to cut round-trips when you already know the next steps, e.g. click a field → type → press Tab → wait → read text. Stops at the first failing step (remaining steps are skipped) unless continueOnError is true. A top-level tabId is applied to every step that does not set its own. Steps cannot be nested batches.',
  inputSchema: z.object({
    tabId: optionalTabId().describe('Default tab id for every step that does not set its own tabId'),
    actions: z
      .array(z.object({
        tool: z.string().describe('Tool name, e.g. "browser_click"'),
        params: z.record(z.string(), z.unknown()).optional().describe('That tool\'s arguments'),
      }))
      .min(1)
      .max(MAX_STEPS)
      .describe(`Steps to run in order (max ${MAX_STEPS})`),
    continueOnError: z.boolean().optional().default(false).describe('Keep going after a failing step'),
  }),
  // Longest a single MCP call may reasonably take; each step keeps its own
  // transport timeout.
  timeoutMs: 300_000,
  async handler(host, params) {
    const { tabId, actions, continueOnError } = params as {
      tabId?: number;
      actions: Array<{ tool: string; params?: Record<string, unknown> }>;
      continueOnError: boolean;
    };
    const content: ToolResult['content'] = [];
    let failed = 0;
    let ran = 0;
    for (const [i, step] of actions.entries()) {
      const label = `[${i + 1}/${actions.length}] ${step.tool}`;
      const def = toolMap.get(step.tool);
      let result: ToolResult;
      if (!def || NOT_BATCHABLE.has(step.tool)) {
        result = { content: [{ type: 'text', text: `Error: ${def ? 'cannot be used inside a batch' : 'unknown tool'}` }], isError: true };
      } else {
        const stepParams = { ...(step.params || {}) };
        if (tabId !== undefined && stepParams.tabId === undefined && 'tabId' in def.inputSchema.shape) {
          stepParams.tabId = tabId;
        }
        try {
          result = await def.handler(host, parseToolParams(def, stepParams));
        } catch (err) {
          result = { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
        }
      }
      ran++;
      content.push({ type: 'text', text: `${label} ${result.isError ? 'FAILED' : 'ok'}` });
      content.push(...result.content);
      if (result.isError) {
        failed++;
        if (!continueOnError) {
          const skipped = actions.length - i - 1;
          if (skipped) content.push({ type: 'text', text: `Stopped: ${skipped} remaining step(s) skipped.` });
          break;
        }
      }
    }
    return {
      content: [{ type: 'text', text: `batch: ${ran - failed}/${actions.length} steps ok` }, ...content],
      ...(failed ? { isError: true } : {}),
    };
  },
};
