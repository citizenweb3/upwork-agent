import 'dotenv/config';
import { Bot, InlineKeyboard } from 'grammy';
import cron from 'node-cron';
import { spawn, execSync } from 'node:child_process';
import { mkdirSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { db } from './db/index.js';

// --- Environment ---

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const ALLOWED_USERS = process.env.ALLOWED_USERS;
const SEARCH_INTERVAL_MIN = process.env.SEARCH_INTERVAL_MIN ?? '20';
const TIMEZONE = process.env.TIMEZONE ?? 'Europe/Lisbon';
function defaultChromePath(): string {
  switch (process.platform) {
    case 'darwin':
      return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    case 'linux':
      return '/usr/bin/google-chrome-stable';
    default:
      return 'google-chrome';
  }
}

const CHROME_PATH = process.env.CHROME_PATH ?? defaultChromePath();
const IS_DOCKER = existsSync('/.dockerenv');
const JOBS_PER_SEARCH = Number(process.env.JOBS_PER_SEARCH ?? '10');

if (!BOT_TOKEN) {
  console.error('Error: BOT_TOKEN is not set in .env');
  process.exit(1);
}

if (!CHAT_ID) {
  console.error('Error: CHAT_ID is not set in .env');
  process.exit(1);
}

if (!ALLOWED_USERS) {
  console.error('Error: ALLOWED_USERS is not set in .env');
  process.exit(1);
}

const CWD = process.cwd();
const chatId = Number(CHAT_ID);
const allowedUsers = new Set(ALLOWED_USERS.split(',').map(id => Number(id.trim())));

// --- Profile (read fresh on each proposal) ---

function readProfile(): string {
  try {
    return readFileSync('data/profile.md', 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[profile] Cannot read data/profile.md: ${msg}`);
    return '';
  }
}

// --- Browser Server ---

const BROWSER_DATA_DIR = 'data/browser-data';
let chromeProcess: ReturnType<typeof spawn> | null = null;
let shuttingDown = false;
let searchTimer: ReturnType<typeof setTimeout> | null = null;
const cdpPort = 9222;
const DOCKER_DISPLAY_WIDTH = 1920;
const DOCKER_DISPLAY_HEIGHT = 1080;

async function waitForCDP(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  let attempts = 0;
  while (Date.now() - start < timeoutMs) {
    attempts++;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) {
        console.log(`[cdp] Ready after ${attempts} attempt(s) (${Date.now() - start}ms)`);
        return;
      }
      console.log(`[cdp] Attempt ${attempts}: HTTP ${res.status}`);
    } catch (err) {
      if (attempts % 5 === 0) {
        console.log(`[cdp] Attempt ${attempts}: ${err instanceof Error ? err.message : 'connection refused'}`);
      }
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Chrome CDP not available after ${attempts} attempts (${timeoutMs}ms)`);
}

async function killExistingChrome(): Promise<void> {
  try {
    const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
    if (res.ok) {
      console.log(`Found existing Chrome on port ${cdpPort}, killing...`);
      try {
        // Try graceful shutdown first — exclude our own PID to avoid killing ourselves
        const myPid = process.pid;
        console.log(`[chrome] Sending SIGTERM to processes on port ${cdpPort} (excluding pid ${myPid})`);
        execSync(`lsof -ti:${cdpPort} | grep -v '^${myPid}$' | xargs kill`, { stdio: 'ignore' });
        await new Promise(r => setTimeout(r, 3000));
        // Check if still alive, force kill if needed
        try {
          const check = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
          if (check.ok) {
            console.log('[chrome] Still alive after SIGTERM, sending SIGKILL');
            execSync(`lsof -ti:${cdpPort} | grep -v '^${myPid}$' | xargs kill -9`, { stdio: 'ignore' });
            await new Promise(r => setTimeout(r, 1000));
          }
        } catch {
          console.log('[chrome] Exited gracefully after SIGTERM');
        }
      } catch {
        console.log('[chrome] No process found on port, good');
      }
    }
  } catch {
    console.log('[chrome] No existing Chrome on CDP port, clean start');
  }
}

async function launchBrowser(): Promise<void> {
  await killExistingChrome();
  mkdirSync(BROWSER_DATA_DIR, { recursive: true });

  const userDataDir = path.resolve(BROWSER_DATA_DIR);
  console.log(`Launching Chrome: ${CHROME_PATH}`);
  console.log(`  --remote-debugging-port=${cdpPort} --user-data-dir=${userDataDir}`);

  const chromeArgs = [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    ...(IS_DOCKER ? [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      `--window-size=${DOCKER_DISPLAY_WIDTH},${DOCKER_DISPLAY_HEIGHT}`,
      '--window-position=0,0',
      '--start-maximized',
    ] : []),
  ];
  chromeProcess = spawn(CHROME_PATH, chromeArgs, { detached: true, stdio: 'ignore' });

  console.log(`Chrome spawned (pid ${chromeProcess.pid})`);

  chromeProcess.on('error', (err) => {
    console.error('Chrome process error:', err);
  });

  console.log('Waiting for CDP...');
  await waitForCDP(cdpPort, 15000);
  console.log('Chrome ready (CDP available)');
}

// --- Task Queue (Mutex) ---

const ACTION_EFFORT: Record<string, string> = {
  search: 'medium',
  propose: 'high',
  redo: 'high',
  submit: 'low',
};

interface QueueItem {
  task: string;
  label: string;
  jobId?: string;
  action?: string;
  retries?: number;
  allowedTools?: string;
}

const taskQueue: QueueItem[] = [];
let isClaudeRunning = false;
let currentAction: string | undefined;
let currentClaudeProc: ReturnType<typeof spawn> | null = null;

function enqueueTask(item: QueueItem): void {
  // Deduplicate search: skip if already queued or currently running
  const searchActions = ['search'];
  if (item.action && searchActions.includes(item.action)) {
    if (taskQueue.some(t => t.action && searchActions.includes(t.action)) ||
        (isClaudeRunning && currentAction && searchActions.includes(currentAction))) {
      console.log(`[queue] Skipping duplicate: ${item.label}`);
      return;
    }
  }
  // Deduplicate job-specific actions
  if (item.jobId && item.action) {
    const dup = taskQueue.find(t => t.jobId === item.jobId && t.action === item.action);
    if (dup) {
      console.log(`[queue] Skipping duplicate: ${item.label}`);
      return;
    }
  }
  taskQueue.push(item);
  console.log(`[queue] Enqueued: ${item.label} (queue size: ${taskQueue.length})`);
  processQueue();
}

function logToFile(label: string, content: string): void {
  const logDir = 'data/logs';
  mkdirSync(logDir, { recursive: true });
  const logFile = `${logDir}/claude-tasks.log`;
  const timestamp = new Date().toISOString();
  appendFileSync(logFile, `\n=== [${timestamp}] ${label} ===\n${content}\n`);
}

function processQueue(): void {
  _processQueue().catch(err => {
    console.error('[queue] processQueue error:', err instanceof Error ? err.message : err);
    isClaudeRunning = false;
    currentAction = undefined;
    currentClaudeProc = null;
  });
}

async function _processQueue(): Promise<void> {
  if (isClaudeRunning) {
    console.log(`[queue] Busy (running: ${currentAction}), ${taskQueue.length} tasks waiting`);
    return;
  }
  if (taskQueue.length === 0) return;
  isClaudeRunning = true;
  const item = taskQueue.shift()!;
  const { task, label, jobId, action } = item;
  currentAction = action;

  console.log(`[queue] Running: ${label} (${taskQueue.length} remaining in queue)`);

  const cleanEnv = { ...process.env };
  delete cleanEnv.CLAUDECODE;

  const tools = item.allowedTools ?? 'mcp__upwork__*,Bash,Read,Write';
  const args = ['-p', task, '--allowedTools', tools, '--output-format', 'stream-json', '--verbose'];

  // Haiku for submit (simple form filling), Sonnet for search/propose/redo.
  // Effort tuned per action: submit=low (mechanical), search=medium, propose/redo=high (quality matters).
  const model = action === 'submit' ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-4-6';
  const effort = ACTION_EFFORT[action ?? ''] ?? 'medium';
  args.push('--model', model, '--effort', effort);

  logToFile(label, `SPAWN: claude ${args.join(' ').slice(0, 500)}\nCWD: ${CWD}`);

  const TASK_TIMEOUT = 1_200_000;
  const startedAt = Date.now();

  const proc = spawn('claude', args, {
    cwd: CWD,
    timeout: TASK_TIMEOUT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: cleanEnv,
  });
  currentClaudeProc = proc;
  console.log(`[queue] Claude spawned (pid: ${proc.pid}, action: ${action}, model: ${model}, effort: ${effort})`);

  let stdout = '';
  let stderr = '';
  let lineBuffer = '';
  proc.stdout.on('data', (d: Buffer) => {
    const chunk = d.toString();
    stdout += chunk;
    lineBuffer += chunk;

    // Parse stream-json lines
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() ?? ''; // keep incomplete last line in buffer
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === 'assistant' && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === 'tool_use') {
              logToFile(label, `TOOL_CALL: ${block.name}\n${JSON.stringify(block.input).slice(0, 2000)}`);
            } else if (block.type === 'text') {
              logToFile(label, `ASSISTANT: ${block.text.slice(0, 1000)}`);
            }
          }
        } else if (event.type === 'result') {
          logToFile(label, `RESULT: cost=$${event.cost_usd?.toFixed(4) ?? '?'} turns=${event.num_turns ?? '?'}\n${(event.result ?? '').slice(0, 1000)}`);
        }
      } catch {
        // Not JSON or incomplete — log raw
        if (line.length > 5) logToFile(label, `RAW: ${line.slice(0, 500)}`);
      }
    }
  });
  proc.stderr.on('data', (d: Buffer) => {
    stderr += d.toString();
    logToFile(label, `STDERR: ${d.toString().slice(0, 1000)}`);
  });

  proc.on('exit', (code, signal) => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const retries = item.retries ?? 0;
    const isTimeout = signal === 'SIGTERM' && elapsed >= Math.round(TASK_TIMEOUT / 1000) - 5;
    console.log(`[queue] Exit: ${label} code=${code} signal=${signal} elapsed=${elapsed}s retries=${retries} timeout=${isTimeout}`);

    // Extract final result text from stream-json
    let resultText = '';
    for (const line of stdout.split('\n')) {
      try {
        const event = JSON.parse(line);
        if (event.type === 'result' && event.result) resultText = event.result;
      } catch { /* not json */ }
    }

    logToFile(label, `EXIT: code=${code} signal=${signal} elapsed=${elapsed}s retries=${retries}\nRESULT: ${resultText.slice(0, 2000)}\nSTDERR (${stderr.length} chars): ${stderr.slice(0, 2000)}`);

    isClaudeRunning = false;
    currentAction = undefined;
    currentClaudeProc = null;

    if (code === 0) {
      console.log(`[queue] Done: ${label} (${elapsed}s)`);

      if (action === 'search') {
        const lower = resultText.toLowerCase();
        const isSessionIssue = lower.includes('session expired') || lower.includes('log in manually');
        const isCaptcha = lower.includes('captcha');
        if (!isSessionIssue && !isCaptcha) {
          const summary = resultText.trim().slice(0, 1500) || `Search completed in ${elapsed}s, no output.`;
          notify(`\u2705 ${summary}`).catch(console.error);
        }
      }
    } else if (!isTimeout && action !== 'submit') {
      const reason = diagnoseFailure(code, signal, stderr, stdout, elapsed, TASK_TIMEOUT);
      const isAuthError = reason.includes('authentication error');
      const isRateLimit = reason.includes('rate limit') || isAuthError;
      const maxRetries = isRateLimit ? 3 : 1;

      if (retries < maxRetries) {
        const delaySec = isRateLimit ? 60 * (retries + 1) : 0;
        const delayMin = Math.round(delaySec / 60);
        console.log(`[queue] Failed: ${label} — ${reason}. Retrying in ${delaySec}s (attempt ${retries + 2}/${maxRetries + 1})...`);
        logToFile(label, `AUTO-RETRY: attempt ${retries + 2}, delay ${delaySec}s`);
        if (isAuthError) {
          notify(`\u26d4 Claude Code auth failed — check CLAUDE_CODE_OAUTH_TOKEN in .env. Retrying in ${delayMin} min (attempt ${retries + 2}/${maxRetries + 1})...`).catch(console.error);
        } else if (isRateLimit) {
          notify(`\u23f3 Rate limit reached. Retrying in ${delayMin} min (attempt ${retries + 2}/${maxRetries + 1})...`).catch(console.error);
        } else {
          notify(`\ud83d\udd04 ${label} failed, retrying...\n${reason.slice(0, 200)}`).catch(console.error);
        }
        const retryItem = { ...item, retries: retries + 1 };
        if (delaySec > 0) {
          setTimeout(() => {
            taskQueue.unshift(retryItem);
            processQueue();
          }, delaySec * 1000);
          return;
        } else {
          taskQueue.unshift(retryItem);
        }
      } else if (isRateLimit) {
        console.error(`[queue] Rate limit: ${label} — retries exhausted (${retries + 1} attempts over ${elapsed}s)`);
        notify(`\u26a0\ufe0f Rate limit — all ${retries + 1} retries failed. Will try again on next scheduled search.`).catch(console.error);
      } else {
        console.error(`[queue] Failed: ${label} — ${reason} (${elapsed}s, ${retries + 1} retries exhausted)`);
        sendError(label, reason, jobId, action).catch(console.error);
      }
    } else {
      const reason = diagnoseFailure(code, signal, stderr, stdout, elapsed, TASK_TIMEOUT);
      console.error(`[queue] Failed: ${label} — ${reason} (${elapsed}s)`);
      sendError(label, reason, jobId, action).catch(console.error);
    }

    processQueue();
  });

  proc.on('error', (err) => {
    isClaudeRunning = false;
    currentAction = undefined;
    currentClaudeProc = null;
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    logToFile(label, `SPAWN ERROR (${elapsed}s): ${err.message}\n${err.stack}`);
    console.error(`[queue] Spawn error: ${label}`, err);
    sendError(label, `Failed to start Claude: ${err.message}`, jobId, action).catch(console.error);
    processQueue();
  });
}

