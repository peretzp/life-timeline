// Base adapter interface for data source ingestion
// Each adapter must implement: name, ingest(db, config, opts)

class BaseAdapter {
  /**
   * @param {string} name - Unique source name (e.g. 'moves', 'memoryatlas')
   * @param {string} description - Human-readable description
   */
  constructor(name, description) {
    this.name = name;
    this.description = description;
  }

  /**
   * Register this source in the database
   * @param {Database} db - better-sqlite3 instance
   * @param {object} config - Source-specific config from config.json
   * @returns {number} source_id
   */
  register(db, config = {}) {
    const existing = db.prepare('SELECT id FROM source WHERE name = ?').get(this.name);
    if (existing) return existing.id;

    const result = db.prepare(
      'INSERT INTO source (name, adapter, config, status) VALUES (?, ?, ?, ?)'
    ).run(this.name, this.name, JSON.stringify(config), 'pending');
    return result.lastInsertRowid;
  }

  /**
   * Insert an event, skipping duplicates by source_ref
   * @param {Database} db
   * @param {object} event
   * @returns {boolean} true if inserted
   */
  insertEvent(db, event) {
    try {
      db.prepare(`
        INSERT INTO event (source_id, timestamp, lat, lon, event_type, title, body, metadata, people, track, source_ref)
        VALUES (@source_id, @timestamp, @lat, @lon, @event_type, @title, @body, @metadata, @people, @track, @source_ref)
      `).run({
        source_id: event.source_id,
        timestamp: event.timestamp,
        lat: event.lat || null,
        lon: event.lon || null,
        event_type: event.event_type,
        title: event.title || null,
        body: event.body || null,
        metadata: event.metadata ? JSON.stringify(event.metadata) : '{}',
        people: event.people ? JSON.stringify(event.people) : '[]',
        track: event.track ? JSON.stringify(event.track) : null,
        source_ref: event.source_ref || null,
      });
      return true;
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return false;
      throw err;
    }
  }

  /**
   * Update source metadata after ingestion
   */
  updateSourceStats(db, sourceId) {
    const stats = db.prepare(`
      SELECT COUNT(*) as count, MIN(timestamp) as date_start, MAX(timestamp) as date_end
      FROM event WHERE source_id = ?
    `).get(sourceId);

    db.prepare(`
      UPDATE source SET event_count = ?, date_start = ?, date_end = ?, status = 'ingested', ingested_at = datetime('now')
      WHERE id = ?
    `).run(stats.count, stats.date_start, stats.date_end, sourceId);

    return stats;
  }

  /**
   * Override this in each adapter
   * @param {Database} db
   * @param {object} config
   * @param {object} opts - { verbose: bool }
   * @returns {{ inserted: number, skipped: number, errors: number }}
   */
  async ingest(db, config, opts = {}) {
    throw new Error(`${this.name}: ingest() not implemented`);
  }
}

module.exports = BaseAdapter;
