# Upwork Agent

Autonomous Upwork job search agent powered by Claude Code. Finds relevant jobs, scores them against your profile, generates tailored proposals, and submits them — all controlled via Telegram buttons.

## How It Works

The agent runs as a background daemon that connects three components:

1. **Google Chrome** with your logged-in Upwork session (via Chrome DevTools Protocol)
2. **Telegram bot** that sends you job cards and lets you approve/skip/redo with inline buttons
3. **Claude Code** that does the actual browsing, scoring, and proposal writing

```
Cron (every N min) or /search command
        |
        v
  Claude Code browses Upwork
  using your Chrome session
        |
        v
  Scores each job 0-10
  based on your profile
        |
        v
  Jobs scoring >= 4 sent
  to Telegram with buttons
        |
        v
  You press [Apply] or [Skip]
        |
        v
  Claude generates proposal
  matching your writing style
        |
        v
  You review: [Send] [Cancel] [Redo]
        |
        v
  Claude submits on Upwork
```

## Setup

There are two ways to run the agent:

| | **Docker (recommended)** | **Bare metal** |
|---|---|---|
| Best for | Server, 24/7, headless | Mac/Linux desktop with monitor |
| Requirements | Docker, Docker Compose | Node.js, Chrome, Claude Code CLI |
| Chrome access | Via noVNC in browser (`http://server:6080`) | Native Chrome window |
| Setup time | ~5 min | ~15 min |

---

### Option A: Docker (recommended for servers)

#### Requirements

- Docker and Docker Compose
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) subscription (for OAuth token)
- Telegram account

#### 1. Clone

```bash
git clone <repo-url>
cd upwork-agent
```

#### 2. Create Telegram bot

