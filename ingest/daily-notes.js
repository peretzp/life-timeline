// Obsidian daily notes importer
// Reads vault/Journal/Daily/*.md (2500+ notes, 1998-2026)

const fs = require('fs');
const path = require('path');
const BaseAdapter = require('./base');
const { parseDateFilename } = require('../lib/timestamps');

class DailyNotesAdapter extends BaseAdapter {
  constructor() {
    super('daily_notes', 'Obsidian daily journal notes');
  }

  async ingest(db, config, opts = {}) {
    const notesDir = (config.dir || '~/Library/Mobile Documents/iCloud~md~obsidian/Documents/PracticeLife/Journal/Daily')
      .replace(/^~/, process.env.HOME);
    const verbose = opts.verbose;

    if (!fs.existsSync(notesDir)) {
      throw new Error(`Daily notes directory not found: ${notesDir}`);
    }

    const sourceId = this.register(db, config);

    // Clear existing for re-ingestion
    const existing = db.prepare('SELECT event_count FROM source WHERE id = ?').get(sourceId);
    if (existing && existing.event_count > 0) {
      console.log(`[daily-notes] Clearing ${existing.event_count} existing events`);
      db.prepare('DELETE FROM event WHERE source_id = ?').run(sourceId);
    }

    const files = fs.readdirSync(notesDir)
      .filter(f => f.endsWith('.md') && /^\d{4}-\d{2}-\d{2}/.test(f))
      .sort();

    console.log(`[daily-notes] Found ${files.length} daily notes`);

    let inserted = 0, skipped = 0, errors = 0;

    const insertBatch = db.transaction((events) => {
      for (const event of events) {
        if (this.insertEvent(db, event)) inserted++;
        else skipped++;
      }
    });

    const events = [];
    for (const file of files) {
      try {
        const ts = parseDateFilename(file);
        if (!ts) { skipped++; continue; }

        const filePath = path.join(notesDir, file);
        const content = fs.readFileSync(filePath, 'utf8');

        // Extract title from first heading or filename
        const titleMatch = content.match(/^#\s+(.+)$/m);
        const title = titleMatch ? titleMatch[1] : file.replace('.md', '');

        // Extract people from [[wikilinks]] — these are likely references to people or concepts
        const wikilinks = [];
        const linkPattern = /\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g;
        let match;
        while ((match = linkPattern.exec(content)) !== null) {
          wikilinks.push(match[1]);
        }

        // Extract tags
        const tags = [];
        const tagPattern = /#([a-zA-Z][\w/\-]*)/g;
        while ((match = tagPattern.exec(content)) !== null) {
          tags.push(match[1]);
        }

        // Word count as a rough content indicator
        const wordCount = content.split(/\s+/).filter(Boolean).length;

        // Extract first 500 chars as body preview (skip frontmatter)
        let body = content.replace(/^---[\s\S]*?---\n?/, '').trim();
        if (body.length > 500) body = body.slice(0, 500) + '...';

        events.push({
          source_id: sourceId,
          timestamp: ts,
          lat: null,
          lon: null,
          event_type: 'daily_note',
          title,
          body,
          metadata: {
            filename: file,
            word_count: wordCount,
            tags,
            wikilink_count: wikilinks.length,
          },
          people: wikilinks.slice(0, 50), // Wikilinks often reference people
          track: null,
          source_ref: `note_${file}`,
        });
      } catch (err) {
        errors++;
        if (verbose) console.error(`[daily-notes] Error on ${file}: ${err.message}`);
      }
    }

    // Insert in batches
    const batchSize = 500;
    for (let i = 0; i < events.length; i += batchSize) {
      insertBatch(events.slice(i, i + batchSize));
      if (verbose && i > 0) console.log(`[daily-notes] Inserted ${Math.min(i + batchSize, events.length)}/${events.length}`);
    }

    const stats = this.updateSourceStats(db, sourceId);
    console.log(`[daily-notes] Done: ${inserted} inserted, ${skipped} skipped, ${errors} errors`);
    console.log(`[daily-notes] Date range: ${stats.date_start} to ${stats.date_end}`);

    return { inserted, skipped, errors };
  }
}

module.exports = DailyNotesAdapter;
