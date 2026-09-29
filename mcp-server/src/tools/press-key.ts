import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const pressKeyTool: ToolDefinition = {
  name: 'browser_press_key',
  summary: 'Press a keyboard key (Enter, Tab, Escape, etc.)',  description:
    'Press a keyboard key or combination (Enter, Escape, Tab, ArrowDown, etc). Accepts combos as "ctrl+a" or via modifiers. Real key press over CDP: Tab moves focus (fires blur/focusout), Enter submits, arrows drive autocomplete menus.',
  inputSchema: z.object({
    tabId: requireTabId(),
    key: z.string().describe('Key name (e.g. "Enter", "Escape", "Tab", "ArrowDown", "a")'),
    modifiers: z
      .array(z.enum(['ctrl', 'alt', 'shift', 'meta']))
      .optional()
      .describe('Modifier keys to hold'),
    ref: z.string().optional().describe('Element ref to focus before pressing'),
    selector: z.string().optional().describe('CSS selector to focus before pressing'),
    trusted: z.boolean().optional().describe('Real (isTrusted) input over CDP — default. false = synthetic DOM events, no debugger banner.'),
  }),
  timeoutMs: 5_000,
  handler: forwardHandler('browser_press_key'),
};