1. Open [@BotFather](https://t.me/BotFather) in Telegram
2. Send `/newbot`, follow the prompts, copy the **bot token**
3. Create a group chat (or use personal chat) and add the bot
4. Get the **chat ID**:
   - For groups: add [@RawDataBot](https://t.me/RawDataBot), it prints the chat ID (negative number), then remove it
   - For personal chat: send any message to [@userinfobot](https://t.me/userinfobot)
5. Get your **user ID**: send any message to [@userinfobot](https://t.me/userinfobot)
6. If using a group:
   - BotFather > `/mybots` > your bot > Bot Settings > Group Privacy > **Turn off**
   - In the group: Settings > **Visible History** > turn on (so link previews in job cards work)

#### 3. Configure environment

```bash
cp .env.example infra/.env
```

Edit `infra/.env`:

| Variable | Description | How to get |
|----------|-------------|-----------|
| `BOT_TOKEN` | Telegram bot token | From [@BotFather](https://t.me/BotFather) |
| `CHAT_ID` | Telegram chat ID | See step 2 above |
| `ALLOWED_USERS` | User IDs who can press buttons | From [@userinfobot](https://t.me/userinfobot), comma-separated |
| `TIMEZONE` | Your timezone | `Europe/Lisbon` (default) |
| `SEARCH_INTERVAL_MIN` | Auto-search interval in minutes | Default: `20` |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code OAuth token | See below |
| `CLAUDE_ACCOUNT_UUID` | Account UUID | See below |
| `CLAUDE_EMAIL` | Account email | See below |
| `CLAUDE_ORG_UUID` | Organization UUID | See below |

**Getting Claude Code OAuth credentials** — on a machine where Claude Code is already logged in:

```bash
# OAuth token (macOS)
security find-generic-password -s "claude-cli" -w

# Account UUID, email, org UUID
cat ~/.claude.json | grep -A5 oauthAccount
```

#### 4. Set up your profile

```bash
cp data/profile.example.md data/profile.md
```

Edit `data/profile.md` with your name, tech stack, experience, scoring criteria, and proposal style. The agent reads this file to score jobs and write proposals.

#### 5. Launch

```bash
cd infra
docker compose up -d
```

First build takes ~5 minutes. After that:

1. Open `http://server:6080` in a browser — you'll see Chrome via noVNC
2. Log in to Upwork manually in that Chrome
3. The session persists in a Docker volume across restarts

The bot sends a Telegram notification when the browser is ready.

#### Docker management

All commands from `infra/` directory:

```bash
cd infra
docker compose logs -f          # follow logs
docker compose restart          # restart
docker compose down             # stop
docker compose up -d --build    # rebuild after code changes
```

---

### Option B: Bare metal (Mac/Linux desktop)

#### Requirements

- Node.js >= 20
- Google Chrome (real browser, not Chromium — Upwork detects `navigator.webdriver` in Playwright's bundled Chromium)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) with active subscription
- Telegram account

#### Install system dependencies

**macOS:**

```bash
brew install node
npm install -g yarn @anthropic-ai/claude-code
# Google Chrome — install from https://www.google.com/chrome/
```

**Ubuntu Desktop:**

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs lsof
npm install -g yarn @anthropic-ai/claude-code
wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo dpkg -i /tmp/chrome.deb && sudo apt --fix-broken install -y
```

#### 1. Clone and install

```bash
git clone <repo-url>
cd upwork-agent
yarn install
```

#### 2. Create Telegram bot

Same as Docker Option A, step 2.

#### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

| Variable | Description | Default |
|----------|-------------|---------|
| `BOT_TOKEN` | Telegram bot token from BotFather | required |
| `CHAT_ID` | Telegram chat ID (negative for groups) | required |
| `ALLOWED_USERS` | Comma-separated Telegram user IDs | required |
| `TIMEZONE` | Your timezone | `Europe/Lisbon` |
| `SEARCH_INTERVAL_MIN` | Auto-search interval in minutes (8:00-23:00) | `20` |
| `CHROME_PATH` | Path to Chrome binary | Auto-detected by OS |

#### 4. Set up your profile

```bash
cp data/profile.example.md data/profile.md
```

Edit with your name, tech stack, experience, scoring criteria, and proposal style.

#### 5. First launch — log in to Upwork

```bash
yarn daemon
```

A Chrome window opens with a separate profile (`data/browser-data/`). **Log in to Upwork manually.** The session persists across daemon restarts.

#### 6. Daily use

```bash
yarn daemon
```

The daemon will:
- Auto-search every N minutes during 8:00-23:00 (your timezone)
- Send matching jobs to Telegram
- Wait for your button presses
- Generate and submit proposals on your command
- Send a heartbeat ping every 6 hours

## Telegram Commands

| Command | What it does |
|---------|-------------|
| `/search` | Run a job search right now |
| `/status` | Show browser status, queue length, Claude running |
| `/report` | Job stats for today |
| `/report week` | Job stats for the past 7 days |
| `/report all` | Job stats for all time |

## Telegram Buttons

On **job cards**:
| Button | Action |
|--------|--------|
| Apply | Generate a proposal for this job |
| Skip | Mark as skipped, no further action |

On **proposals**:
| Button | Action |
|--------|--------|
| Send | Submit the proposal on Upwork |
| Cancel | Discard the proposal |
| Redo | Generate a completely different proposal |

On **errors**:
| Button | Action |
|--------|--------|
| Retry | Re-run the failed action |

## CLI Tools

These can be used independently from the daemon:

```bash
# Job database
yarn jobs add --title '...' --url '...' --relevance-score 7
yarn jobs get <id>
yarn jobs check <url>
yarn jobs list
yarn jobs list --status applied
yarn jobs find "react typescript AI"
yarn jobs update <id> --status applied
yarn jobs stats              # today
yarn jobs stats --week       # past 7 days
yarn jobs stats --all        # all time

# Telegram
yarn tg send "Hello"
yarn tg send-job <id>
yarn tg send-proposal <id>

# Briefing
yarn morning
```

## Architecture

```
+----------------------------------------------------------+
|  yarn daemon  (src/daemon.ts)                            |
|                                                          |
|  +---------------+  +--------------+  +---------------+  |
|  | Google Chrome  |  | Grammy Bot   |  | Cron          |  |
|  | (real browser) |  | (Telegram)   |  | Scheduler     |  |
|  | CDP :9222      |  |              |  |               |  |
|  +-------+-------+  +------+-------+  +-------+-------+  |
|          |                  |                  |          |
|          |           +------+------------------+          |
|          |           |  Task Queue (mutex)                |
|          |           |  one Claude Code at a time         |
|          |           +------+--------------------         |
|          |                  |                             |
|          |    spawn('claude', ['-p', task, ...])          |
|          |                  |                             |
|  +-------+------------------+------------------------+    |
|  |  Claude Code (child process)                      |    |
|  |  Tools: Playwright MCP (CDP -> :9222)             |    |
|  |         Bash (yarn jobs, yarn tg)                 |    |
|  |         Read, Write                               |    |
|  +---------------------------------------------------+    |
|                                                          |
|  data/jobs.db  (SQLite + FTS5, WAL mode)                 |
+----------------------------------------------------------+
```

### Key design decisions

- **Real Chrome, not Playwright Chromium** — Upwork uses Cloudflare Turnstile which detects `navigator.webdriver=true` in Playwright's bundled Chromium. Real Chrome doesn't have this marker.
- **CDP connection** — Chrome runs with `--remote-debugging-port=9222`, daemon connects via `chromium.connectOverCDP()`. The Playwright MCP server also connects to this port.
- **Mutex task queue** — Only one Claude Code process runs at a time. Tasks are queued and processed sequentially.
- **Model routing** — Haiku for search and submit (tool-heavy, speed matters), Sonnet for proposals and redo (creative writing, quality matters).
- **Persistent session** — Chrome uses a separate `--user-data-dir` so cookies and login survive restarts. Keepalive reloads prevent session expiry.

## File Structure

```
src/
  daemon.ts       Main process: Chrome + bot + cron + task queue
  jobs.ts         CLI for job database operations
  tg.ts           CLI for Telegram messaging
  morning.ts      CLI for daily briefing
  db/
    index.ts      SQLite connection (WAL mode)
    schema.ts     Jobs table and indexes
    search.ts     FTS5 full-text search

data/
  profile.md          Your profile (gitignored, copy from example)
  profile.example.md  Template for profile.md
  jobs.db             SQLite database (auto-created)
  browser-data/       Chrome profile with Upwork session (auto-created)
  logs/               Task execution logs

infra/
  Dockerfile          Container image (Ubuntu + Chrome + Node + VNC)
  docker-compose.yml  Single-command deploy
  supervisord.conf    Process manager (Xvfb, x11vnc, noVNC, daemon)
  start.sh            Entrypoint (auth, cleanup, notifications)

.mcp.json         Playwright MCP server config (CDP endpoint)
.env              Bot token, chat ID, settings (gitignored)
.env.example      Template for .env (both bare metal and Docker)
CLAUDE.md         Agent instructions for Claude Code
```

## Job Statuses

| Status | Meaning |
|--------|---------|
| `new` | Just added to DB, not scored high enough to send |
| `sent` | Sent to Telegram, awaiting your decision |
| `approved` | You pressed Apply, proposal is being generated |
| `skipped` | You pressed Skip |
| `cancelled` | You pressed Cancel on a proposal |
| `applied` | Proposal submitted on Upwork |

## Troubleshooting

**Bot doesn't respond to commands**
- Check Group Privacy is turned off in BotFather
- Verify your user ID is in `ALLOWED_USERS`
- If you converted a group to a supergroup, update `CHAT_ID` (it changes)

**Upwork blocks access**
- "Cannot verify your request" — IP/VPN issue, try switching VPN or disabling it
- CAPTCHA — the agent tries to click it automatically (2 attempts), then notifies you to solve manually
- Session expired — log in manually in the Chrome window

**"Not enough Connects"**
- Buy Connects on Upwork, then press the Retry button in Telegram

**Chrome won't start**
- Check `CHROME_PATH` in `.env` (or leave it empty for auto-detection)
- Kill zombie processes: `lsof -ti:9222 | xargs kill -9`
- In Docker: stale lock files are cleaned automatically on start. If still failing: `docker compose restart`

**Docker: Claude Code auth error**
- Check that `CLAUDE_CODE_OAUTH_TOKEN` is filled in `infra/.env`
- OAuth tokens expire — get a fresh one and `docker compose restart`

**Docker: noVNC not accessible**
- Port 6080 is bound to `127.0.0.1` by default
- For remote access change `"127.0.0.1:6080:6080"` to `"6080:6080"` in `docker-compose.yml`

**Search finds 0 jobs**
- The agent rotates through search queries randomly
- Check `data/profile.md` scoring criteria — threshold is >= 4

## Background Processes

The daemon runs several background tasks:

| Process | Interval | Purpose |
|---------|----------|---------|
| Job search | Every N min, 8:00-23:00 | Find new jobs |
| Keepalive | Every 10 min | Reload page to prevent session expiry |
| Heartbeat | Every 6 hours | Send "alive" ping to Telegram |

## License

MIT
