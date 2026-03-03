import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { initSchema } from './schema.js';
import { initFTS } from './search.js';

const DB_PATH = 'data/jobs.db';

mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

initSchema(db);
initFTS(db);

export { db };
