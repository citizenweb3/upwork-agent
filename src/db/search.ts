import type Database from 'better-sqlite3';

export function initFTS(db: Database.Database): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS jobs_fts USING fts5(
      title, description, skills, relevance_reason,
      content='jobs', content_rowid='rowid',
      tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS jobs_ai AFTER INSERT ON jobs BEGIN
      INSERT INTO jobs_fts(rowid, title, description, skills, relevance_reason)
      VALUES (NEW.rowid, NEW.title, NEW.description, NEW.skills, NEW.relevance_reason);
    END;

    CREATE TRIGGER IF NOT EXISTS jobs_ad AFTER DELETE ON jobs BEGIN
      INSERT INTO jobs_fts(jobs_fts, rowid, title, description, skills, relevance_reason)
      VALUES ('delete', OLD.rowid, OLD.title, OLD.description, OLD.skills, OLD.relevance_reason);
    END;

    CREATE TRIGGER IF NOT EXISTS jobs_au AFTER UPDATE ON jobs BEGIN
      INSERT INTO jobs_fts(jobs_fts, rowid, title, description, skills, relevance_reason)
      VALUES ('delete', OLD.rowid, OLD.title, OLD.description, OLD.skills, OLD.relevance_reason);
      INSERT INTO jobs_fts(rowid, title, description, skills, relevance_reason)
      VALUES (NEW.rowid, NEW.title, NEW.description, NEW.skills, NEW.relevance_reason);
    END;
  `);
}

export interface JobRow {
  id: string;
  title: string;
  description: string | null;
  budget: string | null;
  job_type: string | null;
  skills: string | null;
  client_rating: number | null;
  client_hires: number | null;
  client_location: string | null;
  client_spent: string | null;
  proposals_count: string | null;
  posted_at: string | null;
  url: string;
  relevance_score: number | null;
  relevance_reason: string | null;
  status: string;
  proposal_text: string | null;
  bid_amount: string | null;
  applied_at: string | null;
  telegram_message_id: number | null;
  created_at: number;
  updated_at: number;
}

export function searchJobs(db: Database.Database, query: string): JobRow[] {
  // Wrap each token in double quotes so FTS5 treats dots and
  // other special characters (e.g. "next.js") as literals.
  const safeQuery = query
    .split(/\s+/)
    .filter(Boolean)
    .map(token => `"${token.replace(/"/g, '')}"`)
    .join(' ');

  if (!safeQuery) return [];

  const stmt = db.prepare(`
    SELECT jobs.* FROM jobs_fts
    JOIN jobs ON jobs.rowid = jobs_fts.rowid
    WHERE jobs_fts MATCH ?
    ORDER BY rank
  `);
  return stmt.all(safeQuery) as JobRow[];
}
