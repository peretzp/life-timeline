// Moves App JSON importer
// Parses daily storyline JSON files from Moves data export ZIP
// Each storyline has segments: "place" (stay) and "move" (travel with GPS track)

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const BaseAdapter = require('./base');
const { parseMoves } = require('../lib/timestamps');

class MovesAdapter extends BaseAdapter {
  constructor() {
    super('moves', 'Moves App location history (2014-2018)');
  }

  /**
   * Extract ZIP files and return path to storyline directory
   */
  extractData(zipPath, tmpDir) {
    const absZip = zipPath.replace(/^~/, process.env.HOME);
    if (!fs.existsSync(absZip)) {
      throw new Error(`Moves ZIP not found: ${absZip}`);
    }

    // Create tmp dir
    fs.mkdirSync(tmpDir, { recursive: true });

    // Extract outer zip to get json.zip
    execSync(`unzip -o -q "${absZip}" json.zip -d "${tmpDir}"`, { timeout: 30000 });

    // Extract json.zip
    const jsonZip = path.join(tmpDir, 'json.zip');
    execSync(`unzip -o -q "${jsonZip}" -d "${tmpDir}"`, { timeout: 60000 });

    return path.join(tmpDir, 'json', 'daily', 'storyline');
  }

  /**
   * Parse a single storyline JSON file
   * Returns array of events
   */
  parseStoryline(filePath, sourceId) {
    const raw = fs.readFileSync(filePath, 'utf8');
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return [];
    }

    // Data is an array with one element per day
    const events = [];
    const days = Array.isArray(data) ? data : [data];

    for (const day of days) {
      if (!day.segments) continue;
      const date = day.date; // e.g. "20160710"

      for (let i = 0; i < day.segments.length; i++) {
        const seg = day.segments[i];
        const ref = `${date}_seg${i}`;

        if (seg.type === 'place') {
          events.push(this.parsePlaceSegment(seg, sourceId, ref));
        } else if (seg.type === 'move') {
          events.push(this.parseMoveSegment(seg, sourceId, ref));
        }
      }
    }

    return events.filter(Boolean);
  }

  parsePlaceSegment(seg, sourceId, ref) {
    const ts = parseMoves(seg.startTime);
    if (!ts) return null;

    const place = seg.place || {};
    const loc = place.location || {};

    // Aggregate activity stats from activities within this place segment
    let totalSteps = 0, totalDistance = 0, totalCalories = 0;
    if (seg.activities) {
      for (const a of seg.activities) {
        totalSteps += a.steps || 0;
        totalDistance += a.distance || 0;
        totalCalories += a.calories || 0;
      }
    }

    return {
      source_id: sourceId,
      timestamp: ts,
      lat: loc.lat || null,
      lon: loc.lon || null,
      event_type: 'location',
      title: place.name || place.type || 'Unknown place',
      body: null,
      metadata: {
        place_id: place.id,
        place_type: place.type,
        start_time: parseMoves(seg.startTime),
        end_time: parseMoves(seg.endTime),
        duration_sec: seg.endTime && seg.startTime
          ? (new Date(parseMoves(seg.endTime)) - new Date(parseMoves(seg.startTime))) / 1000
          : null,
        steps: totalSteps || undefined,
        distance_m: totalDistance || undefined,
        calories: totalCalories || undefined,
      },
      people: [],
      track: null,
      source_ref: ref,
    };
  }

  parseMoveSegment(seg, sourceId, ref) {
    const ts = parseMoves(seg.startTime);
    if (!ts) return null;

    // Collect all track points from all activities
    const trackPoints = [];
    const activityTypes = new Set();
    let totalDistance = 0, totalDuration = 0, totalSteps = 0, totalCalories = 0;

    if (seg.activities) {
      for (const a of seg.activities) {
        activityTypes.add(a.activity);
        totalDistance += a.distance || 0;
        totalDuration += a.duration || 0;
        totalSteps += a.steps || 0;
        totalCalories += a.calories || 0;

        if (a.trackPoints) {
          for (const tp of a.trackPoints) {
            trackPoints.push({
              lat: tp.lat,
              lon: tp.lon,
              time: parseMoves(tp.time),
            });
          }
        }
      }
    }

    // Use first track point as primary location
    const firstPt = trackPoints[0];
    const activities = [...activityTypes];
    const primaryActivity = activities[0] || 'unknown';

    return {
      source_id: sourceId,
      timestamp: ts,
      lat: firstPt ? firstPt.lat : null,
      lon: firstPt ? firstPt.lon : null,
      event_type: 'movement',
      title: `${primaryActivity}${activities.length > 1 ? ' + ' + activities.slice(1).join(', ') : ''}`,
      body: null,
      metadata: {
        activities,
        start_time: parseMoves(seg.startTime),
        end_time: parseMoves(seg.endTime),
        duration_sec: totalDuration,
        distance_m: totalDistance,
        steps: totalSteps || undefined,
        calories: totalCalories || undefined,
        track_point_count: trackPoints.length,
      },
      people: [],
      track: trackPoints.length > 0 ? trackPoints : null,
      source_ref: ref,
    };
  }

  async ingest(db, config, opts = {}) {
    const zipPath = config.path || '~/Documents/2018 Moves Data/import moves.zip';
    const tmpDir = path.join(__dirname, '..', 'data', 'tmp-moves');
    const verbose = opts.verbose;

    console.log(`[moves] Extracting from ${zipPath}...`);
    const storylineDir = this.extractData(zipPath, tmpDir);

    // Get all storyline files
    const files = fs.readdirSync(storylineDir)
      .filter(f => f.startsWith('storyline_') && f.endsWith('.json'))
      .sort();

    console.log(`[moves] Found ${files.length} daily storyline files`);

    // Register source
    const sourceId = this.register(db, config);

    // Clear existing events for re-ingestion
    const existing = db.prepare('SELECT event_count FROM source WHERE id = ?').get(sourceId);
    if (existing && existing.event_count > 0) {
      console.log(`[moves] Clearing ${existing.event_count} existing events for re-ingestion`);
      db.prepare('DELETE FROM event WHERE source_id = ?').run(sourceId);
    }

    let inserted = 0, skipped = 0, errors = 0;

    // Use a transaction for bulk insert performance
    const insertBatch = db.transaction((events) => {
      for (const event of events) {
        if (this.insertEvent(db, event)) {
          inserted++;
        } else {
          skipped++;
        }
      }
    });

    // Process in batches of 100 files
    const batchSize = 100;
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      const events = [];

      for (const file of batch) {
        try {
          const filePath = path.join(storylineDir, file);
          const fileEvents = this.parseStoryline(filePath, sourceId);
          events.push(...fileEvents);
        } catch (err) {
          errors++;
          if (verbose) console.error(`[moves] Error parsing ${file}: ${err.message}`);
        }
      }

      insertBatch(events);
      if (verbose || (i % 500 === 0 && i > 0)) {
        console.log(`[moves] Processed ${Math.min(i + batchSize, files.length)}/${files.length} files (${inserted} events)`);
      }
    }

    // Update source stats
    const stats = this.updateSourceStats(db, sourceId);
    console.log(`[moves] Done: ${inserted} inserted, ${skipped} skipped, ${errors} errors`);
    console.log(`[moves] Date range: ${stats.date_start} to ${stats.date_end}`);

    // Cleanup tmp
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}

    return { inserted, skipped, errors };
  }
}

module.exports = MovesAdapter;
