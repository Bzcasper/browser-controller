import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const hoverTool: ToolDefinition = {
  name: 'browser_hover',
  summary: 'Hover over an element',  description: 'Hover over an element to trigger tooltips, dropdown menus, or hover states',
  inputSchema: z.object({
    tabId: requireTabId(),
    ref: z.string().optional().describe('Element reference from snapshot'),
    selector: z.string().optional().describe('CSS selector for the element'),
    trusted: z.boolean().optional().describe('Real (isTrusted) mouse move over CDP — default. false = synthetic DOM events, no debugger banner.'),
  }),
  timeoutMs: 5_000,
  handler: forwardHandler('browser_hover'),
};
