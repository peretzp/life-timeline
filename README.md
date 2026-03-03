# Life Timeline

A unified temporal map of your digital life. Location history, media, communication, and knowledge stitched into a scrollable, zoomable timeline synchronized with a map view.

## What it does

- **Ingests** data from multiple personal data sources (location history, voice memos, calendars, messages, photos, browsing history)
- **Normalizes** timestamps from 8+ formats into ISO 8601 UTC
- **Stores** everything in a single SQLite database with FTS5 full-text search
- **Visualizes** on a Leaflet map + Canvas timeline with "Powers of Ten" zoom (hour ↔ day ↔ week ↔ month ↔ year)

## Quick Start

```bash
git clone https://github.com/peretzp/life-timeline.git
cd life-timeline
npm install
cp config.example.json config.json
# Edit config.json with your data paths
node ingest/cli.js moves    # Ingest Moves location data
npm start                    # Open https://localhost:3004
```

## Supported Sources

| Source | Adapter | Format | Status |
|--------|---------|--------|--------|
| Moves App | `moves` | ZIP export (JSON/GPX) | Done |
| MemoryAtlas | `memoryatlas` | SQLite (voice memos) | Planned |
| Apple Calendar | `calendar` | SQLite | Planned |
| Daily Notes | `daily-notes` | Markdown files | Planned |
| iMessage | `imessage` | SQLite | Planned |
| Safari History | `safari` | SQLite | Planned |
| Photos (EXIF) | `photos-exif` | EXIF metadata | Planned |
| Google Takeout | `google-takeout` | JSON | Planned |

## Architecture

- **Database**: SQLite + better-sqlite3 (WAL mode, FTS5, JSON1)
- **Server**: Single-file Node.js HTTPS (zero framework)
- **Map**: Leaflet + OpenStreetMap tiles (40KB from CDN)
- **Timeline**: Vanilla Canvas (handles dense data, full control)
- **Ingestion**: Adapter pattern (one file per source)

## Writing an Adapter

```javascript
const BaseAdapter = require('./ingest/base');

class MyAdapter extends BaseAdapter {
  constructor() { super('mydata', 'Description of my data source'); }

  async ingest(db, config, opts) {
    const sourceId = this.register(db, config);
    // Parse your data, call this.insertEvent(db, event) for each
    return this.updateSourceStats(db, sourceId);
  }
}
```

See `ingest/moves.js` for a complete example.

## License

MIT
