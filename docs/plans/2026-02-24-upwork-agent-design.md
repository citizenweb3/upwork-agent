# Upwork Auto-Apply Agent — Design Document

## Problem

Manually monitoring Upwork takes 1-2 hours per day: open search, scroll through jobs, assess relevance, write a proposal, submit. Most of this is automatable.

## Solution

An autonomous Claude Code agent (following the consciousness-chain / OpenClaw model). Claude Code is the brain, Playwright MCP provides eyes and hands, yarn commands are tools, SQLite serves as memory. The human controls everything through Telegram inline buttons — no freeform text, only structured actions.

## Key Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Architecture | Claude Code = agent brain | CLAUDE.md defines context, daemon dispatches specific tasks |
| Upwork | Playwright MCP | Claude sees the page like a human, not dependent on selectors/DOM |
| Browser | Persistent browser daemon (CDP) | Single long-lived browser process, Claude Code connects/disconnects per task. Real cookies, real fingerprint, no restarts |
| Telegram | Grammy daemon (24/7) + buttons only | Daemon listens in real-time, spawns Claude Code on button presses. No freeform text — only structured inline buttons |
| AI | Claude Max subscription | $0 on top of subscription |
| Storage | SQLite + FTS5 | DB for jobs, search, and proposal learning. Statistics computed on the fly from jobs table |
| Concurrency | Mutex + queue in daemon | One Claude Code at a time, tasks queued sequentially |

## Architecture

Three processes: Browser daemon (always running) + Grammy daemon (always running) + Claude Code (on demand).

```
┌────────────────────────────────────────────────────────────────┐
│                                                                │
│  Browser daemon        Grammy daemon          Claude Code      │
│  (Playwright server)   (Grammy bot, 24/7)     (on demand)      │
│  ──────────────────    ──────────────────     ──────────────── │
│  Persistent browser    Listens to Telegram    Launched per task │
│  Serves via CDP        Mutex + task queue     Connects to       │
│                                               browser via CDP   │
│                        Button press ────────→ execFile(claude)  │
│                        Cron tick ───────────→ execFile(claude)  │
│                                                     │          │
│                                               ┌─────┴──────┐   │
│                                               │  CLAUDE.md  │   │
│                                               │  + MCP      │   │
│                                               │  + yarn cmd │   │
│                                               └─────┬──────┘   │
│                                                     │          │
│                                         ┌───────────┼────────┐ │
│                                         ▼           ▼        ▼ │
│  Browser ◄──── CDP ────────────── Playwright    yarn tg   yarn  │
│  (Upwork)                         MCP           send      jobs  │
│                                   (browse)     (Telegram) (DB)  │
└────────────────────────────────────────────────────────────────┘
```

**Browser daemon** — a Playwright browser server process. Runs permanently, serves a single browser instance via Chrome DevTools Protocol (CDP). Claude Code connects to it on each launch and disconnects on exit. Cookies, localStorage, and fingerprint persist naturally because the browser never restarts.

**Grammy daemon** — a lightweight Node.js process. Catches Telegram button presses, manages a task queue with a mutex (one Claude Code at a time), and runs an adaptive cron for periodic job searches. Does not think or analyze — only dispatches.

**Claude Code** — the brain. Launched per task with specific instructions from daemon. Connects to persistent browser via CDP, does the work, exits. CLAUDE.md provides context (who you are, rules, tools), but the workflow is determined by the task string from daemon.

## Workflow

### Periodic search (cron → daemon → Claude Code)
```
cron (every SEARCH_INTERVAL_MIN, working hours 8-23 GMT+7)
  → daemon checks mutex → queue if busy
  → execFile: claude -p "Search for new jobs on Upwork.
     Run yarn morning for context.
     Open Upwork search via Playwright MCP.
     For each new job: yarn jobs check <url>, assess relevance,
     yarn jobs add, yarn tg send-job."
  → Claude Code:
      → yarn morning → gets stats and context
      → Playwright MCP: connect to browser via CDP
      → Open Upwork search, scroll through results
      → For each new job:
          yarn jobs check <url> → already in DB?
          No → assess relevance (score 0-10)
               → yarn jobs add (save to DB)
               → if score ≥ 6: yarn tg send-job (to Telegram with buttons)
  → Claude Code exits
  → daemon releases mutex, runs next queued task
```

