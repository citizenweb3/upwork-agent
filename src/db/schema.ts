import type Database from 'better-sqlite3';

export function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      budget TEXT,
      job_type TEXT,
      skills TEXT,
      client_rating REAL,
      client_hires INTEGER,
      client_location TEXT,
      client_spent TEXT,
      proposals_count TEXT,
      posted_at TEXT,
      url TEXT NOT NULL,
      relevance_score REAL,
      relevance_reason TEXT,
      status TEXT DEFAULT 'new',
      proposal_text TEXT,
      bid_amount TEXT,
      applied_at TEXT,
      telegram_message_id INTEGER,
      telegram_proposal_message_id INTEGER,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_relevance ON jobs(relevance_score);
  `);

  // Migration: add column for existing databases
  try {
    db.exec(`ALTER TABLE jobs ADD COLUMN telegram_proposal_message_id INTEGER`);
  } catch {
    // Column already exists — ignore
  }
}