function diagnoseFailure(
  code: number | null,
  signal: string | null,
  stderr: string,
  stdout: string,
  elapsedSec: number,
  timeoutMs: number,
): string {
  const timeoutSec = Math.round(timeoutMs / 1000);
  const output = stderr || stdout;

  // Timeout — killed by Node's spawn timeout (SIGTERM)
  if (signal === 'SIGTERM' && elapsedSec >= timeoutSec - 5) {
    return `Timeout after ${elapsedSec}s (limit ${timeoutSec}s). The task was taking too long and was killed.`;
  }

  // Other signals (SIGKILL, SIGSEGV, etc.)
  if (signal) {
    return `Process killed by ${signal} after ${elapsedSec}s.${output ? `\n${output.slice(0, 300)}` : ''}`;
  }

  // Claude API or auth errors often appear in stderr
  if (output.includes('API key') || output.includes('authentication') || output.includes('401')) {
    return `Claude API authentication error.\n${output.slice(0, 300)}`;
  }

  if (output.includes('rate limit') || output.includes('429') || output.includes('hit your limit')) {
    return `Claude API rate limited.\n${output.slice(0, 300)}`;
  }

  if (output.includes('overloaded') || output.includes('529')) {
    return `Claude API overloaded.\n${output.slice(0, 300)}`;
  }

  // Generic non-zero exit
  if (output) {
    return `Exit code ${code} after ${elapsedSec}s.\n${output.slice(0, 400)}`;
  }

  return `Exit code ${code} after ${elapsedSec}s (no output captured).`;
}

