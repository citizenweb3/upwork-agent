# Upwork Agent — Browser Upgrade Design

> **Status: ON HOLD** — agent-browser does not pass proxy/geolocation settings to cloud providers.
> GitHub issue: https://github.com/vercel-labs/agent-browser/issues/560
> Resume when: Vercel adds `--proxy-country` or equivalent. Until then, Upwork geo-ban risk is too high.
> This architecture is valid for sites that are less strict about geolocation (Twitter, LinkedIn, etc.).

## Problem

Local Chrome via Playwright MCP gets blocked by Cloudflare on Upwork. The agent cannot reliably search for jobs or submit proposals because anti-bot detection identifies the automated browser.

## Solution

Replace Playwright MCP with **agent-browser CLI** (Vercel Labs) + **cloud browser provider** (stealth mode, residential proxy). Keep local Chrome as automatic fallback.

## Key Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Browser tool | agent-browser CLI via Bash | Replaces Playwright MCP. Same tool names (open, snapshot, click). Adds auth, domain allowlist, stealth |
| Cloud provider | TBD (Browserbase or Kernel) | Depends on proxy support resolution. Browserbase has VN in 201-country list. Kernel has stealth + persistent profiles |
| Geo | Vietnam residential IP | **BLOCKED**: agent-browser does not pass proxy settings to providers. Issue #560 filed. Workaround: `--proxy` with external provider (loses stealth) |
| Fallback | Auto-failover to local Chrome | Cloud provider down → daemon launches real Chrome on :9222 → `agent-browser --cdp` connects to it |
| Auth | agent-browser auth (AES-256-GCM) | Auto-login on session expiry. Works in both cloud and local mode. 2FA → Telegram notification |
| Cost | TBD | Browserbase: from $20/mo (Developer plan for proxy). Kernel: $0.06/hr headless (proxy free but no country targeting via CLI) |

## Architecture

### Current (V1)

```
daemon.ts
  ├── launches Google Chrome (spawn, CDP :9222)
  ├── manages lifecycle (reconnect, keepalive, shutdown)
  └── spawns Claude Code
        └── Playwright MCP → CDP :9222 → local Chrome → Upwork
```

### New (V2)

```
daemon.ts
  ├── detects provider (cloud available? → cloud : local)
  ├── if local: launches Google Chrome on :9222 (spawn + fetch health check)
  ├── auto-failover: cloud ↔ local (transparent, no restart)
  └── spawns Claude Code
        └── Bash → agent-browser CLI → cloud browser (stealth, VN proxy)
                                       OR local Chrome (--cdp :9222)
```

### What changes

```
Remove:
  - .mcp.json (no more Playwright MCP)
  - playwright from package.json
  - connectToCDP() function (uses Playwright's chromium.connectOverCDP)
  - browserContext / browser variables
  - keepalive cron (agent-browser manages cloud sessions)
  - --allowedTools 'mcp__upwork__*,...' → 'Bash,Read,Write'

Add:
  - agent-browser (global install: npm i -g agent-browser)
  - Cloud provider env vars (KERNEL_API_KEY or BROWSERBASE_API_KEY etc.)
  - KERNEL_STEALTH=true (required for anti-bot bypass)
  - browserMode variable + auto-failover logic in daemon.ts
  - browserPrefix() helper for task builders
  - auth login flow in task builder instructions
  - recovery cron (hourly cloud health check)

Rewrite:
  - launchBrowser(): remove Playwright dependency, simplify to
    spawn(CHROME_PATH, args) + waitForCDP() via fetch('http://127.0.0.1:9222/json/version')
  - /status command: replace browserContext check with browserMode + CDP/API ping

Keep unchanged:
  - Grammy bot (all button handlers)
  - Task queue + mutex
  - Cron schedule
  - SQLite + FTS5
  - All yarn commands (jobs, tg, morning)
  - Proposal generation + learning
  - Report command
  - Error diagnostics
```

## Auto-Failover

