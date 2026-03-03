import { db } from './db/index.js';
import { searchJobs } from './db/search.js';
import type { JobRow } from './db/search.js';
import { createHash } from 'node:crypto';

// --- Argument parsing helpers ---

const JUNK_VALUES = new Set([
  'unknown', 'n/a', 'na', 'not specified', 'not found', 'none', 'null', 'undefined', '',
]);

function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        // Filter out junk placeholder values — treat as if flag was omitted
        if (!JUNK_VALUES.has(next.trim().toLowerCase())) {
          flags[key] = next;
        }
        i += 2;
      } else {
        flags[key] = 'true';
        i += 1;
      }
    } else {
      positional.push(arg);
      i += 1;
    }
  }

  return { positional, flags };
}

function extractJobId(url: string): string {
  // Match ~ID after /jobs/ with optional title slug: /jobs/Title-Slug_~ID or /jobs/~ID
  const match = url.match(/(~[a-zA-Z0-9]{18,})/);
  if (match) return match[1];
  // Deterministic ID for non-Upwork URLs
  return createHash('sha256').update(url).digest('hex').slice(0, 16);
}

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

// --- Commands ---

function cmdAdd(flags: Record<string, string>): void {
  const url = flags['url'];
  const title = flags['title'];
  if (!url) fail('--url is required');
  if (!title) fail('--title is required');

  const id = extractJobId(url);

  // Check if job already exists (by ID or by URL)
  const existingById = db.prepare('SELECT id, status FROM jobs WHERE id = ?').get(id) as { id: string; status: string } | undefined;
  const existingByUrl = db.prepare('SELECT id, status FROM jobs WHERE url = ? AND id != ?').get(url, id) as { id: string; status: string } | undefined;
  const existing = existingById ?? existingByUrl;

  if (existing) {
    console.log(JSON.stringify({ duplicate: true, existing_id: existing.id, status: existing.status, message: 'Job already exists in DB — do NOT send to Telegram' }));
    return;
  }

  const stmt = db.prepare(`
    INSERT INTO jobs (id, title, description, budget, job_type, skills, client_rating, client_hires, client_location, client_spent, proposals_count, posted_at, url, relevance_score, relevance_reason, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    title,
    flags['description'] ?? null,
    flags['budget'] ?? null,
    flags['job-type'] ?? null,
    flags['skills'] ?? null,
    flags['client-rating'] ? Number(flags['client-rating']) : null,
    flags['client-hires'] ? Number(flags['client-hires']) : null,
    flags['client-location'] ?? null,
    flags['client-spent'] ?? null,
    flags['proposals-count'] ?? null,
    flags['posted-at'] ?? new Date().toISOString().slice(0, 10),
    url,
    flags['relevance-score'] ? Number(flags['relevance-score']) : null,
    flags['relevance-reason'] ?? null,
    flags['status'] ?? 'new',
  );

  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow;
  console.log(JSON.stringify(job, null, 2));
}

function cmdGet(positional: string[]): void {
  const id = positional[0];
  if (!id) fail('Job ID is required');

  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
  if (!job) fail(`Job not found: ${id}`);
  console.log(JSON.stringify(job, null, 2));
}

function cmdCheck(positional: string[]): void {
  const url = positional[0];
  if (!url) fail('URL is required');

  const id = extractJobId(url);
  const byId = db.prepare('SELECT id FROM jobs WHERE id = ?').get(id) as { id: string } | undefined;
  const byUrl = db.prepare('SELECT id FROM jobs WHERE url = ?').get(url) as { id: string } | undefined;
  console.log((byId || byUrl) ? 'exists' : 'not_found');
}

function cmdList(flags: Record<string, string>): void {
  const status = flags['status'];
  const limit = flags['limit'] ? Number(flags['limit']) : 20;

  let query = 'SELECT * FROM jobs';
  const params: (string | number)[] = [];

  if (status) {
    query += ' WHERE status = ?';
    params.push(status);
  }

  query += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  const jobs = db.prepare(query).all(...params) as JobRow[];
  console.log(JSON.stringify(jobs, null, 2));
}

function cmdFind(positional: string[]): void {
  const query = positional[0];
  if (!query) fail('Search query is required');

  const jobs = searchJobs(db, query);
  console.log(JSON.stringify(jobs, null, 2));
}

function cmdUpdate(positional: string[], flags: Record<string, string>): void {
  const id = positional[0];
  if (!id) fail('Job ID is required');

  const existing = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
  if (!existing) fail(`Job not found: ${id}`);

  const VALID_STATUSES = ['new', 'sent', 'approved', 'applied', 'skipped', 'cancelled'];
  if (flags['status'] && !VALID_STATUSES.includes(flags['status'])) {
    fail(`Invalid status "${flags['status']}". Valid: ${VALID_STATUSES.join(', ')}`);
  }

  const updatableFields: Record<string, string> = {
    'status': 'status',
    'proposal-text': 'proposal_text',
    'bid-amount': 'bid_amount',
    'applied-at': 'applied_at',
    'telegram-message-id': 'telegram_message_id',
    'telegram-proposal-message-id': 'telegram_proposal_message_id',
    'relevance-score': 'relevance_score',
    'relevance-reason': 'relevance_reason',
    'description': 'description',
    'budget': 'budget',
    'job-type': 'job_type',
    'skills': 'skills',
    'client-rating': 'client_rating',
    'client-hires': 'client_hires',
    'client-location': 'client_location',
    'client-spent': 'client_spent',
    'proposals-count': 'proposals_count',
    'posted-at': 'posted_at',
    'title': 'title',
  };

  const setClauses: string[] = [];
  const params: (string | number | null)[] = [];

  for (const [flag, col] of Object.entries(updatableFields)) {
    if (flags[flag] !== undefined) {
      setClauses.push(`${col} = ?`);
      const numericCols = ['telegram_message_id', 'telegram_proposal_message_id', 'client_rating', 'client_hires', 'relevance_score'];
      params.push(numericCols.includes(col) ? Number(flags[flag]) : flags[flag]);
    }
  }

  if (setClauses.length === 0) fail('No fields to update');

  setClauses.push('updated_at = unixepoch()');

  const sql = `UPDATE jobs SET ${setClauses.join(', ')} WHERE id = ?`;
  params.push(id);
  db.prepare(sql).run(...params);

  const updated = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow;
  console.log(JSON.stringify(updated, null, 2));
}

function cmdStats(flags: Record<string, string>): void {
  let timeFilter = '';

  if (flags['week']) {
    timeFilter = `WHERE created_at >= unixepoch('now', '-7 days')`;
  } else if (flags['all']) {
    timeFilter = '';
  } else {
    // Default: today
    timeFilter = `WHERE created_at >= unixepoch('now', 'start of day')`;
  }

  const query = `
    SELECT
      COUNT(*) as found,
      SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as sent,
      SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) as approved,
      SUM(CASE WHEN status = 'applied' THEN 1 ELSE 0 END) as applied,
      SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) as skipped,
      SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled
    FROM jobs ${timeFilter}
  `;

  const stats = db.prepare(query).get() as Record<string, number>;

  const period = flags['week'] ? 'This week' : flags['all'] ? 'All time' : 'Today';

  console.log(`--- Job Stats (${period}) ---`);
  console.log(`Found:     ${stats.found ?? 0}`);
  console.log(`Sent:      ${stats.sent ?? 0}`);
  console.log(`Approved:  ${stats.approved ?? 0}`);
  console.log(`Applied:   ${stats.applied ?? 0}`);
  console.log(`Skipped:   ${stats.skipped ?? 0}`);
  console.log(`Cancelled: ${stats.cancelled ?? 0}`);
}

function cmdReport(flags: Record<string, string>): void {
  let timeFilter = '';
  let timeFilterAnd = '';

  if (flags['week']) {
    timeFilter = `WHERE created_at >= unixepoch('now', '-7 days')`;
    timeFilterAnd = `AND created_at >= unixepoch('now', '-7 days')`;
  } else if (flags['all']) {
    timeFilter = '';
    timeFilterAnd = '';
  } else {
    timeFilter = `WHERE created_at >= unixepoch('now', 'start of day')`;
    timeFilterAnd = `AND created_at >= unixepoch('now', 'start of day')`;
  }

  const period = flags['week'] ? 'This week' : flags['all'] ? 'All time' : 'Today';

  // Overall counts
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

  console.log(`=== Job Report (${period}) ===\n`);
  console.log(`Found: ${stats.found ?? 0} | Sent to TG: ${stats.sent_to_tg ?? 0} | Applied: ${stats.applied ?? 0} | Skipped: ${stats.skipped ?? 0} | Cancelled: ${stats.cancelled ?? 0}`);
  console.log(`Avg relevance score: ${stats.avg_score ?? 'N/A'}\n`);

  // By job type (fixed vs hourly)
  const byType = db.prepare(`
    SELECT
      COALESCE(job_type, 'unknown') as type,
      COUNT(*) as count
    FROM jobs
    WHERE status IN ('sent','approved','applied','skipped','cancelled') ${timeFilterAnd}
    GROUP BY job_type
    ORDER BY count DESC
  `).all() as { type: string; count: number }[];

  if (byType.length > 0) {
    console.log('--- By type ---');
    for (const row of byType) {
      console.log(`  ${row.type}: ${row.count}`);
    }
    console.log('');
  }

  // Score distribution
  const byScore = db.prepare(`
    SELECT
      CASE
        WHEN relevance_score >= 8 THEN '8-10 (perfect)'
        WHEN relevance_score >= 6 THEN '6-7 (good)'
        WHEN relevance_score >= 4 THEN '4-5 (partial)'
        ELSE '0-3 (skip)'
      END as bracket,
      COUNT(*) as count
    FROM jobs ${timeFilter}
    GROUP BY bracket
    ORDER BY bracket DESC
  `).all() as { bracket: string; count: number }[];

  if (byScore.length > 0) {
    console.log('--- By score ---');
    for (const row of byScore) {
      console.log(`  ${row.bracket}: ${row.count}`);
    }
    console.log('');
  }

  // Top skills across sent jobs
  const sentJobs = db.prepare(`
    SELECT skills FROM jobs
    WHERE skills IS NOT NULL
      AND status IN ('sent','approved','applied','skipped','cancelled')
      ${timeFilterAnd}
  `).all() as { skills: string }[];

  const skillCounts = new Map<string, number>();
  for (const row of sentJobs) {
    const skills = row.skills.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    for (const skill of skills) {
      skillCounts.set(skill, (skillCounts.get(skill) ?? 0) + 1);
    }
  }

  const topSkills = [...skillCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (topSkills.length > 0) {
    console.log('--- Top skills demanded ---');
    for (const [skill, count] of topSkills) {
      console.log(`  ${skill}: ${count}`);
    }
    console.log('');
  }

  // Recent sent jobs (last 10)
  const recent = db.prepare(`
    SELECT id, title, budget, job_type, relevance_score, status,
           datetime(created_at, 'unixepoch', 'localtime') as created
    FROM jobs
    WHERE status IN ('sent','approved','applied','skipped','cancelled')
      ${timeFilterAnd}
    ORDER BY created_at DESC
    LIMIT 10
  `).all() as { id: string; title: string; budget: string | null; job_type: string | null; relevance_score: number | null; status: string; created: string }[];

  if (recent.length > 0) {
    console.log('--- Recent sent jobs ---');
    for (const job of recent) {
      const score = job.relevance_score != null ? `${job.relevance_score}/10` : '?';
      const budget = job.budget ?? '?';
      const status = job.status.toUpperCase();
      console.log(`  [${score}] ${job.title.slice(0, 60)}`);
      console.log(`         ${budget} | ${job.job_type ?? '?'} | ${status}`);
    }
  }
}

// --- Main ---

const args = process.argv.slice(2);
const command = args[0];
const rest = args.slice(1);
const { positional, flags } = parseArgs(rest);

switch (command) {
  case 'add':
    cmdAdd(flags);
    break;
  case 'get':
    cmdGet(positional);
    break;
  case 'check':
    cmdCheck(positional);
    break;
  case 'list':
    cmdList(flags);
    break;
  case 'find':
    cmdFind(positional);
    break;
  case 'update':
    cmdUpdate(positional, flags);
    break;
  case 'stats':
    cmdStats(flags);
    break;
  case 'report':
    cmdReport(flags);
    break;
  default:
    console.error('Usage: jobs <command> [args]');
    console.error('Commands: add, get, check, list, find, update, stats, report');
    process.exit(1);
}