async function sendError(
  label: string,
  error: string,
  jobId?: string,
  action?: string,
): Promise<void> {
  const text = `\u26a0\ufe0f ${label}\n\n${error.slice(0, 500)}`;

  const keyboard = new InlineKeyboard();
  if (jobId && action) {
    keyboard.text('\ud83d\udd04 Retry', `retry-${jobId}-${action}`);
  }

  await bot.api.sendMessage(chatId, text, {
    reply_markup: keyboard,
  });
}

// --- Task Builders ---

const PROPOSAL_VALIDATION_RULES = [
  'VALIDATION before saving:',
  '- Proposal MUST be 200-3000 characters. If shorter, expand with more detail. If longer, trim.',
  '- Proposal MUST NOT contain placeholder text like "[your name]", "[project]", "I\'m excited about this opportunity".',
  '- Proposal MUST NOT contain any dashes (em dash — or double dash --).',
  '- bid_amount MUST be a number with $ sign (e.g. "$50" for hourly, "$3000" for fixed).',
].join('\n');

const SEARCH_QUERIES = [
  'AI agent build chatbot LLM openai gemini',
  'AI integration API openai claude gemini chatgpt',
  'AI chatbot voice assistant openai gemini GLM',
  'next.js react typescript MVP',
  'react typescript build app',
  'fullstack MVP prototype build ship',
  'web3 ethers.js cosmos EVM dapp',
  'next.js fullstack project short-term',
  'python fastapi django backend API',
  'blockchain data indexer dashboard',
];
function buildSearchTask(): QueueItem {
  const query = SEARCH_QUERIES[Math.floor(Math.random() * SEARCH_QUERIES.length)];
  const delay1 = (2 + Math.random() * 3).toFixed(1);
  const delay2 = (3 + Math.random() * 4).toFixed(1);
  const delay3 = (2 + Math.random() * 3).toFixed(1);
  const pageDelay = (2 + Math.random() * 5).toFixed(1);
  const clickDelay = (1 + Math.random() * 3).toFixed(1);
  return {
    task: [
      'Search for new jobs on Upwork, sort by Most Recent, and extract job details.',
      '',
      'CRITICAL RULES:',
      '- The ONLY URL you may use with browser_navigate is https://www.upwork.com',
      '- NEVER type or construct search URLs directly.',
      `- Between every browser action, wait ${delay3} seconds.`,
      '- If you see "Verify you are human" or Cloudflare spinner: wait 10s, browser_snapshot again. If still blocked after 30s total: `yarn tg send "Cloudflare challenge stuck, please solve manually"` and exit.',
      '- If you see login page or "Log In": `yarn tg send "Session expired, please log in manually"` and exit.',
      '- NEVER navigate to these pages: /freelancers/settings, /ab/payments, /ab/membership, /nx/settings, /ab/create-contract, /ab/billing, /ab/account-security/security, /ab/account-security/password',
      '',
      '=== PHASE 1: Navigate and Search ===',
      '',
      '1. Run `yarn morning` to get context.',
      `2. browser_navigate to https://www.upwork.com. Wait ${delay1} seconds.`,
      '3. browser_snapshot to check page state.',
      `4. Find the search input field. browser_click on it. Wait ${delay3} seconds.`,
      `5. browser_type "${query}" with slowly=true.`,
      `6. browser_press_key Enter. Wait ${delay2} seconds.`,
      '7. browser_snapshot to verify search results loaded.',
      '',
      '=== PHASE 2: Sort by Most Recent ===',
      '',
      '8. Find the sort dropdown — look for text "Sort by: Best Matches" (element with data-test="dropdown-toggle").',
      '9. browser_click on it to open the dropdown.',
      `10. Wait ${delay3} seconds. browser_snapshot to see dropdown options.`,
      '11. browser_click on "Most Recent" option.',
      `12. Wait ${delay2} seconds for results to reload.`,
      '13. browser_snapshot to verify results are sorted.',
      '',
      'SORT FALLBACK: If after 2 attempts you cannot find or click the sort dropdown,',
      'take the current search URL from browser_snapshot, append &sort=recency to it,',
      'and browser_navigate to that URL.',
      'Example: https://www.upwork.com/nx/search/jobs/?nbs=1&q=frontend becomes',
      'https://www.upwork.com/nx/search/jobs/?nbs=1&q=frontend&sort=recency',
      '',
      '=== PHASE 3: Extract Jobs ===',
      '',
      '14. Read data/profile.md for scoring criteria.',
      '',
      '15. Extract job URLs from the current page — run browser_run_code:',
      '  async (page) => {',
      '    await page.waitForSelector(\'a[href*="/jobs/"]\', { timeout: 15000 });',
      '    return await page.evaluate(() => {',
      '      const jobs = [];',
      '      document.querySelectorAll(\'a[href*="/jobs/"]\').forEach(el => {',
      '        const href = el.getAttribute("href") || "";',
      '        const match = href.match(/(~[a-zA-Z0-9]{18,})/);',
      '        if (!match) return;',
      '        const text = (el.textContent || "").trim();',
      '        if (text.length < 10) return;',
      '        const id = match[1];',
      '        jobs.push({ id, title: text.slice(0, 120), url: "https://www.upwork.com/jobs/" + id });',
      '      });',
      '      return JSON.stringify(jobs);',
      '    });',
      '  }',
      '  If jobs array is empty, report: `yarn tg send "Search selectors may be broken, found 0 job links"` and exit.',
      '',
      '16. For each job from the extracted list:',
      '  a. Look at the "Posted X ago" text. If "X days ago" or "X weeks ago" — skip (too old).',
      '  b. Run `yarn jobs check <url>` — if "exists", skip.',
      `  c. browser_click on the job link. Wait ${pageDelay} seconds.`,
      '  d. browser_snapshot to read the full job detail page.',
      '  e. Extract ALL available fields: title, description (~500 chars), budget, job-type, skills, client-rating, client-hires, client-location, client-spent, proposals-count, posted-at.',
      '  f. Score relevance 0-10 based on profile.md.',
      '  g. Save (use SINGLE QUOTES for $ values):',
      '     yarn jobs add --title \'...\' --url \'...\' --description \'...\' --budget \'...\' --job-type \'...\' --skills \'...\' --client-rating N --client-hires N --client-location \'...\' --client-spent \'...\' --proposals-count \'...\' --posted-at \'...\' --relevance-score N --relevance-reason \'...\'',
      '  h. If "duplicate": true in output, do NOT send to Telegram.',
      '  i. If score >= 4 AND newly added: `yarn tg send-job <id>`',
      `  j. browser_navigate_back. Wait ${clickDelay} seconds.`,
      '',
      `17. Process up to ${JOBS_PER_SEARCH} jobs. Do NOT paginate.`,
      '',
      'TIME LIMITS:',
      '- Single page > 30 seconds to load: skip.',
      '- Total > 15 minutes: save what you have and exit.',
      '- Do not retry failed loads.',
    ].join('\n'),
    label: `Search [${query}]`,
    action: 'search',
  };
}

