// MemoryAtlas voice memo importer
// Reads ~/tools/memoryatlas/data/atlas.db (929+ voice memos, 2009-2026)

const path = require('path');
const BaseAdapter = require('./base');
const { parseISO } = require('../lib/timestamps');

class MemoryAtlasAdapter extends BaseAdapter {
  constructor() {
    super('memoryatlas', 'MemoryAtlas voice memos (2009-2026)');
  }

  async ingest(db, config, opts = {}) {
    const atlasDbPath = (config.db || '~/tools/memoryatlas/data/atlas.db').replace(/^~/, process.env.HOME);
    const verbose = opts.verbose;

    // Open MemoryAtlas database read-only
    const Database = require('better-sqlite3');
    let atlasDb;
    try {
      atlasDb = new Database(atlasDbPath, { readonly: true });
    } catch (err) {
      throw new Error(`Cannot open MemoryAtlas DB at ${atlasDbPath}: ${err.message}`);
    }

    const sourceId = this.register(db, config);

    // Clear existing for re-ingestion
    const existing = db.prepare('SELECT event_count FROM source WHERE id = ?').get(sourceId);
    if (existing && existing.event_count > 0) {
      console.log(`[memoryatlas] Clearing ${existing.event_count} existing events`);
      db.prepare('DELETE FROM event WHERE source_id = ?').run(sourceId);
    }

    // Query all assets with transcription done
    const assets = atlasDb.prepare(`
      SELECT id, title, recorded_at, duration_sec, transcript_lang, lat, lon, place,
             summary, topics, people, source_type, filename
      FROM asset
      WHERE recorded_at IS NOT NULL
      ORDER BY recorded_at
    `).all();

    console.log(`[memoryatlas] Found ${assets.length} voice memos`);

    let inserted = 0, skipped = 0, errors = 0;

    const insertBatch = db.transaction((events) => {
      for (const event of events) {
        if (this.insertEvent(db, event)) inserted++;
        else skipped++;
      }
    });

    const events = [];
    for (const a of assets) {
      try {
        const ts = parseISO(a.recorded_at);
        if (!ts) { skipped++; continue; }

        // Parse people and topics from comma-separated strings
        let people = [];
        if (a.people) {
          people = a.people.split(',').map(s => s.trim()).filter(Boolean);
        }

        let topics = [];
        if (a.topics) {
          topics = a.topics.split(',').map(s => s.trim()).filter(Boolean);
        }

        events.push({
          source_id: sourceId,
          timestamp: ts,
          lat: a.lat || null,
          lon: a.lon || null,
          event_type: 'voice_memo',
          title: a.title || a.filename || 'Untitled memo',
          body: a.summary || null,
          metadata: {
            duration_sec: a.duration_sec,
            language: a.transcript_lang,
            place: a.place,
            topics,
            source_type: a.source_type,
            atlas_id: a.id,
          },
          people,
          track: null,
          source_ref: a.id,
        });
      } catch (err) {
        errors++;
        if (verbose) console.error(`[memoryatlas] Error: ${err.message}`);
      }
    }

    insertBatch(events);

    atlasDb.close();

    const stats = this.updateSourceStats(db, sourceId);
    console.log(`[memoryatlas] Done: ${inserted} inserted, ${skipped} skipped, ${errors} errors`);
    console.log(`[memoryatlas] Date range: ${stats.date_start} to ${stats.date_end}`);

    return { inserted, skipped, errors };
  }
}

module.exports = MemoryAtlasAdapter;
