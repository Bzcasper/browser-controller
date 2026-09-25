import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');

describe('page console bridge', () => {
  it('loads a MAIN-world page bridge before the isolated relay', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension/manifest.json'), 'utf8'));
    expect(manifest.content_scripts[0]).toMatchObject({ js: ['page-console.js'], world: 'MAIN', run_at: 'document_start' });
    expect(manifest.content_scripts[1]).toMatchObject({ js: ['content.js'], run_at: 'document_start' });
  });

  it('uses a tagged window message contract and validates it in the relay', () => {
    const page = fs.readFileSync(path.join(root, 'extension/page-console.js'), 'utf8');
    const relay = fs.readFileSync(path.join(root, 'extension/content.js'), 'utf8');
    expect(page).toContain('__browserControllerConsole: true');
    expect(relay).toContain('data.__browserControllerConsole !== true');
    expect(relay).toContain('event.source !== window');
  });
});
