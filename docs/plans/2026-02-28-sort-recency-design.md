# Sort by Most Recent: Daemon-Driven URL Rewrite

## Problem

The search agent (Claude Haiku) is instructed to click "Most Recent" in the Upwork UI, but it ignores or rewrites the sorting code. Three attempts failed:

1. **Text instruction** ("click Most Recent") — Haiku skipped the step entirely
2. **Embedded Playwright code** — Haiku rewrote the code, removing the sorting logic
3. **Date-based post-filtering** — Haiku stopped passing dates to the filtering code

LLMs perephrase instructions instead of copying them verbatim. This is a fundamental behavior, not a prompt engineering problem.

## Solution

Remove sorting responsibility from Claude entirely. The daemon handles it between two spawns:

```
Spawn 1 (Haiku):  Navigate to upwork.com → search via UI → reach results page → exit
Daemon:           Read page URL via CDP → set sort=recency → navigate → wait for load
Spawn 2 (Haiku):  Page is already sorted by Most Recent → extract jobs
```

## Why This Works

- Claude never touches sorting. It only searches (Spawn 1) and extracts (Spawn 2).
- The daemon operates the browser directly via Playwright CDP, no LLM involved.
- The search warmup is human-like (typing query, pressing Enter), so Cloudflare does not block.
- The URL rewrite happens on an already-warm session, so Cloudflare treats it as a normal sort click.

## URL Parameter Details

**Research findings:**
- Default Best Match: URL has NO `sort` parameter (server-side default)
- Most Recent: `sort=recency`
- If user clicks Best Match in UI: may show `sort=relevance+desc`

**Implementation:** `url.searchParams.set('sort', 'recency')` handles all cases (adds if missing, replaces if present).

## Changes to `src/daemon.ts`

### 1. Split `buildSearchTask()` into `buildSearchWarmupTask()` + `buildSearchExtractTask()`

**`buildSearchWarmupTask()`** (replaces current `buildSearchTask()`, lines 408-513):

The Spawn 1 prompt. Claude does everything EXCEPT sorting and extracting jobs:
- `yarn morning` for context
- Read `data/profile.md`
- `browser_navigate` to `https://www.upwork.com`
- Find search input, type query (slowly), press Enter
- Wait for results page to load
- Verify search results appeared (not CAPTCHA, not login page)
- Exit. No sorting. No job extraction.

```typescript
function buildSearchWarmupTask(): QueueItem {
  const query = SEARCH_QUERIES[Math.floor(Math.random() * SEARCH_QUERIES.length)];
  return {
    task: [
      'Search for jobs on Upwork. Your ONLY job is to get to the search results page. Do NOT extract jobs.',
      '',
      'CRITICAL RULES:',
      '- The ONLY URL you may use with browser_navigate is https://www.upwork.com',
      '- NEVER type or construct search URLs.',
      '- Between every browser action, wait 2-5 seconds.',
      '- If CAPTCHA: try clicking checkbox, wait 5s, retry once. If still blocked: `yarn tg send "CAPTCHA detected"` and exit.',
      '- If login page: `yarn tg send "Session expired, please log in manually"` and exit.',
      '',
      'Steps:',
      '1. Run `yarn morning` to get context.',
      '2. Use browser_navigate to go to https://www.upwork.com. Wait 3 seconds.',
      '3. browser_snapshot to check page state.',
      '4. Find the search input field. browser_click on it.',
      `5. browser_type "${query}" with slowly=true.`,
      '6. browser_press_key Enter. Wait 5 seconds.',
      '7. browser_snapshot to verify search results loaded (not CAPTCHA, not login).',
      '8. If results are visible, exit successfully.',
    ].join('\n'),
    label: `Search warmup [${query}]`,
    action: 'search-warmup',
  };
}
```

**`buildSearchExtractTask()`**:

The Spawn 2 prompt. The page is already sorted by Most Recent. Claude only extracts:

