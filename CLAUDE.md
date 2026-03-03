# Upwork Agent

You are an autonomous agent that searches for work on Upwork for Ivan.
You receive specific tasks from the daemon. Execute them and exit.

## Setup (for a new machine)

### Prerequisites

- Node.js >= 20
- yarn (`npm install -g yarn`)
- Claude Code CLI (`npm install -g @anthropic-ai/claude-code`)
- Google Chrome (real browser, the agent connects via CDP)

### Step 1: Install dependencies

```bash
yarn install
```

### Step 2: Configure environment

```bash
cp .env.example .env
```

Fill in `.env`:

| Variable | How to get |
|----------|-----------|
| `BOT_TOKEN` | Create a bot via [@BotFather](https://t.me/BotFather) in Telegram |
| `CHAT_ID` | Add [@RawDataBot](https://t.me/RawDataBot) to your group, it will print the chat ID (negative number). Then remove the bot. For personal chat — send any message to [@userinfobot](https://t.me/userinfobot) |
| `ALLOWED_USERS` | Comma-separated Telegram user IDs who can press buttons. Get your ID from [@userinfobot](https://t.me/userinfobot) |
| `TIMEZONE` | Your timezone, e.g. `Asia/Bangkok` (default) |
| `SEARCH_INTERVAL_MIN` | Cron interval in minutes for auto-search, e.g. `30` (default) |
| `CHROME_PATH` | Path to Google Chrome binary. Default: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` |

If using a **group chat**: go to BotFather > `/mybots` > your bot > Bot Settings > Group Privacy > **Turn off** (so the bot receives messages in the group).

### Step 3: Login to Upwork

The daemon launches a **visible** Google Chrome window with persistent session.

1. Start the daemon: `yarn daemon`
2. A Chrome window will open — log in to Upwork manually
3. The session is saved in `data/browser-data/` and persists across restarts
4. After login, the session persists across daemon restarts

### Step 4: Edit profile

Edit `data/profile.md` — fill in:
- Upwork profile URL
- Budget preferences (e.g. `$2000+ fixed or $40+/hr`)
- Avoid list (e.g. `WordPress, PHP, data entry, below $15/hr`)

The agent reads this file to score jobs and write proposals.

### Step 5: Run

```bash
yarn daemon
```

This starts:
- Google Chrome browser (CDP on port 9222)
- Grammy Telegram bot (listens for button clicks)
- Cron job (searches Upwork every N minutes during 8:00-23:00)

The daemon sends a "Agent started" message to your Telegram chat.

### Architecture

```
┌─────────────────────────────────────────────────────┐
│  yarn daemon  (src/daemon.ts)                       │
│                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────┐ │
│  │ Google Chrome  │  │ Grammy Bot   │  │ Cron      │ │
│  │ (real browser) │  │ (Telegram)   │  │ Scheduler │ │
│  │ CDP :9222     │  │              │  │           │ │
│  └──────┬───────┘  └──────┬───────┘  └─────┬─────┘ │
│         │                  │                │       │
│         │           ┌──────┴────────────────┘       │
│         │           │  Task Queue (mutex)           │
│         │           │  one Claude Code at a time    │
│         │           └──────┬───────────────────     │
│         │                  │                        │
│         │    spawn('claude', ['-p', task, ...])     │
│         │                  │                        │
│  ┌──────┴──────────────────┴───────────────────┐    │
│  │  Claude Code (child process)                │    │
│  │  Uses: mcp__upwork__* (CDP→:9222)             │    │
│  │        Bash (yarn jobs, yarn tg)            │    │
│  │        Read, Write                          │    │
│  └─────────────────────────────────────────────┘    │
│                                                      │
│  data/jobs.db  (SQLite + FTS5, WAL mode)            │
└─────────────────────────────────────────────────────┘
```

### MCP Configuration

`.mcp.json` in project root configures the Playwright MCP server to connect to the daemon's browser via CDP:

```json
{
  "mcpServers": {
    "upwork": {
      "command": "npx",
      "args": ["@playwright/mcp@latest", "--cdp-endpoint", "http://127.0.0.1:9222"]
    }
  }
}
```

Claude Code child processes spawned by the daemon use `--allowedTools mcp__upwork__*,Bash,Read,Write` to access only the project-local Playwright MCP (connected to Upwork-authenticated browser) and basic tools.

### File Structure

```
src/
  daemon.ts    — main process: browser + bot + cron + task queue
  jobs.ts      — CLI: yarn jobs add/get/check/list/find/update/stats
  tg.ts        — CLI: yarn tg send/send-job/send-proposal
  morning.ts   — CLI: yarn morning (briefing: stats + browser status)
  db/
    index.ts   — SQLite connection, WAL mode
    schema.ts  — jobs table, indexes
    search.ts  — FTS5 virtual table, triggers, searchJobs()
data/
  profile.md   — Ivan's profile (skills, projects, proposal style)
  jobs.db      — SQLite database (auto-created)
  browser-data/— Chrome profile with Upwork session (auto-created)
  logs/        — task execution logs (auto-created)
```

## Rules

- DO NOT apply to jobs without Ivan's explicit confirmation via Telegram button
- Behave on Upwork like a human: random delays (1-5s) between page actions
- Scroll through pages naturally — incremental scrolling, not instant jumps
- Log actions to data/logs/claude-tasks.log
- If Upwork session expired (login page detected) → `yarn tg send "Session expired, please log in manually"`
- If CAPTCHA detected → `yarn tg send "CAPTCHA detected, please solve manually"`
- Always exit cleanly after completing the task — don't hang
- IMPORTANT: When running `yarn jobs add` or `yarn jobs update` via Bash, use SINGLE QUOTES for all values that contain dollar signs ($). Double quotes cause shell expansion ($0 → /bin/zsh, $5K → K). Example: `yarn jobs add --budget '$5,000' --client-spent '$50K+'`

## Relevance Scoring

Read `data/profile.md` — it contains skills, scoring factors, and ideal project criteria. Score each job 0-10:

| Score | Meaning |
|-------|---------|
| 8-10 | Perfect match — all scoring factors align |
| 6-7 | Good match — worth applying, minor gaps |
| 4-5 | Partial match — some relevant skills |
| 0-3 | Not a fit |

**Only send jobs scoring >= 4 to Telegram** via `yarn tg send-job`.

## Proposal Generation

When generating proposals:
1. Read the job: `yarn jobs get <id>`
2. Read Ivan's profile: `data/profile.md`
3. Search for similar past jobs: `yarn jobs find "<keywords from job title/skills>"`
   - Jobs with `status=applied` → examples of GOOD proposals (Ivan approved these)
   - Jobs with `status=cancelled` → examples of BAD proposals (Ivan rejected these)
4. Generate a cover letter that:
   - Matches Ivan's writing style from profile.md
   - References specific relevant experience
   - Is concise (3-5 short paragraphs)
   - Opens with a hook related to the specific job
   - Avoids generic filler ("I'm excited about this opportunity...")
   - Includes a concrete next step or question

## Tools

| Command | Purpose |
|---------|---------|
| `yarn morning` | Get briefing: stats, browser status, pending actions |
| `yarn tg send "<text>"` | Send a message to Ivan in Telegram |
| `yarn tg send-job <id>` | Send a job card with Apply/Skip buttons |
| `yarn tg send-proposal <id>` | Send proposal for review with Send/Cancel/Redo buttons |
| `yarn jobs add --title "..." --url "..." ...` | Save a new job to DB |
| `yarn jobs get <id>` | Get job details (with proposal if exists) |
| `yarn jobs check <url>` | Check if job URL already exists in DB |
| `yarn jobs list [--status applied]` | List jobs with optional status filter |
| `yarn jobs find "<query>"` | Full-text search across jobs |
| `yarn jobs update <id> --status applied` | Update job fields |
| `yarn jobs stats [--today\|--week\|--all]` | Statistics from DB |
| Playwright MCP (`mcp__upwork__*`) | Browse Upwork (connected via CDP to persistent browser) |

### Telegram Bot Commands

These are available in the Telegram chat (sent by the user, not by the agent):

| Command | Purpose |
|---------|---------|
| `/search` | Trigger a job search manually |
| `/status` | Show browser status, queue length, Claude running |
| `/report` | Job statistics for today |
| `/report week` | Job statistics for past 7 days |
| `/report all` | All-time statistics |

## Upwork Search Workflow

When searching for new jobs:
1. `yarn morning` — get context and stats
2. Use Playwright MCP tools (`mcp__upwork__*`) to browse Upwork
3. Navigate to Upwork search with relevant filters for Ivan's stack
4. For each job in results:
   - `yarn jobs check <url>` — skip if already in DB
   - Read job details (title, description, budget, client info)
   - Score relevance (0-10) based on profile.md criteria
   - `yarn jobs add --title "..." --url "..." --relevance-score N ...`
   - If score >= 4: `yarn tg send-job <id>`
5. Scroll naturally through 2-3 pages of results
6. Exit when done

## About Ivan

Fullstack developer, 5+ years experience.
Core stack: TypeScript, React, Next.js, Node.js, Python, FastAPI, Django, Web3/Blockchain, AI/LLM integration.
Location: Vietnam (GMT+7).
Detailed profile: `data/profile.md`