function buildProposeTask(jobId: string): QueueItem {
  return {
    task: [
      `Generate a proposal for job ${jobId}.`,
      '',
      `Step 1: Get the job details: yarn jobs get ${jobId}`,
      'Step 2: Search for similar past jobs to learn from: yarn jobs find "<2-3 keywords from job title/skills>"',
      '  - Jobs with status=applied are examples of GOOD proposals (Ivan approved them).',
      '  - Jobs with status=cancelled are examples of BAD proposals (Ivan rejected them).',
      '  - Use these to calibrate tone, length, and angle.',
      `Step 3: Write a cover letter matching Ivan's style from profile.md.`,
      '',
      'Ivan\'s profile for reference:',
      readProfile(),
      '',
      PROPOSAL_VALIDATION_RULES,
      '',
      `Step 4: Save and send:`,
      `yarn jobs update ${jobId} --proposal-text '...' --bid-amount '...'`,
      `yarn tg send-proposal ${jobId}`,
    ].join('\n'),
    label: `Proposal for ${jobId}`,
    jobId,
    action: 'propose',
  };
}

function buildSubmitTask(jobId: string): QueueItem {
  return {
    task: [
      `Submit the proposal for job ${jobId} on Upwork.`,
      '',
      `Step 1: Get the job: yarn jobs get ${jobId}`,
      '  Note the url, proposal_text, and bid_amount fields.',
      '',
      'Step 2: Open the job URL using browser_navigate.',
      '  Wait 3 seconds for the page to load.',
      '',
      'Step 3: Check the page state:',
      '  - If you see CAPTCHA or "Verify you are human": try clicking the checkbox, wait 5s, check again. If still blocked after 2 attempts: run `yarn tg send "CAPTCHA on proposal submit, please solve manually"` and exit.',
      '  - If you see login page: run `yarn tg send "Session expired, please log in manually"` and exit.',
      '  - If the job is closed/unavailable: run `yarn tg send "Job ${jobId} is closed or unavailable"` and exit.',
      '',
      'Step 4: Find and click the "Apply Now" or "Submit a Proposal" button.',
      '  Wait 3 seconds for the proposal form to load.',
      '',
      'Step 5: Fill the proposal form:',
      '  - Find the cover letter textarea and fill it with proposal_text.',
      '  - Find the rate/bid input and set it to bid_amount (number only, without $).',
      '  - If there is a duration dropdown, leave it at default.',
      '  - If the page says "not enough Connects" or shows 0 Connects available:',
      `    run \`yarn tg send "Not enough Connects for ${jobId}. Buy Connects and press Retry."\``,
      '    Then exit with error (do NOT proceed). The daemon will show a Retry button automatically.',
      '',
      'Step 6: Click the submit/send button to send the proposal.',
      '  Wait 3 seconds and verify the submission was successful (look for confirmation message).',
      '',
      'Step 7: Update and notify:',
      `  yarn jobs update ${jobId} --status applied --applied-at "${new Date().toISOString()}"`,
      `  yarn tg send "Proposal submitted for ${jobId}"`,
    ].join('\n'),
    label: `Submit ${jobId}`,
    jobId,
    action: 'submit',
  };
}

