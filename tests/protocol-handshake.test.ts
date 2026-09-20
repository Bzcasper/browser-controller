import { describe, expect, it } from 'vitest';
import {
  APP_PROTOCOL_VERSION,
  DAEMON_CAPABILITIES,
  buildDaemonHello,
  validateProtocolVersion,
} from '../mcp-server/src/protocol.js';
import {
  APP_PROTOCOL_VERSION as EXTENSION_PROTOCOL_VERSION,
  EXTENSION_CAPABILITIES,
  buildExtensionHelloAck,
  validateDaemonHello,
} from '../extension/lib/protocol.js';

describe('cross-process protocol contract', () => {
  it('keeps daemon and extension protocol majors in sync', () => {
    expect(APP_PROTOCOL_VERSION).toBe(1);
    expect(EXTENSION_PROTOCOL_VERSION).toBe(APP_PROTOCOL_VERSION);
  });

  it('advertises versioned daemon capabilities', () => {
    const hello = buildDaemonHello('2.2.0');
    expect(hello).toEqual(expect.objectContaining({
      type: 'daemonHello',
      protocolVersion: APP_PROTOCOL_VERSION,
      appVersion: '2.2.0',
    }));
    expect(hello.capabilities).toEqual(DAEMON_CAPABILITIES);
    expect(hello.capabilities.length).toBeGreaterThan(0);
  });

  it('rejects an explicitly incompatible protocol major but marks an absent one as legacy', () => {
    expect(validateProtocolVersion(undefined)).toEqual(expect.objectContaining({ compatible: true, legacy: true }));
    expect(validateProtocolVersion(APP_PROTOCOL_VERSION)).toEqual(expect.objectContaining({ compatible: true, legacy: false }));
    expect(validateProtocolVersion(APP_PROTOCOL_VERSION + 1)).toEqual(expect.objectContaining({ compatible: false }));
  });

  it('builds and validates an extension acknowledgement with capabilities', () => {
    const daemonHello = buildDaemonHello('2.2.0');
    expect(validateDaemonHello(daemonHello)).toEqual(expect.objectContaining({ compatible: true, legacy: false }));

    const ack = buildExtensionHelloAck('2.2.0');
    expect(ack).toEqual(expect.objectContaining({
      type: 'extensionHelloAck',
      protocolVersion: APP_PROTOCOL_VERSION,
      appVersion: '2.2.0',
    }));
    expect(ack.capabilities).toEqual(EXTENSION_CAPABILITIES);
  });

  it('rejects daemon hello frames from a different major', () => {
    expect(validateDaemonHello({
      type: 'daemonHello',
      protocolVersion: APP_PROTOCOL_VERSION + 1,
      appVersion: '999.0.0',
      capabilities: [],
    })).toEqual(expect.objectContaining({ compatible: false }));
  });
});
