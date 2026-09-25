import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');

describe('managed daemon deployment contract', () => {
  it('supports a connect-only thin-client mode', () => {
    const source = fs.readFileSync(path.join(root, 'mcp-server/src/index.ts'), 'utf8');
    expect(source).toContain('BROWSER_CONTROLLER_DAEMON_MODE');
    expect(source).toContain('CONNECT_ONLY_DAEMON');
    expect(source).toContain('waiting for managed daemon');
  });

  it('configures the bridge to depend on and connect to the systemd daemon', () => {
    const unit = fs.readFileSync(path.join(root, 'deploy/systemd/browser-controller-bridge.service'), 'utf8');
    expect(unit).toContain('Requires=browser-controller-daemon.service');
    expect(unit).toContain('After=network.target browser-controller-daemon.service');
    expect(unit).toContain('BROWSER_CONTROLLER_DAEMON_MODE=connect');
  });
});