function buildRedoTask(jobId: string): QueueItem {
  return {
    task: [
      `Regenerate the proposal for job ${jobId}. The previous proposal was rejected.`,
      '',
      `Step 1: Get the job: yarn jobs get ${jobId}`,
      '  Read the existing proposal_text carefully. This is the REJECTED version. Do NOT reuse its structure, opening, or angle.',
      'Step 2: Search for similar past jobs: yarn jobs find "<2-3 keywords from job title/skills>"',
      '  - Look at applied/cancelled proposals for calibration.',
      'Step 3: Write a COMPLETELY different cover letter. Change the opening hook, the referenced project, and the overall angle.',
      '',
      'Ivan\'s profile for reference:',
      readProfile(),
      '',
      PROPOSAL_VALIDATION_RULES,
      '',
      `Step 4: Save and send:`,
      `yarn jobs update ${jobId} --proposal-text '...' --bid-amount '...'`,
      `yarn tg send-proposal ${jobId}`,
    ].join('\n'),
    label: `Redo proposal for ${jobId}`,
    jobId,
    action: 'redo',
  };
}

function rebuildTask(jobId: string, action: string): QueueItem {
  switch (action) {
    case 'search':
      return buildSearchTask();
    case 'propose': return buildProposeTask(jobId);
    case 'submit': return buildSubmitTask(jobId);
    case 'redo': return buildRedoTask(jobId);
    default: return { task: `Retry action "${action}" for job ${jobId}`, label: `Retry ${action} ${jobId}`, jobId, action };
  }
}