### Proposal generation (button → daemon → Claude Code)
```
Ivan pressed [✅ Apply] in Telegram
  → daemon: answerCallbackQuery("⏳ Generating proposal...")
  → daemon checks mutex → queue if busy
  → execFile: claude -p "Generate proposal for job <id>.
     Read the job (yarn jobs get <id>), read data/profile.md.
     Search for similar past jobs with approved proposals
     (yarn jobs find) and use them as style reference.
     Generate cover letter, send via yarn tg send."
  → Claude Code (~15 sec):
      → Reads job from DB
      → Reads profile.md
      → Searches similar jobs with status=applied (good examples)
        and status=cancelled (bad examples) via FTS5
      → Generates cover letter informed by past feedback
      → yarn tg send "📝 Proposal: ... [✅ Send] [❌ Cancel] [🔄 Redo]"
  → Claude Code exits
```

### Proposal redo (button → daemon → Claude Code)
```
Ivan pressed [🔄 Redo] in Telegram
  → daemon: answerCallbackQuery("⏳ Regenerating...")
  → execFile: claude -p "Redo proposal for job <id>.
     The previous proposal was rejected by Ivan.
     Read the job (yarn jobs get <id>), read data/profile.md.
     Generate a different cover letter, send via yarn tg send."
  → Claude Code generates a new proposal with different approach
  → yarn tg send "📝 New proposal: ... [✅ Send] [❌ Cancel] [🔄 Redo]"
```

### Proposal submission (button → daemon → Claude Code)
```
Ivan pressed [✅ Send]
  → daemon: answerCallbackQuery("⏳ Submitting to Upwork...")
  → execFile: claude -p "Submit proposal for job <id>.
     yarn jobs get <id>, open Upwork via Playwright MCP,
     fill proposal form, submit."
  → Claude Code:
      → Playwright MCP: connect to browser → open job → Apply → fill form → Submit
      → yarn jobs update <id> --status applied
      → yarn tg send "✅ Proposal submitted"
  → Claude Code exits
```

### Error handling (daemon)
```
Claude Code exits with non-zero code or timeout (5 min)
  → daemon sends to Telegram:
     "⚠️ Error: <task description> — <error type>
      [🔄 Retry]"
  → retry-<jobId>-<action> callback: daemon re-enqueues the same task
```

## Telegram Buttons

All interaction through inline buttons only. No freeform text input.

| Context | Buttons |
|---------|---------|
| New job card | ✅ Apply / ❌ Skip |
| Generated proposal | ✅ Send / ❌ Cancel / 🔄 Redo |
| Error | 🔄 Retry |

## Project Structure

```
upwork-agent/
├── CLAUDE.md                       # Agent context: who you are, rules, tools
├── package.json
├── tsconfig.json
├── .env                            # BOT_TOKEN, OWNER_CHAT_ID, TIMEZONE, SEARCH_INTERVAL_MIN
├── .gitignore
├── docs/
│   └── plans/
│       └── 2026-02-24-upwork-agent-design.md
├── src/
│   ├── daemon.ts                   # yarn daemon — Grammy bot + browser server + cron + mutex
│   ├── morning.ts                  # yarn morning — briefing (stats from DB, browser status)
│   ├── tg.ts                       # yarn tg send|send-job — send to Telegram
│   ├── jobs.ts                     # yarn jobs add|get|list|find|check|update|stats
│   └── db/
│       ├── index.ts                # SQLite connection + migrations
│       ├── schema.ts               # Table creation
│       └── search.ts               # FTS5 full-text search
├── data/
│   ├── profile.md                  # Ivan's experience, skills, proposal writing style
│   ├── logs/                       # Daily logs (YYYY-MM-DD.md), rotated automatically
│   └── jobs.db                     # SQLite database (gitignored)
└── scripts/
    └── setup.sh                    # Initial setup
```

### Grammy daemon (src/daemon.ts)

The orchestrator. Manages three concerns: Telegram buttons, task queue, and cron.

