#!/usr/bin/env node
/**
 * Explicit lifecycle CLI for the single authoritative Browser Controller daemon.
 * MCP clients may still auto-start it, but deployment/restart should use these
 * commands so only this process manager is responsible for the runtime.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'mcp-server', 'dist', 'daemon.js');
const stateDir = process.env.BC_STATE_DIR || path.join(os.homedir(), '.browser-controller');
const infoFile = path.join(stateDir, 'daemon.json');
const lockFile = path.join(stateDir, 'daemon.lock');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function readInfo() {
  try { return JSON.parse(fs.readFileSync(infoFile, 'utf8')); } catch { return null; }
}
function live(info) {
  if (!info?.pid) return false;
  try { process.kill(info.pid, 0); return true; } catch { return false; }
}
async function waitForStart(timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const info = readInfo();
    if (live(info)) return info;
    await sleep(100);
  }
  throw new Error('daemon did not become ready; see daemon.log');
}
async function start() {
  if (!fs.existsSync(entry)) throw new Error('daemon build missing; run `npm run build` first');
  const existing = readInfo();
  if (live(existing)) {
    console.log(`daemon already running (pid ${existing.pid}) on ${existing.host}:${existing.port}`);
    return;
  }
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const log = fs.openSync(path.join(stateDir, 'daemon.log'), 'a', 0o600);
  const child = spawn(process.execPath, [entry], { detached: true, stdio: ['ignore', log, log], env: process.env });
  child.unref();
  const info = await waitForStart();
  console.log(`daemon started (pid ${info.pid})`);
  console.log(`MCP stdio entry: ${path.join(root, 'mcp-server', 'dist', 'index.js')}`);
  console.log(`daemon endpoints: http/ws://${info.host}:${info.port} (WS + /pair /status /kill); IPC ${info.socket}`);
}
async function stop() {
  const info = readInfo();
  if (!live(info)) {
    for (const file of [infoFile, lockFile]) { try { fs.unlinkSync(file); } catch {} }
    console.log('daemon is not running');
    return;
  }
  process.kill(info.pid, 'SIGTERM');
  const end = Date.now() + 5000;
  while (Date.now() < end && live(info)) await sleep(100);
  if (live(info)) throw new Error(`daemon pid ${info.pid} did not stop`);
  console.log('daemon stopped');
}
const command = process.argv[2] || 'status';
if (command === 'start') await start();
else if (command === 'stop') await stop();
else if (command === 'restart') { await stop(); await start(); }
else if (command === 'status') {
  const info = readInfo();
  if (!live(info)) { console.log('daemon is not running'); process.exitCode = 1; }
  else console.log(JSON.stringify({ ...info, running: true }, null, 2));
} else throw new Error(`unknown command: ${command}`);
