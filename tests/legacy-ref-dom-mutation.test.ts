import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

describe('legacy refs do not mutate page DOM', () => {
  it('does not stamp data-mcp-ref attributes from inspection handlers', () => {
    const source = fs.readFileSync(path.join(ROOT, 'extension', 'handlers', 'inspection.js'), 'utf8');
    expect(source).not.toMatch(/\.setAttribute\(\s*['"]data-mcp-ref['"]/);
  });
});
