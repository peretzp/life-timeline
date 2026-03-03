# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Overview

**Life Timeline** — A unified temporal map of a digital life. Location, media, communication, and knowledge stitched into a scrollable, zoomable timeline with a synchronized map view.

## Commands

```bash
npm install               # Install dependencies (only better-sqlite3)
npm start                 # Start HTTPS server on :3004
npm run dev               # Start with --watch for development
npm run ingest:moves      # Ingest Moves location data
node ingest/cli.js <src>  # Ingest any registered source
```

**Server runs at `https://localhost:3004` (HTTPS with shared self-signed cert).**

## Architecture

**Stack**: Node.js, SQLite (better-sqlite3), Leaflet (CDN), Canvas. Zero build step.

```
life-timeline/
├── server.js             # HTTPS server + API + frontend (single file)
├── lib/
│   ├── db.js             # SQLite schema, migrations, WAL mode
│   ├── timestamps.js     # Universal timestamp normalization (8 formats)
│   └── geo.js            # Haversine, bounding box, track simplification
├── ingest/
│   ├── base.js           # Adapter interface
│   ├── cli.js            # CLI: node ingest/cli.js <source>
│   └── moves.js          # Moves App JSON importer
├── config.json           # Personal paths (.gitignored)
├── config.example.json   # Template for others
└── data/timeline.db      # SQLite database (.gitignored)
```

## Schema

- **`source`** — registered data sources (name, adapter, date range, event count)
- **`event`** — every temporal datum (timestamp UTC, lat/lon, event_type, title, body, metadata JSON, people JSON, track JSON)
- **`event_fts`** — FTS5 virtual table over title/body/people, kept in sync via triggers

## API

| Endpoint | Description |
|----------|-------------|
| `GET /api/sources` | All registered sources with stats |
| `GET /api/timeline/bounds` | Earliest/latest event timestamps |
| `GET /api/timeline/density?bucket=month` | Event counts per time bucket |
| `GET /api/timeline?start=...&end=...&scale=day` | Events in range |
| `GET /api/locations?start=...&end=...` | Events with coordinates |
| `GET /api/tracks?start=...&end=...` | Movement GPS tracks |
| `GET /api/search?q=...` | FTS5 full-text search |
| `GET /api/event/:id` | Single event detail |

## Adding a Data Source

1. Create `ingest/yoursource.js` extending `BaseAdapter`
2. Implement `async ingest(db, config, opts)`
3. Register in `ingest/cli.js` adapters map
4. Add source config to `config.json`
5. Run `node ingest/cli.js yoursource`

## Timestamp Formats Supported

- ISO 8601 (standard)
- Moves compact: `20160710T000000-0500`
- Apple epoch seconds (Calendar, Safari)
- Apple epoch nanoseconds (Messages)
- Date-only filenames: `2026-03-02.md`
- EXIF datetime: `YYYY:MM:DD HH:MM:SS`

## SSL

Uses shared certs from `~/.ssl/localhost.{crt,key}`. Falls back to HTTP if not found.
