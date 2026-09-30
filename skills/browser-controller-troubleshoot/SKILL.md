---
name: browser-controller-troubleshoot
description: Diagnose and fix Browser Controller failures (extension not connected, daemon crash-loop, lock held, stale dist, tools missing or erroring, bridge :9090 problems, agent can't see the MCP, stale tab IDs, capture/debugger detach). Use whenever a browser_* tool fails, `bctl doctor` reports a problem, or the user says the browser controller is broken.
---

# Browser Controller: troubleshoot

Always start with facts, then fix the first failing layer. Layers, bottom to top: **node/dist → daemon (systemd) → extension ⇄ daemon → agent MCP config → bridge/n8n → tab/tool**.

```bash
export XDG_RUNTIME_DIR=/run/user/$(id -u) DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus   # required in Desktop Commander shells
cd /home/bobby/projects/browser-controller
bctl doctor && bctl status
systemctl --user status browser-controller-daemon browser-controller-bridge --no-pager
journalctl --user -u browser-controller-daemon -n 40 --no-pager
tail -40 ~/.browser-controller/daemon.log
```

## Symptom → cause → fix

| Symptom | Cause | Fix |
|---|---|---|
| `daemon lock is held by live process <pid>`, restart counter in the hundreds | A hand-started daemon owns `daemon.lock`; systemd copy crash-loops. Also restarts the bridge (it `Requires` the daemon). | `kill -TERM <pid>` → `systemctl --user reset-failed browser-controller-daemon` → `bctl up`. Verify `bctl doctor` says "systemd owns the daemon (restarts: 0)". Never start `node dist/daemon.js` manually again. |
| Tests/handshake fail, daemon lacks protocol handshake, `dist/protocol.js` missing | Stale `mcp-server/dist/` built before a merge | `bctl restart` (rebuilds) or `npm run build`; then restart daemon. |
| `extension NOT connected` | Extension not loaded, needs reload after daemon/router change, or Chrome is not the real profile | Real Chrome → `chrome://extensions` → reload "Browser Controller". Confirm it is enabled and points at `/home/bobby/projects/browser-controller/extension`. Headless Chrome on :9224 is irrelevant. Only the user can do this; ask and wait, then `bctl status`. |
| Extension connected but every call times out | Tab mutex held by an aborted call, or tab is a `chrome://` / Web Store page (no scripting) | Call `browser_tabs` list, pick a normal `http(s)` tab; retry; `bctl restart` if a stuck lock persists. |
| `Another debugger is already attached` / capture stops on its own / `detached:true` in capture status | DevTools open on that tab, the user dismissed the "is being debugged" banner, or the tab navigated to a protected page | Close DevTools on that tab, then `browser_capture start` again. |
| "Unknown tool: browser_x" or tool list shorter than expected | Agent cached an old tool list, or dist older than extension | Restart the agent app; `bctl restart`; `bctl call browser_tools '{"action":"list"}'`. |
| Agent app doesn't list the MCP server | Not registered for that agent | `bctl connect <agent>`; restart the app. `bctl connect` with no args shows state. |
| n8n can't reach the browser | Bridge down, wrong URL, or firewall | `systemctl --user status browser-controller-bridge`; `ss -ltnp \| grep 9090`; `tail ~/.browser-controller/mcp-bridge.log` (nuc requests show as 10.0.0.242 `POST /mcp`). n8n URL is `http://10.0.0.248:9090/mcp` (or `/sse`). |
| Bridge listens on 0.0.0.0 (doctor ✗) | By design so n8n on the nuc can connect | Do NOT rebind to localhost blindly. Give the user: `sudo ufw allow from 10.0.0.242 to any port 9090 proto tcp && sudo ufw deny 9090/tcp`. |
| Script fails with stale `tabId` | Hardcoded tab id from an old session | Look tabs up: `browser_tabs list` and match by URL. Never hardcode ids. |
| `npm ci` peer-dependency error / `npm run lint` breaks (eslint 10 + @babel/eslint-parser 7 vs Babel 8) | Upstream dependency conflict, unrelated to your change | Use `npm ci --legacy-peer-deps`; don't "fix" lint inside an unrelated change. Tests and typecheck are the gate: `npm run typecheck && npx vitest run`. |
| `git push` 403 to the fork | gh is on `tinydigitalproductlab` | `gh auth switch -u Bzcasper && gh auth setup-git`, push, then switch back. |
| `daemon.log` huge | No rotation yet | `tail`, don't `cat`; truncate with `: > ~/.browser-controller/daemon.log` only with the daemon's blessing (it appends). |
| `systemctl --user`: "Failed to connect to bus" | No user bus in this shell | Export the two variables at the top of this file. |
| `browser_capture` says "No capture session" | Never started, cleared, or the extension service worker restarted (drops in-memory state) | `browser_capture start` again (with `reload:true`) and repeat the action. |

## Method

1. Reproduce with the smallest call: `bctl call browser_tabs '{"action":"list"}'`.
2. Find the first failing layer using the order above; don't fix upstream layers you haven't proven broken.
3. Change one thing, re-run `bctl doctor`, confirm with a real tool call.
4. Before declaring victory run `npm run typecheck && npx vitest run` if you touched source (expect all tests green; currently 387).
5. Report: root cause, what you changed, what you verified, what still needs the user (extension reload, sudo/ufw, restarting an app).

## Hard rules

- Never print, paste or commit `~/.browser-controller/token.json`, `enrollment.json`, cookies, Authorization headers or captured secrets.
- Never expand network exposure (bind addresses, port forwards) to fix a connectivity problem.
- Don't delete the user's scratch scripts (`~/projects/browser-controller-scratch/`) or `~/.browser-controller/rog-test-profile*`.
- The user's Chrome is their real, logged-in browser: read-only sweeps only unless they asked for actions; never submit forms, send mail or change account settings as a "test".
