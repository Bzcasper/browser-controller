import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const clickTool: ToolDefinition = {
  name: 'browser_click',
  summary: 'Click an element by ref or CSS selector',
  description: 'Click an element on the page using a ref from snapshot or a CSS selector. Uses a real mouse click over CDP (isTrusted events, real focus, default actions — works in background windows); falls back to synthetic DOM events if the debugger cannot attach.',
  inputSchema: z.object({
    tabId: requireTabId(),
    ref: z.string().optional().describe('Element reference from snapshot (e.g. "e12")'),
    selector: z.string().optional().describe('CSS selector for the element'),
    button: z.enum(['left', 'right', 'middle']).optional().default('left'),
    doubleClick: z.boolean().optional().default(false),
    trusted: z.boolean().optional().describe('Real (isTrusted) input over CDP — default. false = synthetic DOM events, no debugger banner.'),
  }).superRefine((params, ctx) => {
    if (!params.ref && !params.selector) {
      ctx.addIssue({ code: 'custom', message: 'ref or selector is required', path: ['ref'] });
    }
  }),
  timeoutMs: 10_000,
  handler: forwardHandler('browser_click'),
};