```typescript
function buildSearchExtractTask(): QueueItem {
  return {
    task: [
      'Extract jobs from the current Upwork search results page. The page is already loaded and sorted.',
      'Do NOT navigate anywhere. Do NOT sort. Just extract.',
      '',
      'Step 1: Read data/profile.md for scoring criteria.',
      '',
      'Step 2: Extract job URLs from the current page — run browser_run_code:',
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
      'Step 3: For each job from the extracted list:',
      '  - Run `yarn jobs check <url>` — if "exists", skip entirely.',
      '  - Open the job: browser_run_code to click the link by href (NEVER browser_navigate):',
      '    async (page) => { await page.click(\'a[href*="/jobs/JOB_ID"]\'); }',
      '  - Wait 3 seconds.',
      '  - Extract page text:',
      '    async (page) => {',
      '      return await page.evaluate(() =>',
      '        (document.querySelector("main")?.innerText || document.body.innerText).slice(0, 5000)',
      '      );',
      '    }',
      '  - Parse: title, description (~500 chars), budget, job type, skills, client rating,',
      '    client total spent, client hires, client location, proposals count, posted date.',
      '  - Score relevance 0-10 based on profile.md.',
      '  - Save (use SINGLE QUOTES for $ values):',
      '    yarn jobs add --title \'...\' --url \'...\' --description \'...\' --budget \'...\' --job-type \'...\' --skills \'...\' --client-rating N --client-hires N --client-location \'...\' --client-spent \'...\' --proposals-count \'...\' --posted-at \'...\' --relevance-score N --relevance-reason \'...\'',
      '    Include ALL flags. Omit flag if value not found (no empty strings).',
      '  - Check yarn jobs add output. If "duplicate": true, do NOT send to Telegram.',
      '  - If score >= 4 AND newly added: `yarn tg send-job <id>`',
      '  - Go back: browser_navigate_back. Wait 3 seconds.',
      '',
      `Step 4: Pagination — if fewer than ${JOBS_PER_SEARCH} jobs processed:`,
      '  - browser_run_code to click Next:',
      '    async (page) => {',
      '      const next = await page.$("button[aria-label=\'Next\'], a[aria-label=\'Next\'], [data-test=\'pagination-next\'], nav[role=\'navigation\'] button:last-child");',
      '      if (next) { await next.click(); return "clicked"; }',
      '      return "no_next_button";',
      '    }',
      '  - If clicked, wait 5 seconds, go back to Step 2.',
      '  - If no button, stop.',
      '  - Max 3 pages.',
      '',
      `Step 5: After ${JOBS_PER_SEARCH} jobs or no more pages, exit.`,
      '',
      'TIME LIMITS:',
      '- Single page > 30 seconds to load: skip.',
      '- Total > 8 minutes: save what you have and exit.',
      '- Do not retry failed loads.',
    ].join('\n'),
    label: 'Job extraction',
    action: 'search-extract',
  };
}
```

### 2. Add `sortByRecency()` function

This is the daemon's direct Playwright operation between the two spawns:

```typescript
async function sortByRecency(): Promise<boolean> {
  if (!browserContext) {
    console.error('[sort] No browser context');
    return false;
  }

  const page = browserContext.pages()[0];
  if (!page) {
    console.error('[sort] No active page');
    return false;
  }

  try {
    const currentUrl = page.url();
    console.log(`[sort] Current URL: ${currentUrl}`);

    const url = new URL(currentUrl);

    // Verify we're on a search results page
    if (!url.pathname.includes('/search/jobs') && !url.pathname.includes('/jobs/search')) {
      console.error(`[sort] Not on search page: ${url.pathname}`);
      return false;
    }

    url.searchParams.set('sort', 'recency');
    const newUrl = url.toString();
    console.log(`[sort] Navigating to: ${newUrl}`);

    await page.goto(newUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000); // Let results re-render

    console.log('[sort] Sorted by recency');
    return true;
  } catch (err) {
    console.error('[sort] Failed:', err);
    return false;
  }
}
```

### 3. Modify `processQueue()` to chain warmup → sort → extract

The current flow: `processQueue()` takes one item from queue, spawns Claude, waits for exit, takes next item.

The new flow adds special handling for `search-warmup` completion:

In the `proc.on('exit')` handler (line 267), after the `if (code === 0)` block, add a new branch for `search-warmup`:

