// Apple Calendar importer
// Reads ~/Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb

const path = require('path');
const BaseAdapter = require('./base');
const { parseAppleEpoch } = require('../lib/timestamps');

class CalendarAdapter extends BaseAdapter {
  constructor() {
    super('calendar', 'Apple Calendar events');
  }

  async ingest(db, config, opts = {}) {
    const calDbPath = (config.db || '~/Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb')
      .replace(/^~/, process.env.HOME);
    const verbose = opts.verbose;

    const Database = require('better-sqlite3');
    let calDb;
    try {
      calDb = new Database(calDbPath, { readonly: true });
    } catch (err) {
      throw new Error(`Cannot open Calendar DB at ${calDbPath}: ${err.message}`);
    }

    const sourceId = this.register(db, config);

    // Clear existing for re-ingestion
    const existing = db.prepare('SELECT event_count FROM source WHERE id = ?').get(sourceId);
    if (existing && existing.event_count > 0) {
      console.log(`[calendar] Clearing ${existing.event_count} existing events`);
      db.prepare('DELETE FROM event WHERE source_id = ?').run(sourceId);
    }

    // Query calendar events with their calendar name and location
    const items = calDb.prepare(`
      SELECT ci.ROWID as id, ci.summary, ci.description, ci.start_date, ci.end_date,
             ci.start_tz, ci.all_day, ci.url, ci.entity_type,
             c.title as calendar_name,
             L.title as location_title, L.address as location_address
      FROM CalendarItem ci
      LEFT JOIN Calendar c ON c.ROWID = ci.calendar_id
      LEFT JOIN Location L ON L.ROWID = ci.location_id
      WHERE ci.summary IS NOT NULL AND ci.start_date IS NOT NULL
      ORDER BY ci.start_date
    `).all();

    console.log(`[calendar] Found ${items.length} calendar events`);

    let inserted = 0, skipped = 0, errors = 0;

    const insertBatch = db.transaction((events) => {
      for (const event of events) {
        if (this.insertEvent(db, event)) inserted++;
        else skipped++;
      }
    });

    const events = [];
    for (const item of items) {
      try {
        const ts = parseAppleEpoch(item.start_date);
        if (!ts) { skipped++; continue; }

        // Skip very old birthday-like entries (negative Apple epoch = before 2001)
        // We keep them — they're valid calendar entries

        const endTs = item.end_date ? parseAppleEpoch(item.end_date) : null;
        const durationSec = endTs && ts
          ? (new Date(endTs) - new Date(ts)) / 1000
          : null;

        // Determine event subtype
        const isReminder = item.entity_type === 2;
        const isBirthday = (item.calendar_name || '').toLowerCase().includes('birthday');

        events.push({
          source_id: sourceId,
          timestamp: ts,
          lat: null,
          lon: null,
          event_type: 'calendar',
          title: item.summary,
          body: item.description || null,
          metadata: {
            calendar: item.calendar_name,
            end_time: endTs,
            duration_sec: durationSec,
            all_day: !!item.all_day,
            timezone: item.start_tz !== '_float' ? item.start_tz : null,
            location: item.location_title || item.location_address || null,
            url: item.url || null,
            is_reminder: isReminder,
            is_birthday: isBirthday,
          },
          people: [],
          track: null,
          source_ref: `cal_${item.id}`,
        });
      } catch (err) {
        errors++;
        if (verbose) console.error(`[calendar] Error on item ${item.id}: ${err.message}`);
      }
    }

    // Insert in batches
    const batchSize = 2000;
    for (let i = 0; i < events.length; i += batchSize) {
      insertBatch(events.slice(i, i + batchSize));
      if (verbose && i > 0) console.log(`[calendar] Inserted ${Math.min(i + batchSize, events.length)}/${events.length}`);
    }

    calDb.close();

    const stats = this.updateSourceStats(db, sourceId);
    console.log(`[calendar] Done: ${inserted} inserted, ${skipped} skipped, ${errors} errors`);
    console.log(`[calendar] Date range: ${stats.date_start} to ${stats.date_end}`);

    return { inserted, skipped, errors };
  }
}

module.exports = CalendarAdapter;
