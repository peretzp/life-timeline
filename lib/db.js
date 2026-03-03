// SQLite schema + migration for life-timeline
// Pattern: ~/api/lib/db.js — WAL mode, single connection

const path = require('path');
const Database = require('better-sqlite3');

const DEFAULT_DB_PATH = path.join(__dirname, '..', 'data', 'timeline.db');

let _db = null;

function getDb(dbPath) {
  if (!_db) {
    const p = dbPath || DEFAULT_DB_PATH;
    _db = new Database(p);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    migrate(_db);
  }
  return _db;
}

function close() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

function migrate(db) {
  db.exec(`
    -- Registered data sources
    CREATE TABLE IF NOT EXISTS source (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      adapter TEXT NOT NULL,
      config TEXT DEFAULT '{}',
      event_count INTEGER DEFAULT 0,
      date_start TEXT,
      date_end TEXT,
      status TEXT DEFAULT 'pending',
      ingested_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Every temporal datum
    CREATE TABLE IF NOT EXISTS event (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL REFERENCES source(id),
      timestamp TEXT NOT NULL,
      lat REAL,
      lon REAL,
      event_type TEXT NOT NULL,
      title TEXT,
      body TEXT,
      metadata TEXT DEFAULT '{}',
      people TEXT DEFAULT '[]',
      track TEXT,
      source_ref TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Indexes for query performance
    CREATE INDEX IF NOT EXISTS idx_event_timestamp ON event(timestamp);
    CREATE INDEX IF NOT EXISTS idx_event_type ON event(event_type);
    CREATE INDEX IF NOT EXISTS idx_event_coords ON event(lat, lon) WHERE lat IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_event_source_ref ON event(source_id, source_ref) WHERE source_ref IS NOT NULL;

    -- FTS5 for full-text search over title, body, people
    CREATE VIRTUAL TABLE IF NOT EXISTS event_fts USING fts5(
      title, body, people,
      content='event',
      content_rowid='id'
    );

    -- Triggers to keep FTS in sync
    CREATE TRIGGER IF NOT EXISTS event_ai AFTER INSERT ON event BEGIN
      INSERT INTO event_fts(rowid, title, body, people)
      VALUES (new.id, new.title, new.body, new.people);
    END;

    CREATE TRIGGER IF NOT EXISTS event_ad AFTER DELETE ON event BEGIN
      INSERT INTO event_fts(event_fts, rowid, title, body, people)
      VALUES ('delete', old.id, old.title, old.body, old.people);
    END;

    CREATE TRIGGER IF NOT EXISTS event_au AFTER UPDATE ON event BEGIN
      INSERT INTO event_fts(event_fts, rowid, title, body, people)
      VALUES ('delete', old.id, old.title, old.body, old.people);
      INSERT INTO event_fts(rowid, title, body, people)
      VALUES (new.id, new.title, new.body, new.people);
    END;
  `);
}

module.exports = { getDb, close, DEFAULT_DB_PATH };