```typescript
if (code === 0) {
  console.log(`[queue] Done: ${label} (${elapsed}s)`);

  // --- NEW: Chain warmup → sort → extract ---
  if (action === 'search-warmup') {
    console.log('[queue] Warmup done, sorting by recency...');
    sortByRecency().then(sorted => {
      if (sorted) {
        console.log('[queue] Sort done, enqueueing extraction...');
        // Put extract task at the FRONT of the queue
        taskQueue.unshift(buildSearchExtractTask());
      } else {
        console.error('[queue] Sort failed, extracting with Best Match...');
        notify('⚠️ Could not sort by recency, extracting Best Match results')
          .catch(console.error);
        taskQueue.unshift(buildSearchExtractTask());
      }
      processQueue();
    });
    return; // Don't call processQueue() yet — wait for sort
  }
  // --- END NEW ---

  if (action === 'search') { ... } // existing search handler (will become dead code)
}
```

**Important:** The `return` before `processQueue()` at the bottom of the exit handler prevents double-calling. The sort is async, so `processQueue()` is called inside the `.then()`.

### 4. Update `enqueueTask()` deduplication

Change the `search` dedup check to also cover the new actions:

```typescript
if (item.action === 'search-warmup' || item.action === 'search-extract') {
  const searchActions = ['search-warmup', 'search-extract'];
  if (taskQueue.some(t => searchActions.includes(t.action!)) ||
      (isClaudeRunning && searchActions.includes(currentAction!))) {
    console.log(`[queue] Skipping duplicate: ${item.label}`);
    return;
  }
}
```

### 5. Update `buildSearchTask()` → calls warmup

Replace the current `buildSearchTask()` to return the warmup task:

```typescript
function buildSearchTask(): QueueItem {
  return buildSearchWarmupTask();
}
```

This preserves backward compatibility: `enqueueTask(buildSearchTask())` still works from cron and `/search` command. The chaining (warmup → sort → extract) happens automatically in `processQueue()`.

### 6. Update `rebuildTask()` for retry

```typescript
case 'search':
case 'search-warmup':
  return buildSearchWarmupTask();
case 'search-extract':
  return buildSearchExtractTask();
```

### 7. Update notification in extract completion

In the `proc.on('exit')` handler, add notification for `search-extract`:

```typescript
if (action === 'search-extract') {
  const lower = resultText.toLowerCase();
  const isSessionIssue = lower.includes('session expired') || lower.includes('log in manually');
  const isCaptcha = lower.includes('captcha');
  if (!isSessionIssue && !isCaptcha) {
    const summary = stdout.trim().slice(0, 1500) || `Search completed in ${elapsed}s, no output.`;
    notify(`✅ ${summary}`).catch(console.error);
  }
}
```

## Sort Failure Behavior

If `sortByRecency()` fails (page not on search results, navigation error, timeout), the daemon:
1. Logs the error
2. Sends a warning to Telegram: "Could not sort by recency, extracting Best Match results"
3. Proceeds with extraction anyway (Best Match is better than nothing)

This is a graceful degradation, not a hard failure.

## What Does NOT Change

- Chrome launch, CDP connection, keepalive cron — unchanged
- `buildProposeTask()`, `buildSubmitTask()`, `buildRedoTask()` — unchanged
- Telegram bot commands and callback handlers — unchanged
- Database schema, `yarn jobs`, `yarn tg` CLI tools — unchanged
- `.mcp.json` configuration — unchanged
- `CLAUDE.md` agent instructions — unchanged (except the search workflow section could be updated to reflect the split, but the agent doesn't read it during spawned tasks)

## Files to Modify

| File | Changes |
|------|---------|
| `src/daemon.ts` | Replace `buildSearchTask()` with warmup/extract split, add `sortByRecency()`, modify `processQueue()` exit handler, update dedup logic |

One file. All changes in `daemon.ts`.

## Testing

1. **Manual trigger:** Send `/search` in Telegram
2. **Verify logs:** `data/logs/claude-tasks.log` should show:
   - `Search warmup [query]` spawn + exit
   - `[sort] Current URL: ...` + `[sort] Navigating to: ...?sort=recency`
   - `Job extraction` spawn + exit
3. **Verify jobs:** `yarn jobs list` should show new jobs
4. **Verify sort:** Jobs should be in chronological order (most recent first), not Best Match order
5. **Sort failure test:** Manually navigate browser away from search page before sort triggers, verify graceful degradation (warning in Telegram, extraction proceeds)
