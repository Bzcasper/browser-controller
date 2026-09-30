---
name: browser-controller-setup
description: Install, start, verify and connect Browser Controller (MCP server + Chrome extension + shared daemon that lets agents drive the user's real logged-in Chrome). Use when asked to set up, start, restart, connect an agent (Claude/Codex/Cursor/Windsurf/n8n) to, or "get working" the browser controller, on the ROG box at /home/bobby/projects/browser-controller.
---

# Browser Controller: setup and connect

Architecture in one breath: **Chrome extension** ⇄ (WS 127.0.0.1:7225) ⇄ **shared daemon** (systemd user unit `browser-controller-daemon`) ⇄ (unix socket `~/.browser-controller/daemon.sock`) ⇄ thin **MCP servers** (one per agent) and the optional **bridge** (`mcp-proxy` on :9090, systemd unit `browser-controller-bridge`) that n8n uses over HTTP.

Everything is driven by one CLI: `bctl` (`~/.local/bin/bctl` → `scripts/bctl.mjs`). Prefer it over hand-rolled commands.

## Golden path

```bash
cd /home/bobby/projects/browser-controller
bctl setup          # build, install service + CLI + launcher, start, connect agents, doctor
bctl status         # daemon up? extension connected? which agents?
bctl doctor         # exit 1 + list of problems if anything is wrong
```

Other verbs: `bctl up | down | restart` (rebuilds first when `dist/` is stale), `bctl connect [claude-desktop|cursor|windsurf|claude-code|codex|all]`, `bctl call <tool> '<json>'`, `bctl install-service [--bridge]`, `bctl install-launcher`, `bctl install-cli`.

## Steps an agent must complete (in order)

1. **Preflight**: `node -v` (v24 via nvm at `~/.nvm/versions/node/v24.19.0`), repo present, `git status` clean or only known untracked files. Do not touch untracked `AGENTS.md`, `docs/`.
2. **Build**: `npm ci --legacy-peer-deps` (plain `npm ci` fails on the eslint 10 / Babel 8 peer conflict, a known upstream issue), then `npm run build`. `bctl` builds for you when `dist/` is stale.
3. **Daemon under systemd, never by hand.** `bctl install-service`, then `bctl up`. A hand-started `node …/daemon.js` holds `~/.browser-controller/daemon.lock`, and the systemd unit then crash-loops forever ("lock is held by live process"). If you find a manual daemon: `kill -TERM <pid>`, `systemctl --user reset-failed browser-controller-daemon`, then `bctl up`.
4. **Extension**: Chrome → `chrome://extensions` → Developer mode → Load unpacked → `/home/bobby/projects/browser-controller/extension` (or click the reload icon after any daemon or extension code change). Then `bctl status` must say "extension connected". This needs the user's real Chrome window; an agent cannot do it headlessly. The headless Chrome on :9224 is a different browser and does not count. Ask the user to do it and wait.
5. **Connect agents**: `bctl connect all` (idempotent). claude-code and codex are wired through their own MCP config; Cursor/Windsurf only if their config dirs exist. **Restart the agent app** afterwards (Claude Desktop especially).
6. **n8n bridge (only if n8n needs it)**: `bctl install-service --bridge`. n8n on bobby-nuc (10.0.0.242) reaches `http://10.0.0.248:9090` (`/mcp` streamable HTTP or `/sse`). The bridge is `mcp-proxy` bound to `0.0.0.0:9090`, so **anyone on the LAN can drive the logged-in browser**. Do not rebind to localhost without a replacement path for n8n (it would break workflows). The right hardening is a firewall rule that needs the user's sudo:
   `sudo ufw allow from 10.0.0.242 to any port 9090 proto tcp && sudo ufw deny 9090/tcp`
   Tell the user; do not try sudo yourself (Desktop Commander blocks it).
7. **Verify end to end**: `bctl call browser_tabs '{"action":"list"}'` returns real tabs, then one harmless read such as `browser_text` on one of them.

## Environment gotchas on this machine

- Desktop Commander shells have **no user bus**. Before `systemctl --user` / `journalctl --user` run:
  `export XDG_RUNTIME_DIR=/run/user/$(id -u) DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus`
- `sudo` is blocked on the ROG connection.
- Tools: rog = `mcp__desktop_commander__rog__*` (ROG, 10.0.0.248), nuc = `…__bobby-nuc__*` (10.0.0.242). `ssh bobby-nuc` works from the ROG. Files written with a sandbox `create_file` do NOT land on the ROG; use the rog `write_file`.
- State dir `~/.browser-controller/`: `daemon.json`, `daemon.lock`, `daemon.sock`, `token.json`, `enrollment.json`, `daemon.log`, `mcp-bridge.log`. **`token.json` and `enrollment.json` are secrets**: never print, commit or paste them.
- Pushing to the fork (`Bzcasper/browser-controller`) needs `gh auth switch -u Bzcasper`; switch back to `tinydigitalproductlab` afterwards. `origin` = fork, `upstream` = compnew2006/browser-controller. Push `main` only to `origin`; upstream PRs go from a feature branch.

## Done means

`bctl doctor` shows only accepted findings (currently the LAN-wide :9090 bridge until the user runs the ufw rule), the daemon is owned by systemd with 0 restarts, the extension is connected, target agents are connected, and one real tool call succeeded. Report exactly which of those you verified.