```typescript
// Pseudocode daemon.ts
import { Bot } from 'grammy';
import { execFile } from 'child_process';

const bot = new Bot(BOT_TOKEN);
const taskQueue: Array<{ task: string; label: string }> = [];
let isClaudeRunning = false;

// Owner-only
bot.use(ownerOnly(OWNER_CHAT_ID));

// --- Job buttons ---

// "Apply" button → generate proposal
bot.callbackQuery(/^approve-/, async (ctx) => {
  const jobId = extractJobId(ctx);
  await ctx.answerCallbackQuery({ text: "⏳ Generating proposal..." });
  enqueueTask({
    label: `generate proposal for ${jobId}`,
    task: `Generate proposal for job ${jobId}.
      Read the job (yarn jobs get ${jobId}), read data/profile.md.
      Search similar past jobs (yarn jobs find) for style reference.
      Generate cover letter, send via yarn tg send.`
  });
});

// "Skip" button → no Claude needed
bot.callbackQuery(/^skip-/, async (ctx) => {
  const jobId = extractJobId(ctx);
  await ctx.answerCallbackQuery({ text: "⏭ Skipped" });
  db.updateJobStatus(jobId, 'skipped');
});

// --- Proposal buttons ---

// "Send" button → submit to Upwork
bot.callbackQuery(/^confirm-/, async (ctx) => {
  const jobId = extractJobId(ctx);
  await ctx.answerCallbackQuery({ text: "⏳ Submitting..." });
  enqueueTask({
    label: `submit proposal for ${jobId}`,
    task: `Submit proposal for job ${jobId}.
      yarn jobs get ${jobId}, open Upwork via Playwright MCP,
      fill proposal form, submit.`
  });
});

// "Cancel" button → no Claude needed
bot.callbackQuery(/^cancel-/, async (ctx) => {
  const jobId = extractJobId(ctx);
  await ctx.answerCallbackQuery({ text: "❌ Cancelled" });
  db.updateJobStatus(jobId, 'cancelled');
});

// "Redo" button → regenerate proposal
bot.callbackQuery(/^redo-/, async (ctx) => {
  const jobId = extractJobId(ctx);
  await ctx.answerCallbackQuery({ text: "⏳ Regenerating..." });
  enqueueTask({
    label: `redo proposal for ${jobId}`,
    task: `Redo proposal for job ${jobId}. Previous was rejected.
      Read the job (yarn jobs get ${jobId}), read data/profile.md.
      Generate a different cover letter, send via yarn tg send.`
  });
});

// "Retry" button → re-run failed task
bot.callbackQuery(/^retry-/, async (ctx) => {
  const { jobId, action } = extractRetryInfo(ctx);
  await ctx.answerCallbackQuery({ text: "⏳ Retrying..." });
  // Re-enqueue the original task based on action type
  enqueueTask(rebuildTask(jobId, action));
});

// --- Cron ---

schedule(`*/${SEARCH_INTERVAL_MIN} 8-23 * * *`, () => {
  enqueueTask({
    label: 'periodic job search',
    task: `Search for new jobs on Upwork.
      Run yarn morning for context.
      Open Upwork search via Playwright MCP.
      For each new job: check DB, assess relevance, save, send good ones.`
  });
});

// --- Task queue with mutex ---

function enqueueTask(task: { task: string; label: string }) {
  taskQueue.push(task);
  processQueue();
}

function processQueue() {
  if (isClaudeRunning || taskQueue.length === 0) return;
  isClaudeRunning = true;
  const { task, label } = taskQueue.shift()!;

  const proc = execFile('claude', ['-p', task], {
    cwd: PROJECT_DIR,
    timeout: 300000
  });

  proc.on('exit', (code) => {
    isClaudeRunning = false;
    if (code !== 0) {
      sendTelegramError(label); // "⚠️ Error: ... [🔄 Retry]"
    }
    processQueue(); // Run next task in queue
  });
}

bot.start();
```

## Database (SQLite + FTS5)

### Jobs table
```sql
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,                -- Upwork job ID from URL
  title TEXT NOT NULL,
  description TEXT,                   -- Full description
  budget TEXT,                        -- "$1000-5000" or "$50/hr"
  job_type TEXT,                      -- "fixed" | "hourly"
  skills TEXT,                        -- JSON: ["React", "TypeScript", ...]
  client_rating REAL,
  client_hires INTEGER,
  client_location TEXT,
  client_spent TEXT,                  -- How much the client has spent on Upwork
  proposals_count TEXT,               -- "5 to 10", "Less than 5"
  posted_at TEXT,                     -- When published
  url TEXT NOT NULL,
  relevance_score REAL,               -- 0-10, agent's assessment
  relevance_reason TEXT,              -- Why this score
  status TEXT DEFAULT 'new',          -- new → sent → approved → applied → skipped → cancelled
  proposal_text TEXT,                 -- Generated cover letter
  bid_amount TEXT,                    -- Proposed rate
  applied_at TEXT,                    -- When proposal was submitted
  telegram_message_id INTEGER,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_created ON jobs(created_at);
CREATE INDEX idx_jobs_relevance ON jobs(relevance_score);
```