// --- Helper ---

function getJobStatus(jobId: string): string | null {
  const row = db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId) as { status: string } | undefined;
  return row?.status ?? null;
}

function getJobTitle(jobId: string): string {
  const row = db.prepare('SELECT title FROM jobs WHERE id = ?').get(jobId) as { title: string } | undefined;
  return row?.title ?? jobId;
}

async function notify(text: string): Promise<void> {
  try {
    await bot.api.sendMessage(chatId, text);
  } catch (err) {
    console.error('[notify] Failed:', err instanceof Error ? err.message : err);
  }
}

// --- Grammy Bot ---

const bot = new Bot(BOT_TOKEN);

bot.catch((err) => {
  console.error('Grammy error:', err.stack ?? err.message);
});

// Debug: log all incoming updates
bot.use((ctx, next) => {
  console.log(`[bot] Update from ${ctx.from?.id}: ${ctx.message?.text ?? ctx.callbackQuery?.data ?? 'unknown'}`);
  // Allowed users filter
  if (!ctx.from || !allowedUsers.has(ctx.from.id)) {
    console.log(`[bot] Blocked: user ${ctx.from?.id} not in ALLOWED_USERS`);
    return;
  }
  return next();
});

// Safe answer helper — old callbacks may expire, don't crash
async function answer(ctx: { answerCallbackQuery: (text: string) => Promise<unknown> }, text: string): Promise<void> {
  try {
    await ctx.answerCallbackQuery(text);
  } catch (err) {
    console.log(`[bot] Callback answer failed (expired?): ${err instanceof Error ? err.message : err}`);
  }
}

// /search command — manual trigger
bot.command('search', async (ctx) => {
  await ctx.reply('\u23f3 Starting job search...');
  enqueueTask(buildSearchTask());
});

// /status command — queue info
bot.command('status', async (ctx) => {
  const queueLen = taskQueue.length;
  const running = isClaudeRunning ? 'Yes' : 'No';
  let browserOk = 'Down';
  try {
    const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
    if (res.ok) browserOk = 'Running';
  } catch {}
  await ctx.reply(`Browser: ${browserOk}\nClaude running: ${running}\nQueue: ${queueLen} tasks`);
});