```
Startup:
  1. Check cloud provider API key exists
  2. Health check: ping provider API directly (NOT agent-browser open — that creates a paid session)
  3. Success → browserMode = 'cloud'
  4. Fail → launchBrowser() (real Chrome :9222) → browserMode = 'local'
     → Telegram: "⚠️ Cloud unavailable, using local Chrome"

During operation:
  Claude Code exits with error
    └── stderr contains cloud timeout / connection refused?
        ├── cloudFailures++
        │   └── >= 2 consecutive?
        │       ├── Yes → launchBrowser(), browserMode = 'local'
        │       │   → Telegram: "⚠️ Cloud down, switched to local Chrome"
        │       │   → auto-retry the failed task
        │       └── No → normal retry
        └── No → normal error handling (unchanged)

Recovery (hourly cron):
  browserMode === 'local'?
    └── Ping cloud provider API (free, no session created)
        ├── Success → browserMode = 'cloud', cloudFailures = 0
        │   → stop local Chrome
        │   → Telegram: "🌐 Cloud recovered, switching back"
        └── Fail → stay on local
```

## Auto-Login (agent-browser auth)

### Setup (one-time)

```bash
echo "***" | agent-browser auth save upwork \
  --url "https://www.upwork.com/ab/account-security/login" \
  --username "ivan@email.com" \
  --password-stdin
```

Credentials encrypted with AES-256-GCM, stored in `~/.agent-browser/auth/`.

Other auth commands: `auth list`, `auth show`, `auth delete`.

### Flow (same for cloud and local)

```
Login page detected (any browserMode)
  └── agent-browser auth login upwork
      ├── Success → continue task
      ├── 2FA prompt → Telegram "🔐 2FA required, check your phone"
      │   → wait 60s → snapshot → retry
      └── Fail → Telegram "🔑 Auto-login failed, please log in [🔄 Retry]"
```