Status flow:
- `new` → job found and saved
- `sent` → sent to Telegram with buttons
- `approved` → Ivan pressed Apply, proposal being generated
- `applied` → proposal approved by Ivan and submitted to Upwork (good example for learning)
- `skipped` → Ivan pressed Skip
- `cancelled` → Ivan rejected the generated proposal (bad example for learning)

### Full-text search (FTS5)
```sql
CREATE VIRTUAL TABLE jobs_fts USING fts5(
  title,
  description,
  skills,
  relevance_reason,
  content='jobs',
  content_rowid='rowid',
  tokenize='porter unicode61'
);
```

Used for two purposes:
1. `yarn jobs find "react e-commerce"` → find jobs by keywords
2. **Proposal learning**: before generating a new proposal, agent searches for similar past jobs and uses `applied` proposals as positive examples, `cancelled` as negative

### Statistics (computed from jobs table)

No separate sessions table. All stats computed on the fly:

```sql
-- Today's stats
SELECT
  count(*) as found,
  sum(status = 'sent') as sent,
  sum(status = 'applied') as applied
FROM jobs WHERE created_at >= unixepoch('now', 'start of day');

-- Weekly stats
SELECT ... FROM jobs WHERE created_at >= unixepoch('now', '-7 days');
```

## Yarn commands (agent tools)

| Command | Purpose |
|---------|---------|
| `yarn morning` | Briefing: stats from DB, browser status, pending actions |
| `yarn tg send "text"` | Send a message to Ivan in Telegram |
| `yarn tg send-job <jobId>` | Send a job card with [✅ Apply] [❌ Skip] buttons |
| `yarn jobs add --title "..." --url "..." ...` | Add a job to DB |
| `yarn jobs get <id>` | Get a job by ID (with proposal_text if exists) |
| `yarn jobs check <url>` | Check if job already in DB |
| `yarn jobs list [--status applied]` | List jobs with filter |
| `yarn jobs find "react web3"` | FTS5 search across jobs |
| `yarn jobs update <id> --status applied` | Update status |
| `yarn jobs stats [--today\|--week]` | Statistics (computed from jobs table) |

## yarn morning — Briefing

Used only during cron search tasks. Outputs context to stdout:

```
# Briefing — 2026-02-24 10:30

## Browser
Status: ✅ Connected (CDP)

## Stats
Today: 12 jobs found, 3 sent to Telegram, 1 applied
This week: 87 found, 18 sent, 5 applied
All time: 342 found, 61 sent, 23 applied

## Pending
- Job "Senior React Dev" (abc123) — approved, awaiting proposal generation
- Job "Web3 Frontend" (def456) — sent to Telegram, awaiting response
```

## CLAUDE.md — Agent context

CLAUDE.md provides identity, rules, and tools — not workflow. The specific task comes from daemon.

```markdown
# Upwork Agent

You are an autonomous agent that searches for work on Upwork for Ivan.
You receive specific tasks from the daemon. Execute them and exit.

## Rules
- DO NOT apply without Ivan's confirmation
- Behave on Upwork like a human: random delays (1-5s) between actions
- Scroll through pages naturally, don't jump
- Log actions to data/logs/YYYY-MM-DD.md
- If Upwork session died → yarn tg send "⚠️ Session expired"
- If CAPTCHA detected → yarn tg send "⚠️ CAPTCHA, please solve manually"

## Relevance scoring
Read data/profile.md. Score 0-10:
- 8-10: Perfect match of stack + experience
- 6-7: Good match, worth applying
- 4-5: Partial match
- 0-3: Not a fit
Only send jobs scoring ≥ 6 to Telegram.

## Proposal generation
When generating proposals:
1. Read the job (yarn jobs get <id>)
2. Read data/profile.md for Ivan's experience and style
3. Search for similar past jobs: yarn jobs find "<keywords>"
   - Proposals with status=applied → examples of GOOD proposals
   - Proposals with status=cancelled → examples of BAD proposals
4. Generate a cover letter matching Ivan's style and past successes

## Tools
- yarn morning — get briefing and stats
- yarn tg send "text" — message Ivan
- yarn tg send-job <id> — send job card with buttons
- yarn jobs add|get|check|list|find|update|stats — manage jobs DB
- Playwright MCP — browse Upwork (connected via CDP to persistent browser)

## About Ivan
Fullstack developer, 5+ years. Stack: TypeScript, React, Next.js,
Node.js, Web3, AI/LLM. Lives in Vietnam (GMT+7).
Details: data/profile.md
```