// /report command — job statistics
bot.command('report', async (ctx) => {
  const arg = ctx.match?.trim();
  let timeFilter = '';
  let timeFilterAnd = '';
  let period = 'Today';

  if (arg === 'week') {
    timeFilter = `WHERE created_at >= unixepoch('now', '-7 days')`;
    timeFilterAnd = `AND created_at >= unixepoch('now', '-7 days')`;
    period = 'This week';
  } else if (arg === 'all') {
    timeFilter = '';
    timeFilterAnd = '';
    period = 'All time';
  } else {
    timeFilter = `WHERE created_at >= unixepoch('now', 'start of day')`;
    timeFilterAnd = `AND created_at >= unixepoch('now', 'start of day')`;
  }

  const stats = db.prepare(`
    SELECT
      COUNT(*) as found,
      SUM(CASE WHEN status IN ('sent','approved','applied','skipped','cancelled') THEN 1 ELSE 0 END) as sent_to_tg,
      SUM(CASE WHEN status = 'applied' THEN 1 ELSE 0 END) as applied,
      SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) as skipped,
      SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled,
      ROUND(AVG(relevance_score), 1) as avg_score
    FROM jobs ${timeFilter}
  `).get() as Record<string, number | null>;

  // Score distribution
  const byScore = db.prepare(`
    SELECT
      CASE
        WHEN relevance_score >= 8 THEN '8-10'
        WHEN relevance_score >= 6 THEN '6-7'
        WHEN relevance_score >= 4 THEN '4-5'
        ELSE '0-3'
      END as bracket,
      COUNT(*) as count
    FROM jobs ${timeFilter}
    GROUP BY bracket
    ORDER BY bracket DESC
  `).all() as { bracket: string; count: number }[];

  // Top skills
  const sentJobs = db.prepare(`
    SELECT skills FROM jobs
    WHERE skills IS NOT NULL
      AND status IN ('sent','approved','applied','skipped','cancelled')
      ${timeFilterAnd}
  `).all() as { skills: string }[];

  const skillCounts = new Map<string, number>();
  for (const row of sentJobs) {
    const skills = row.skills.split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean);
    for (const skill of skills) {
      skillCounts.set(skill, (skillCounts.get(skill) ?? 0) + 1);
    }
  }
  const topSkills = [...skillCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

  // Jobs by pipeline stage
  type ReportJob = { title: string; budget: string | null; relevance_score: number | null; status: string; url: string; telegram_message_id: number | null; telegram_proposal_message_id: number | null };

  const jobFields = 'title, budget, relevance_score, status, url, telegram_message_id, telegram_proposal_message_id';

  const countOf = (status: string) =>
    (db.prepare(`SELECT COUNT(*) as c FROM jobs WHERE status = ? ${timeFilterAnd}`).get(status) as { c: number }).c;

  const awaitingCount = countOf('sent');
  const pendingSubmitCount = countOf('approved');
  const appliedCount = countOf('applied');

  const awaiting = db.prepare(`
    SELECT ${jobFields} FROM jobs
    WHERE status = 'sent' ${timeFilterAnd}
    ORDER BY created_at DESC LIMIT 5
  `).all() as ReportJob[];

  const pendingSubmit = db.prepare(`
    SELECT ${jobFields} FROM jobs
    WHERE status = 'approved' ${timeFilterAnd}
    ORDER BY created_at DESC LIMIT 5
  `).all() as ReportJob[];

  const applied = db.prepare(`
    SELECT ${jobFields} FROM jobs
    WHERE status = 'applied' ${timeFilterAnd}
    ORDER BY created_at DESC LIMIT 5
  `).all() as ReportJob[];

  // Build message
  const lines: string[] = [
    `\uD83D\uDCCA *Report (${period})*`,
    '',
    `Found: ${stats.found ?? 0} | Sent: ${stats.sent_to_tg ?? 0} | Applied: ${stats.applied ?? 0}`,
    `Skipped: ${stats.skipped ?? 0} | Cancelled: ${stats.cancelled ?? 0}`,
    `Avg score: ${stats.avg_score ?? 'N/A'}`,
  ];

  if (byScore.length > 0) {
    lines.push('', '*Scores:*');
    for (const row of byScore) {
      lines.push(`  ${row.bracket}: ${row.count}`);
    }
  }

  if (topSkills.length > 0) {
    lines.push('', '*Top skills:*');
    lines.push(topSkills.map(([s, c]) => `${s} (${c})`).join(', '));
  }

  // t.me/c/ links only work for supergroups (chat_id format: -100XXXXXXXXXX)
  const chatIdStr = String(chatId);
  const groupId = chatIdStr.startsWith('-100') && chatIdStr.length >= 14 ? chatIdStr.slice(4) : null;

  const formatJob = (job: ReportJob, useProposalLink = false) => {
    const score = job.relevance_score != null ? `${job.relevance_score}` : '?';
    const name = job.title.slice(0, 40);
    const msgId = useProposalLink
      ? (job.telegram_proposal_message_id ?? job.telegram_message_id)
      : job.telegram_message_id;
    if (msgId && groupId) {
      const link = `https://t.me/c/${groupId}/${msgId}`;
      return `  [${score}] [${name}](${link})`;
    }
    return `  [${score}] [${name}](${job.url})`;
  };

  if (awaitingCount > 0) {
    lines.push('', `\u23F3 *Awaiting your decision (${awaitingCount}):*`);
    for (const job of awaiting) lines.push(formatJob(job));
    if (awaitingCount > 5) lines.push(`  _...and ${awaitingCount - 5} more_`);
  }

  if (pendingSubmitCount > 0) {
    lines.push('', `\uD83D\uDCDD *Proposal ready, awaiting send (${pendingSubmitCount}):*`);
    for (const job of pendingSubmit) lines.push(formatJob(job, true));
    if (pendingSubmitCount > 5) lines.push(`  _...and ${pendingSubmitCount - 5} more_`);
  }

  if (appliedCount > 0) {
    lines.push('', `\u2705 *Applied (${appliedCount}):*`);
    for (const job of applied) lines.push(formatJob(job));
    if (appliedCount > 5) lines.push(`  _...and ${appliedCount - 5} more_`);
  }

  if (awaitingCount === 0 && pendingSubmitCount === 0 && appliedCount === 0) {
    lines.push('', '_No active jobs in pipeline_');
  }

  try {
    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
  } catch (err) {
    console.log('[bot] Markdown report failed, sending plain text:', err instanceof Error ? err.message : err);
    await ctx.reply(lines.join('\n'));
  }
});

// Callback query handler
bot.on('callback_query:data', async (ctx) => {
  const data = ctx.callbackQuery.data;

  // retry-{jobId}-{action}
  if (data.startsWith('retry-')) {
    const rest = data.slice('retry-'.length);
    // Job IDs start with ~ and have no dashes; action may contain dashes
    const match = rest.match(/^(~[a-zA-Z0-9]+)-(.+)$/);
    const jobId = match ? match[1] : '';
    const action = match ? match[2] : rest;
    console.log(`[bot] Retry callback: jobId=${jobId}, action=${action}, raw=${data}`);
    await answer(ctx, '\u23f3 Retrying...');
    await notify(`\uD83D\uDD04 Retrying ${action} for "${getJobTitle(jobId)}"...`);
    enqueueTask(rebuildTask(jobId, action));
    return;
  }

  // approve-{jobId}
  if (data.startsWith('approve-')) {
    const jobId = data.split('-').slice(1).join('-');
    console.log(`[bot] Approve callback: jobId=${jobId}`);
    const status = getJobStatus(jobId);
    if (status && status !== 'new' && status !== 'sent') {
      await answer(ctx, `Already ${status}`);
      return;
    }
    await answer(ctx, '\u23f3 Generating proposal...');
    db.prepare('UPDATE jobs SET status = ?, updated_at = unixepoch() WHERE id = ?').run('approved', jobId);
    await notify(`\u23f3 Generating proposal for "${getJobTitle(jobId)}"...`);
    enqueueTask(buildProposeTask(jobId));
    return;
  }

  // skip-{jobId}
  if (data.startsWith('skip-')) {
    const jobId = data.split('-').slice(1).join('-');
    console.log(`[bot] Skip callback: jobId=${jobId}`);
    await answer(ctx, '\u23ed\ufe0f Skipped');
    db.prepare('UPDATE jobs SET status = ?, updated_at = unixepoch() WHERE id = ?').run('skipped', jobId);
    return;
  }

  // confirm-{jobId}
  if (data.startsWith('confirm-')) {
    const jobId = data.split('-').slice(1).join('-');
    console.log(`[bot] Confirm callback: jobId=${jobId}`);
    const status = getJobStatus(jobId);
    if (status === 'applied') {
      await answer(ctx, 'Already applied');
      return;
    }
    await answer(ctx, '\u23f3 Submitting to Upwork...');
    await notify(`\u23f3 Submitting proposal for "${getJobTitle(jobId)}" to Upwork...`);
    enqueueTask(buildSubmitTask(jobId));
    return;
  }

  // cancel-{jobId}
  if (data.startsWith('cancel-')) {
    const jobId = data.split('-').slice(1).join('-');
    console.log(`[bot] Cancel callback: jobId=${jobId}`);
    await answer(ctx, '\u274c Cancelled');
    db.prepare('UPDATE jobs SET status = ?, updated_at = unixepoch() WHERE id = ?').run('cancelled', jobId);
    return;
  }

  // redo-{jobId}
  if (data.startsWith('redo-')) {
    const jobId = data.split('-').slice(1).join('-');
    console.log(`[bot] Redo callback: jobId=${jobId}`);
    await answer(ctx, '\u23f3 Regenerating...');
    await notify(`\uD83D\uDD04 Regenerating proposal for "${getJobTitle(jobId)}"...`);
    enqueueTask(buildRedoTask(jobId));
    return;
  }
});