Local Chrome uses `data/browser-data/` (separate profile, not Ivan's personal browser), so auth auto-login is safe in both modes.

## Task Builder Changes

### Command mapping

| V1 (Playwright MCP) | V2 (agent-browser CLI) |
|---|---|
| `browser_navigate(url)` | `agent-browser open <url>` |
| `browser_snapshot` | `agent-browser snapshot -i` |
| `browser_click @ref` | `agent-browser click @<ref>` |
| `browser_type @ref "text"` | `agent-browser type @<ref> "text"` |
| `browser_press_key Enter` | `agent-browser key Enter` |
| `browser_navigate_back` | `agent-browser back` |
| `browser_run_code(js)` | `agent-browser eval "js"` |
| `browser_fill_form(fields)` | `agent-browser fill @<ref> "value"` |

### Provider prefix

```typescript
let browserMode: 'cloud' | 'local' = 'cloud';

function browserPrefix(): string {
  if (browserMode === 'cloud') return '-p kernel'; // or '-p browserbase'
  return '--cdp http://127.0.0.1:9222';
}

// In task builders:
// `Run: agent-browser ${browserPrefix()} open https://www.upwork.com`
```

### Session continuity

agent-browser runs a local daemon process that keeps the browser alive between CLI invocations within the same shell session. Sequential commands (`open` → `snapshot` → `click` → `snapshot`) share the same browser instance automatically. No `--session` flag needed for single-task flows.

**TODO**: verify this behavior with cloud providers. If the daemon does not persist cloud sessions, may need `--session <id>` or equivalent.

### Snapshot-ref search task (replaces hardcoded JS)

V1 used hardcoded CSS selectors via `browser_run_code`:
```javascript
document.querySelectorAll('a[href*="/jobs/"]')  // breaks when DOM changes
```

V2 uses snapshot-ref cycle:
```
1. agent-browser ${prefix} open "https://www.upwork.com/nx/search/jobs/?q=..."
2. agent-browser snapshot -i
   → Claude reads the page semantically, identifies job links by text content
   → link "Senior React Dev — $5K fixed" [ref=e1]
   → link "AI Chatbot Integration" [ref=e2]
   → ...
3. For each interesting job:
   a. agent-browser click @e1
   b. agent-browser snapshot -i
      → Claude reads full job description, client info, budget
   c. yarn jobs check <url>  → skip if exists
   d. yarn jobs add --title '...' --url '...' --relevance-score N ...
   e. If score >= 4: yarn tg send-job <id>
   f. agent-browser back
   g. agent-browser snapshot -i  → continue to next job
4. Scroll: agent-browser eval "window.scrollBy(0, 800)"
5. agent-browser snapshot -i → repeat from step 3
```

No hardcoded selectors. Claude decides what to click based on semantic understanding. DOM-independent.

### Security

All task builders add:
```
--allowed-domains "upwork.com,*.upwork.com"
```

Agent cannot navigate away from Upwork.

## daemon.ts Changes (detailed)

### Remove

- `connectToCDP()` function: uses Playwright's `chromium.connectOverCDP()` — incompatible with Playwright removal
- `browserContext` / `browser` variables: Playwright types, no longer needed
- `keepalive` cron: agent-browser manages cloud sessions

### Rewrite

- `launchBrowser()`: remove Playwright dependency. New version:
  ```typescript
  async function launchBrowser(): Promise<void> {
    // Spawn real Chrome with CDP
    chromeProcess = spawn(CHROME_PATH, [
      '--remote-debugging-port=9222',
      '--user-data-dir=data/browser-data',
      '--no-first-run',
    ]);
    // Wait for CDP to be ready (no Playwright needed)
    await waitForCDP('http://127.0.0.1:9222/json/version', 10_000);
  }
  ```
- `/status` command: replace `browserContext ? 'Running' : 'Down'` with:
  ```typescript
  const browserOk = browserMode === 'cloud'
    ? await pingCloudAPI()    // free API ping, no session created
    : await pingCDP();        // fetch('http://127.0.0.1:9222/json/version')
  ```

### Modify

- `main()`: add `detectBrowserProvider()` before Grammy start
- `processQueue()` exit handler: add cloud failure detection + auto-failover
- `startCron()`: add hourly cloud recovery check (API ping, not session creation)
- `shutdown()`: skip Chrome shutdown if browserMode === 'cloud'
- `buildSearchTask()`: rewrite to snapshot-ref flow (see above)
- `buildSubmitTask()`: rewrite browser commands + add auth login flow
- `buildProposeTask()`: no browser commands, unchanged
- `buildRedoTask()`: no browser commands, unchanged
- `processQueue()` spawn args: `--allowedTools 'Bash,Read,Write'` (remove mcp__)

### Add

- `browserMode` + `cloudFailures` variables
- `detectBrowserProvider()` function
- `browserPrefix()` helper
- `isCloudError(stderr, stdout)` detection function
- `switchToLocal()` / `switchToCloud()` transition functions
- `waitForCDP(url, timeout)` — polls endpoint via fetch
- `pingCloudAPI()` / `pingCDP()` — lightweight health checks
- Cloud recovery cron job

## .env Changes

```bash
# Existing (unchanged)
BOT_TOKEN=...
CHAT_ID=...
ALLOWED_USERS=...
SEARCH_INTERVAL_MIN=30
TIMEZONE=Asia/Bangkok
CHROME_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome

# New (cloud provider — choose one)
KERNEL_API_KEY=...              # From kernel.sh dashboard
KERNEL_STEALTH=true             # Required for anti-bot bypass (not on by default)
KERNEL_PROFILE_NAME=upwork-ivan # Persistent cloud profile

# Proxy (BLOCKED — waiting for issue #560)
# When resolved, one of:
# KERNEL_PROXY_COUNTRY=VN       # If Vercel adds this
# BROWSERBASE_PROXY_COUNTRY=VN  # If using Browserbase instead
# AGENT_BROWSER_PROXY=http://... # External VN residential proxy (workaround, loses stealth)
```

## CLAUDE.md Changes

Update Tools section:
- Remove Playwright MCP references
- Add agent-browser commands
- Add auth login instructions (not "vault" — `auth save`, `auth login`)
- Add `--allowed-domains` note

## package.json Changes

```diff
  "dependencies": {
    "grammy": "^1.31.0",
    "better-sqlite3": "^11.7.0",
-   "playwright": "^1.50.0",
    "node-cron": "^3.0.3",
    "dotenv": "^16.4.7"
  },
```

Note: `playwright` removed from project deps. agent-browser bundles its own Playwright internally. `launchBrowser()` rewritten to use spawn + fetch instead of Playwright's `chromium.connectOverCDP()`.

## Setup (one-time)

```bash
# 1. Install agent-browser globally
npm install -g agent-browser
agent-browser install

# 2. Store Upwork credentials
echo "your-password" | agent-browser auth save upwork \
  --url "https://www.upwork.com/ab/account-security/login" \
  --username "ivan@email.com" \
  --password-stdin

# 3. Add cloud provider keys to .env
echo 'KERNEL_API_KEY=sk-...' >> .env
echo 'KERNEL_STEALTH=true' >> .env
echo 'KERNEL_PROFILE_NAME=upwork-ivan' >> .env

# 4. Test cloud connection
agent-browser -p kernel open https://www.upwork.com
agent-browser close  # Don't leave session running

# 5. Start daemon (auto-detects provider)
yarn daemon
```

## Implementation Stages

### Stage 1: agent-browser integration
- Install agent-browser, test with cloud provider
- Remove .mcp.json and playwright dep
- Rewrite launchBrowser() to spawn + fetch (remove Playwright dependency)
- Add browserMode + browserPrefix() to daemon.ts
- Rewrite buildSearchTask() with snapshot-ref flow
- Rewrite buildSubmitTask() with agent-browser commands
- Update --allowedTools in processQueue()
- Test: search task works via cloud provider

### Stage 2: Auto-failover
- Add detectBrowserProvider() startup logic (API ping, not session creation)
- Add isCloudError() detection in processQueue()
- Add switchToLocal() / switchToCloud() transitions
- Add recovery cron (hourly API ping)
- Update /status to use browserMode + ping instead of browserContext
- Test: unplug API key → verify fallback to local Chrome

### Stage 3: Authentication
- Setup auth with Upwork credentials (`auth save`, not `vault add`)
- Add login detection + auth login to task builders
- Add 2FA Telegram notification flow
- Test: clear cookies → verify auto-login

### Stage 4: Security hardening
- Add --allowed-domains to all browser commands
- Verify session continuity within tasks (daemon keeps browser alive?)
- Update CLAUDE.md
- Test full cycle: search → propose → submit via cloud provider

## Cost

| Item | Cost |
|------|------|
| Browserbase Developer | $20/month (required for proxy) |
| Browser sessions | ~$0.03/day |
| Proxy data | ~$0.50/month (est. 50MB/day) |
| agent-browser | $0 (open source) |
| **Total (Browserbase)** | **~$21/month** |

OR:

| Item | Cost |
|------|------|
| Kernel Free tier | $0/month ($5 credits included) |
| Headless browser | ~$0.03/day ($0.06/hr × 0.5hr) |
| Proxy | $0 (stealth auto-proxy, country not selectable) |
| **Total (Kernel, no VN guarantee)** | **~$0.90/month** |

## Risks

| Risk | Probability | Mitigation |
|------|-------------|------------|
| **Upwork detects non-VN IP** | **HIGH without proxy fix** | **BLOCKED: waiting for issue #560** |
| Cloud provider downtime | Low | Auto-failover to local Chrome |
| Auth login fails (DOM change) | Medium | Fallback to manual login via Telegram |
| agent-browser breaking update | Low | Pin version in global install |
| Free tier runs out | Low (Kernel) / N/A (Browserbase paid) | Monitor usage, upgrade if needed |
| 2FA blocks auto-login | Medium | Telegram notification, 60s wait, manual entry |
| Session not persisted between CLI calls | Low (daemon manages) | Verify and document; add --session if needed |

## Review History

- **2026-02-27 v1**: Initial design
- **2026-02-27 v2**: Fixed 8 issues from code review:
  1. ~~vault~~ → auth (correct API: `auth save`, `auth login`, `--password-stdin`)
  2. ~~KERNEL_PROXY_COUNTRY=VN~~ → blocked, filed issue #560
  3. ~~launchBrowser() keep as-is~~ → rewrite to spawn + fetch, remove Playwright dependency
  4. Added KERNEL_STEALTH=true to .env
  5. Health check: API ping instead of session creation (avoids leaked sessions)
  6. Documented session continuity (daemon keeps browser alive, needs verification for cloud)
  7. /status: replaced browserContext with browserMode + ping
  8. Detailed snapshot-ref search task flow (replaces hardcoded JS)
  - Marked as ON HOLD pending proxy resolution
