#!/usr/bin/env node
/**
 * bctl — one command to set up, start, connect and diagnose Browser Controller.
 *
 *   bctl setup            build + install systemd units + start + connect agents + launcher
 *   bctl up | down | restart | status
 *   bctl connect [agent…|all]   register the MCP server with agents (no args = show state)
 *   bctl doctor           read-only health check (exit 1 on failures)
 *   bctl call <tool> [json]     call one browser tool from the shell
 *   bctl install-service [--bridge] | install-launcher | install-cli | install-skills
 *
 * Systemd owns the daemon when the user unit is installed; otherwise the
 * plain scripts/daemon.mjs lifecycle is used. Never both (they fight for the lock).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = os.homedir();
const STATE = process.env.BC_STATE_DIR || path.join(HOME, '.browser-controller');
const DIST = path.join(ROOT, 'mcp-server', 'dist');
const INDEX = path.join(DIST, 'index.js');
const UNIT_DIR = path.join(HOME, '.config', 'systemd', 'user');
const DAEMON_UNIT = 'browser-controller-daemon.service';
const BRIDGE_UNIT = 'browser-controller-bridge.service';
const PORT = Number(process.env.WS_PORT || 7225);
const BRIDGE_PORT = 9090;
const SELF = fileURLToPath(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tty = process.stdout.isTTY;
const c = (n, s) => (tty ? `\x1b[${n}m${s}\x1b[0m` : s);
const ok = (s) => console.log(`${c(32, '✓')} ${s}`);
const bad = (s) => console.log(`${c(31, '✗')} ${s}`);
const warn = (s) => console.log(`${c(33, '!')} ${s}`);
const info = (s) => console.log(`  ${s}`);

// ---- helpers ---------------------------------------------------------------
function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', cwd: ROOT, ...opts });
}
function sc(...args) {
  const env = { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${os.userInfo().uid}` };
  return run('systemctl', ['--user', ...args], { env });
}
const unitInstalled = () => fs.existsSync(path.join(UNIT_DIR, DAEMON_UNIT));
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const daemonInfo = () => readJson(path.join(STATE, 'daemon.json'));
const pkgVersion = () => readJson(path.join(ROOT, 'package.json'))?.version;

function newestMtime(dir) {
  let newest = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    newest = Math.max(newest, e.isDirectory() ? newestMtime(p) : fs.statSync(p).mtimeMs);
  }
  return newest;
}
function distStatus() {
  if (!fs.existsSync(INDEX) || !fs.existsSync(path.join(DIST, 'protocol.js'))) return 'missing';
  const src = path.join(ROOT, 'mcp-server', 'src');
  return newestMtime(src) > fs.statSync(path.join(DIST, 'daemon.js')).mtimeMs ? 'stale' : 'fresh';
}
function build() {
  console.log('building…');
  const r = run('npm', ['run', 'build'], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('build failed');
}

function daemonStatus() {
  return new Promise((resolve) => {
    const secret = readJson(path.join(STATE, 'enrollment.json'))?.secret;
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/status', timeout: 2500, headers: { 'X-BC-Enrollment': secret || '' } }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
async function waitForDaemon(ms = 12000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const s = await daemonStatus(); if (s) return s; await sleep(300); }
  return null;
}
function listeners() {
  const out = run('ss', ['-ltnH']).stdout || '';
  return out.split('\n').map((l) => l.trim().split(/\s+/)[3]).filter(Boolean);
}
function notify(msg) { if (process.argv.includes('--notify')) run('notify-send', ['-a', 'Browser Controller', 'Browser Controller', msg]); }

// ---- lifecycle -------------------------------------------------------------
async function stopStrayDaemon() {
  // A daemon that systemd does not own holds the lock and crash-loops the unit.
  const inf = daemonInfo();
  if (!inf?.pid || !alive(inf.pid)) return;
  const main = Number((sc('show', DAEMON_UNIT, '-p', 'MainPID', '--value').stdout || '0').trim());
  if (main !== inf.pid) {
    warn(`stopping stray daemon pid ${inf.pid} (not owned by systemd)`);
    try { process.kill(inf.pid, 'SIGTERM'); } catch {}
    for (let i = 0; i < 30 && alive(inf.pid); i++) await sleep(150);
  }
}
async function up({ restart = false } = {}) {
  const ds = distStatus();
  let rebuilt = false;
  if (ds !== 'fresh') { build(); rebuilt = true; }
  if (unitInstalled()) {
    await stopStrayDaemon();
    sc('reset-failed', DAEMON_UNIT);
    const cmd = restart || rebuilt ? 'restart' : 'start';
    const r = sc(cmd, DAEMON_UNIT);
    if (r.status !== 0) throw new Error(`systemctl ${cmd} failed: ${r.stderr}`);
    if (fs.existsSync(path.join(UNIT_DIR, BRIDGE_UNIT)) && sc('is-enabled', BRIDGE_UNIT).status === 0) sc(cmd, BRIDGE_UNIT);
  } else {
    const r = run('node', [path.join(ROOT, 'scripts', 'daemon.mjs'), restart || rebuilt ? 'restart' : 'start'], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('daemon start failed');
  }
  const s = await waitForDaemon();
  if (!s) { bad('daemon did not come up — run `bctl doctor`'); notify('daemon failed to start'); process.exitCode = 1; return; }
  ok(`daemon up (${unitInstalled() ? 'systemd' : 'standalone'}) on 127.0.0.1:${PORT}`);
  if (s.extension?.connected) ok('Chrome extension connected');
  else warn('Chrome extension NOT connected — open Chrome (with the extension installed) or reload it at chrome://extensions');
  notify(s.extension?.connected ? 'running, extension connected' : 'running, extension not connected');
}
async function down() {
  if (unitInstalled()) { sc('stop', BRIDGE_UNIT); sc('stop', DAEMON_UNIT); ok('stopped systemd units'); }
  else run('node', [path.join(ROOT, 'scripts', 'daemon.mjs'), 'stop'], { stdio: 'inherit' });
  notify('stopped');
}
async function status() {
  const s = await daemonStatus();
  if (!s) { bad('daemon is not running'); process.exitCode = 1; return; }
  ok(`daemon up ${Math.round(s.uptimeMs / 1000)}s · extension ${s.extension?.connected ? 'connected' : 'NOT connected'}`);
  info(`agents: ${(s.agents || []).map((a) => a.name).join(', ') || '(none)'}`);
}

// ---- connect agents --------------------------------------------------------
const entryFor = (agent) => ({ command: process.execPath, args: [INDEX, '--agent', agent] });
const AGENTS = {
  'claude-desktop': { kind: 'json', file: path.join(HOME, '.config', 'Claude', 'claude_desktop_config.json'), key: 'mcpServers' },
  cursor: { kind: 'json', file: path.join(HOME, '.cursor', 'mcp.json'), key: 'mcpServers' },
  windsurf: { kind: 'json', file: path.join(HOME, '.codeium', 'windsurf', 'mcp_config.json'), key: 'mcpServers' },
  'claude-code': { kind: 'claude-code', file: path.join(HOME, '.claude.json') },
  codex: { kind: 'toml', file: path.join(HOME, '.codex', 'config.toml') },
};
function agentState(name) {
  const a = AGENTS[name];
  if (!fs.existsSync(a.file)) return { state: 'absent', note: `no ${a.file}` };
  if (a.kind === 'toml') {
    const t = fs.readFileSync(a.file, 'utf8');
    if (!t.includes('[mcp_servers.browser-controller]')) return { state: 'missing' };
    return t.includes(INDEX) ? { state: 'connected' } : { state: 'stale', note: 'points at a different path' };
  }
  const j = readJson(a.file);
  const e = (a.kind === 'claude-code' ? j?.mcpServers : j?.[a.key])?.['browser-controller'];
  if (!e) return { state: 'missing' };
  return (e.args || []).includes(INDEX) ? { state: 'connected' } : { state: 'stale', note: 'points at a different path' };
}
function connectOne(name) {
  const a = AGENTS[name];
  const st = agentState(name);
  if (st.state === 'connected') return ok(`${name}: already connected`);
  if (a.kind === 'claude-code') {
    const r = run('claude', ['mcp', 'add', '--scope', 'user', 'browser-controller', '--', process.execPath, INDEX, '--agent', name]);
    if (r.error) return warn(`${name}: 'claude' CLI not found — run: claude mcp add --scope user browser-controller -- node ${INDEX} --agent ${name}`);
    return r.status === 0 ? ok(`${name}: connected`) : warn(`${name}: ${(r.stderr || r.stdout).trim().split('\n')[0]}`);
  }
  fs.mkdirSync(path.dirname(a.file), { recursive: true });
  if (fs.existsSync(a.file)) fs.copyFileSync(a.file, `${a.file}.bak-bctl-${Date.now()}`);
  if (a.kind === 'toml') {
    if (st.state === 'stale') return warn(`${name}: existing entry points elsewhere — edit ${a.file} by hand`);
    const e = entryFor(name);
    fs.appendFileSync(a.file, `\n[mcp_servers.browser-controller]\ncommand = ${JSON.stringify(e.command)}\nargs = ${JSON.stringify(e.args)}\n`);
    return ok(`${name}: connected (restart Codex)`);
  }
  const j = readJson(a.file) || {};
  j[a.key] = { ...(j[a.key] || {}), 'browser-controller': entryFor(name) };
  fs.writeFileSync(a.file, JSON.stringify(j, null, 2) + '\n');
  ok(`${name}: ${st.state === 'stale' ? 'updated' : 'connected'} (restart the app)`);
}
function connect(targets) {
  if (!targets.length) {
    for (const n of Object.keys(AGENTS)) {
      const s = agentState(n);
      (s.state === 'connected' ? ok : s.state === 'absent' ? info : warn)(`${n.padEnd(15)} ${s.state}${s.note ? ` — ${s.note}` : ''}`);
    }
    return;
  }
  const list = targets.includes('all') ? Object.keys(AGENTS).filter((n) => agentState(n).state !== 'absent' || n === 'cursor') : targets;
  for (const n of list) { if (!AGENTS[n]) bad(`unknown agent: ${n} (${Object.keys(AGENTS).join(', ')})`); else connectOne(n); }
}

// ---- install ---------------------------------------------------------------
function daemonUnit() {
  return `[Unit]
Description=Browser Controller shared daemon
After=graphical-session.target

[Service]
Type=simple
WorkingDirectory=${ROOT}
Environment=HOME=${HOME}
ExecStart=${process.execPath} ${path.join(DIST, 'daemon.js')}
Restart=always
RestartSec=2
NoNewPrivileges=true

[Install]
WantedBy=default.target
`;
}
function bridgeUnit(proxy) {
  return `[Unit]
Description=Browser Controller MCP stdio-to-SSE bridge (for n8n/MCPHub)
Requires=${DAEMON_UNIT}
After=network.target ${DAEMON_UNIT}

[Service]
# Loopback by default. To let another machine (e.g. n8n on bobby-nuc) connect,
# set BC_BRIDGE_HOST to a specific LAN address via a drop-in — never 0.0.0.0:
# the bridge has no authentication of its own.
Environment=BC_BRIDGE_HOST=127.0.0.1
Environment=PATH=${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin
Environment=BROWSER_CONTROLLER_DAEMON_MODE=connect
ExecStart=${proxy} node ${INDEX} --port ${BRIDGE_PORT} --host \${BC_BRIDGE_HOST} -e MCP_AGENT_NAME n8n-bridge -e BROWSER_CONTROLLER_DAEMON_MODE connect
Restart=always
RestartSec=3
StandardOutput=append:${STATE}/mcp-bridge.log
StandardError=append:${STATE}/mcp-bridge.log
NoNewPrivileges=true

[Install]
WantedBy=default.target
`;
}
function installService(withBridge) {
  fs.mkdirSync(UNIT_DIR, { recursive: true });
  fs.writeFileSync(path.join(UNIT_DIR, DAEMON_UNIT), daemonUnit());
  const units = [DAEMON_UNIT];
  const proxy = run('sh', ['-c', 'command -v mcp-proxy']).stdout.trim() || path.join(HOME, '.local', 'bin', 'mcp-proxy');
  if (withBridge || fs.existsSync(path.join(UNIT_DIR, BRIDGE_UNIT))) {
    if (!fs.existsSync(proxy)) warn('mcp-proxy not found (pipx install mcp-proxy) — skipping bridge unit');
    else { fs.writeFileSync(path.join(UNIT_DIR, BRIDGE_UNIT), bridgeUnit(proxy)); units.push(BRIDGE_UNIT); }
  }
  sc('daemon-reload');
  for (const u of units) sc('enable', u);
  ok(`installed systemd units: ${units.join(', ')}`);
}
function installCli() {
  const bin = path.join(HOME, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const link = path.join(bin, 'bctl');
  try { fs.unlinkSync(link); } catch {}
  fs.symlinkSync(SELF, link);
  fs.chmodSync(SELF, 0o755);
  ok(`installed ${link}`);
}
function installSkills() {
  const src = path.join(ROOT, 'skills');
  if (!fs.existsSync(src)) { warn('no skills/ directory in the repo'); return; }
  const names = fs.readdirSync(src).filter((n) => fs.existsSync(path.join(src, n, 'SKILL.md')));
  const targets = ['.agents', '.claude', '.codex'].map((d) => path.join(HOME, d, 'skills')).filter((d) => fs.existsSync(path.dirname(d)));
  for (const dir of targets) {
    fs.mkdirSync(dir, { recursive: true });
    for (const n of names) {
      const link = path.join(dir, n);
      try {
        const st = fs.lstatSync(link);
        if (!st.isSymbolicLink()) { warn(`${link} exists and is not a symlink; left alone`); continue; }
        fs.unlinkSync(link);
      } catch {}
      fs.symlinkSync(path.join(src, n), link);
    }
    ok(`skills linked into ${dir} (${names.join(', ')})`);
  }
}
function installLauncher() {
  const dir = path.join(HOME, '.local', 'share', 'applications');
  fs.mkdirSync(dir, { recursive: true });
  const bctl = `${process.execPath} ${SELF}`;
  fs.writeFileSync(path.join(dir, 'browser-controller.desktop'), `[Desktop Entry]
Type=Application
Name=Browser Controller
Comment=Start Browser Controller and connect agents
Exec=${bctl} up --notify
Icon=${fs.existsSync(path.join(ROOT, 'assets', 'logo.png')) ? path.join(ROOT, 'assets', 'logo.png') : 'applications-internet'}
Terminal=false
Categories=Development;
Actions=stop;connect;doctor;

[Desktop Action stop]
Name=Stop
Exec=${bctl} down --notify

[Desktop Action connect]
Name=Connect all agents
Exec=${bctl} connect all

[Desktop Action doctor]
Name=Run doctor
Exec=x-terminal-emulator -e sh -c '${bctl} doctor; read -p "press enter" _'
`);
  ok('installed desktop launcher (search "Browser Controller"; right-click for Stop / Connect / Doctor)');
}
async function setup() {
  if (distStatus() !== 'fresh') build();
  installCli();
  installService(false);
  await up({ restart: true });
  console.log('');
  connect(['all']);
  installLauncher();
  installSkills();
  console.log('');
  await doctor();
}

// ---- doctor ----------------------------------------------------------------
async function doctor() {
  let failed = 0;
  const fail = (s) => { failed++; bad(s); };
  const major = Number(process.versions.node.split('.')[0]);
  major >= 20 ? ok(`node ${process.versions.node}`) : fail(`node ${process.versions.node} (need >= 20)`);

  const ds = distStatus();
  ds === 'fresh' ? ok('dist/ is built and up to date') : fail(`dist/ is ${ds} — run: bctl up (rebuilds and restarts)`);

  const inf = daemonInfo();
  const st = await daemonStatus();
  if (!st) fail('daemon not responding on 127.0.0.1:' + PORT);
  else {
    ok(`daemon responding (pid ${inf?.pid}, v${inf?.version})`);
    if (inf?.version && inf.version !== pkgVersion()) fail(`daemon v${inf.version} ≠ package v${pkgVersion()} — bctl restart`);
    st.extension?.connected ? ok('Chrome extension connected') : fail('Chrome extension not connected — start Chrome / reload the extension');
  }
  if (unitInstalled()) {
    const state = (sc('show', DAEMON_UNIT, '-p', 'ActiveState', '--value').stdout || '').trim();
    const nrest = Number((sc('show', DAEMON_UNIT, '-p', 'NRestarts', '--value').stdout || '0').trim());
    const main = Number((sc('show', DAEMON_UNIT, '-p', 'MainPID', '--value').stdout || '0').trim());
    if (state !== 'active') fail(`systemd daemon unit is "${state}" (restarts: ${nrest})`);
    else if (inf?.pid && main !== inf.pid) fail(`daemon pid ${inf.pid} is not the systemd one (${main}) — a stray daemon owns the lock; run: bctl up`);
    else ok(`systemd owns the daemon (restarts: ${nrest})`);
  } else warn('systemd units not installed — daemon will not survive reboot (bctl install-service)');

  const ls = listeners();
  const exposed = (port) => ls.filter((a) => a.endsWith(':' + port) && /^(0\.0\.0\.0|\*|\[::\])/.test(a));
  exposed(PORT).length ? fail(`port ${PORT} is exposed beyond loopback`) : ok(`port ${PORT} is loopback-only`);
  if (ls.some((a) => a.endsWith(':' + BRIDGE_PORT))) exposed(BRIDGE_PORT).length ? fail(`bridge :${BRIDGE_PORT} listens on all interfaces with no auth`) : ok(`bridge :${BRIDGE_PORT} is not exposed to the network`);

  for (const n of Object.keys(AGENTS)) {
    const s = agentState(n);
    if (s.state === 'stale') fail(`${n}: MCP entry points at a different path — bctl connect ${n}`);
    else if (s.state === 'connected') ok(`${n}: connected`);
  }
  console.log(failed ? `\n${failed} problem(s) found.` : '\nAll good.');
  process.exitCode = failed ? 1 : 0;
}

// ---- call ------------------------------------------------------------------
async function call(args) {
  const [tool, json] = args.filter((a) => !a.startsWith('--'));
  const ai = args.indexOf('--agent');
  const agent = ai >= 0 ? args[ai + 1] : 'bctl';
  if (!tool) throw new Error("usage: bctl call <tool> '<json>' [--agent name]");
  const sdk = (p) => import(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'client', p));
  const { Client } = await sdk('index.js');
  const { StdioClientTransport } = await sdk('stdio.js');
  const client = new Client({ name: 'bctl', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [INDEX, '--agent', agent] }));
  try {
    const r = await client.callTool({ name: tool, arguments: json ? JSON.parse(json) : {} });
    console.log((r.content || []).map((x) => (x.type === 'text' ? x.text : JSON.stringify(x))).join('\n'));
    if (r.isError) process.exitCode = 1;
  } finally { await client.close(); }
}

// ---- main ------------------------------------------------------------------
const HELP = `bctl — Browser Controller control

  bctl setup                 one-shot: build, install service + CLI + launcher, start, connect agents, doctor
  bctl up | down | restart   start / stop / restart (rebuilds first if dist is stale)
  bctl status                daemon + extension + connected agents
  bctl connect [agent…|all]  register with ${Object.keys(AGENTS).join(', ')} (no args: show state)
  bctl doctor                health check (exit 1 on problems)
  bctl call <tool> '<json>'  call a browser tool from the shell
  bctl install-service [--bridge] | install-launcher | install-cli
  bctl install-skills        link the agent skills in skills/ into ~/.agents, ~/.claude, ~/.codex`;
const [cmd = 'help', ...rest] = process.argv.slice(2);
try {
  if (cmd === 'setup') await setup();
  else if (cmd === 'up') await up();
  else if (cmd === 'restart') await up({ restart: true });
  else if (cmd === 'down') await down();
  else if (cmd === 'status') await status();
  else if (cmd === 'connect') connect(rest.filter((a) => !a.startsWith('--')));
  else if (cmd === 'doctor') await doctor();
  else if (cmd === 'call') await call(rest);
  else if (cmd === 'install-service') installService(rest.includes('--bridge'));
  else if (cmd === 'install-launcher') installLauncher();
  else if (cmd === 'install-cli') installCli();
  else if (cmd === 'install-skills') installSkills();
  else console.log(HELP);
} catch (e) { bad(e.message); process.exitCode = 1; }