// --- Search scheduler (randomized setTimeout) ---

function scheduleSearch(): void {
  const baseMin = Number(SEARCH_INTERVAL_MIN);
  const jitterMin = Math.round(baseMin * 0.3); // ±30% jitter
  const delayMs = (baseMin - jitterMin + Math.random() * jitterMin * 2) * 60 * 1000;
  const delayMin = Math.round(delayMs / 60000);

  // Only schedule during working hours (8-23)
  const now = new Date();
  const hour = Number(now.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: TIMEZONE }));
  if (hour < 8 || hour >= 23) {
    // Schedule check at next hour
    const nextCheckMs = (60 - now.getMinutes()) * 60 * 1000;
    console.log(`[search] Outside working hours (${hour}h), checking again in ${Math.round(nextCheckMs / 60000)}min`);
    searchTimer = setTimeout(() => scheduleSearch(), nextCheckMs);
    return;
  }

  console.log(`[search] Next search in ${delayMin}min`);
  searchTimer = setTimeout(() => {
    console.log('[cron] Triggering job search');
    enqueueTask(buildSearchTask());
    scheduleSearch();
  }, delayMs);
}

// --- Cron ---

function startCron(): void {
  // Search: randomized setTimeout with ±30% jitter
  scheduleSearch();

  // Heartbeat: ping Telegram every 6 hours so you know daemon is alive
  cron.schedule('0 */6 * * *', async () => {
    const queueLen = taskQueue.length;
    let browserOk = 'down';
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
      if (res.ok) browserOk = 'ok';
    } catch {}
    notify(`💚 Heartbeat: browser ${browserOk}, queue ${queueLen}`).catch(console.error);
  }, { timezone: TIMEZONE });

  console.log(`Cron scheduled: every ${SEARCH_INTERVAL_MIN}min, 8-23h (${TIMEZONE})`);
}

// --- Graceful Shutdown ---

async function shutdown(): Promise<void> {
  shuttingDown = true;
  if (searchTimer) clearTimeout(searchTimer);
  console.log(`[shutdown] Starting graceful shutdown (claude running: ${isClaudeRunning}, queue: ${taskQueue.length})`);
  if (currentClaudeProc && currentClaudeProc.exitCode === null) {
    console.log(`[shutdown] Stopping running Claude process (pid: ${currentClaudeProc.pid}, action: ${currentAction})...`);
    currentClaudeProc.kill('SIGTERM');
    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => { resolve(); }, 5000);
      currentClaudeProc!.on('exit', () => { clearTimeout(timeout); resolve(); });
    });
  }
  console.log('[shutdown] Stopping Grammy bot...');
  bot.stop();
  if (chromeProcess && chromeProcess.exitCode === null) {
    console.log(`Stopping Chrome (pid ${chromeProcess.pid})...`);
    chromeProcess.kill('SIGTERM');
    // Give Chrome time to flush cookies/session to disk
    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => {
        console.log('Chrome did not exit in time, force killing...');
        chromeProcess?.kill('SIGKILL');
        resolve();
      }, 10_000);
      chromeProcess!.on('exit', () => {
        clearTimeout(timeout);
        console.log('Chrome exited gracefully.');
        resolve();
      });
    });
  }
  console.log('[shutdown] Closing database...');
  db.close();
  console.log('[shutdown] Clean exit');
  process.exit(0);
}

process.on('SIGINT', () => { shutdown().catch(console.error); });
process.on('SIGTERM', () => { shutdown().catch(console.error); });

// --- Startup ---

async function main(): Promise<void> {
  console.log('[startup] Phase 1/4: Launching browser...');
  await launchBrowser();
  console.log('[startup] Phase 2/4: Starting Telegram bot...');
  bot.start({
    onStart: () => console.log('[startup] Grammy long polling started'),
  });
  console.log('[startup] Phase 3/4: Starting cron scheduler...');
  startCron();
  console.log('[startup] Phase 4/4: Sending startup notification...');
  await bot.api.sendMessage(chatId, '\ud83e\udd16 Agent started');
  console.log('[startup] Daemon ready. Env: interval=%smin, tz=%s, jobs_per_search=%d', SEARCH_INTERVAL_MIN, TIMEZONE, JOBS_PER_SEARCH);
}

main().catch((err: unknown) => {
  console.error('Fatal:', err);
  process.exit(1);
});