## Human-like behavior (anti-detection)

| Measure | Implementation |
|---------|---------------|
| Persistent browser | Single browser daemon via CDP. Real cookies, localStorage, fingerprint. Never restarts unless crashed |
| Random delays | 1-5 seconds between page navigations and clicks |
| Scrolling simulation | Scroll through results like a human, not instant jumps |
| Working hours only | Cron runs 8:00-23:00 GMT+7 only |
| Rate limits | Configurable search interval (SEARCH_INTERVAL_MIN), max 3-5 proposals per hour |
| Sequential browsing | Single tab, no parallel requests. Mutex ensures one Claude Code at a time |
| Session health | Daemon checks browser before cron tasks. Detect login page / CAPTCHA → notify Ivan with button |

## Setup

### Initial setup
```bash
cd /Users/user/project/dev/upwork-agent
npm install
cp .env.example .env
# Fill in .env: BOT_TOKEN, OWNER_CHAT_ID, TIMEZONE, SEARCH_INTERVAL_MIN
```

### .env
```
BOT_TOKEN=...                    # Telegram bot token
OWNER_CHAT_ID=...                # Ivan's Telegram chat ID
TIMEZONE=Asia/Bangkok            # GMT+7
SEARCH_INTERVAL_MIN=30           # Minutes between job searches
```

### First Upwork login
Start the browser daemon, open Upwork manually, log in with 2FA.
The session is saved in the persistent browser context.

### Starting
```bash
# Start everything:
yarn daemon

# The daemon will:
# - Launch Playwright browser server (CDP)
# - Listen to Telegram buttons
# - Run cron searches every SEARCH_INTERVAL_MIN minutes
# - Spawn Claude Code per task with mutex queue
```

## Cost

- Claude Max subscription — $0 additional
- Playwright — free
- Grammy — free
- SQLite — free
- **Total: $0 on top of subscription**

## Implementation stages

### Stage 1: Foundation
- package.json, tsconfig.json, .env, .gitignore
- SQLite: jobs table + FTS5
- `yarn jobs` CLI (add, get, check, list, find, update, stats)

### Stage 2: Grammy daemon + Telegram
- Grammy daemon (daemon.ts): owner-only, button handlers, mutex + task queue
- Browser daemon (Playwright server via CDP) launched from daemon.ts
- `yarn tg send / send-job` (CLI for Claude Code)
- Inline buttons: Apply / Skip / Send / Cancel / Redo / Retry
- execFile-based spawnClaude with error handling

### Stage 3: Briefing
- `yarn morning` — stats from DB, browser status, pending actions
- data/logs/ — daily rotation

### Stage 4: CLAUDE.md + integration
- Write CLAUDE.md (context, not workflow)
- data/profile.md (filled in by Ivan)
- Test: daemon spawns Claude Code, it reads CLAUDE.md, executes task

### Stage 5: Proposals + learning
- Cover letter generation (Claude reads job + profile.md + similar past proposals)
- Proposal learning loop: FTS5 search for similar jobs, applied=good, cancelled=bad
- Submission via Playwright MCP
- Full cycle: search → Telegram → Apply → proposal → Send → submit

### Stage 6: Hardening
- launchd / pm2 for daemon persistence
- Log rotation
- Error handling and edge cases
- Adaptive cron interval tuning

## Risks

| Risk | Probability | Mitigation |
|------|-------------|------------|
| Upwork ban | Medium | Persistent browser (CDP), human-like delays, rate limits, working hours, single tab |
| Session expired | Medium | Daemon checks browser before tasks, Telegram notification with button |
| CAPTCHA | Low | Detection + Telegram notification + manual solve |
| Bad proposal | Low | Review in Telegram before submission. Learning from past approved/rejected proposals |
| Max plan limit | Low | Configurable interval (default 30 min), ~30 cron launches/day. Buttons prioritized over cron |
| Concurrent access | Eliminated | Mutex + task queue in daemon |
| Browser crash | Low | Daemon detects and restarts browser server, notifies Ivan |
