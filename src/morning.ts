import 'dotenv/config';
import { db } from './db/index.js';

interface StatsRow {
  found: number;
  sent: number;
  applied: number;
}

interface PendingRow {
  id: string;
  title: string;
  status: string;
}

function getStats(timeFilter: string): StatsRow {
  const query = `
    SELECT
      COUNT(*) as found,
      COALESCE(SUM(CASE WHEN status IN ('sent','approved','applied') THEN 1 ELSE 0 END), 0) as sent,
      COALESCE(SUM(CASE WHEN status = 'applied' THEN 1 ELSE 0 END), 0) as applied
    FROM jobs ${timeFilter}
  `;
  return db.prepare(query).get() as StatsRow;
}

function getPending(): PendingRow[] {
  return db.prepare(
    `SELECT id, title, status FROM jobs WHERE status IN ('sent', 'approved') ORDER BY created_at DESC LIMIT 10`,
  ).all() as PendingRow[];
}

async function checkBrowser(): Promise<string> {
  try {
    const res = await fetch('http://127.0.0.1:9222/json/version', { signal: AbortSignal.timeout(3000) });
    if (res.ok) return '\u2705 Connected';
    return '\u274C Not running';
  } catch {
    return '\u274C Not running';
  }
}

async function main(): Promise<void> {
  const now = new Date();
  const timestamp = now.toISOString().replace('T', ' ').slice(0, 16);

  const browserStatus = await checkBrowser();

  const today = getStats(`WHERE created_at >= unixepoch('now', 'start of day')`);
  const week = getStats(`WHERE created_at >= unixepoch('now', '-7 days')`);
  const allTime = getStats('');

  const pending = getPending();

  const lines: string[] = [
    `# Briefing — ${timestamp}`,
    '',
    '## Browser',
    `Status: ${browserStatus}`,
    '',
    '## Stats',
    `Today: ${today.found} jobs found, ${today.sent} sent, ${today.applied} applied`,
    `This week: ${week.found} found, ${week.sent} sent, ${week.applied} applied`,
    `All time: ${allTime.found} found, ${allTime.sent} sent, ${allTime.applied} applied`,
    '',
    '## Pending',
  ];

  if (pending.length === 0) {
    lines.push('No pending jobs.');
  } else {
    for (const job of pending) {
      lines.push(`- Job "${job.title}" (${job.id}) — ${job.status}`);
    }
  }

  console.log(lines.join('\n'));
}

main().catch((err: unknown) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
