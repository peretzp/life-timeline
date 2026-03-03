# Data Source Adapters

Each adapter is a single file that extends `BaseAdapter` from `base.js`.

## Writing an Adapter

1. Create `yourdata.js` in this directory
2. Extend `BaseAdapter`:

```javascript
const BaseAdapter = require('./base');
const { normalize } = require('../lib/timestamps');

class YourAdapter extends BaseAdapter {
  constructor() {
    super('yourdata', 'Human-readable description');
  }

  async ingest(db, config, opts) {
    const sourceId = this.register(db, config);

    // Parse your data source
    // For each datum:
    this.insertEvent(db, {
      source_id: sourceId,
      timestamp: normalize(rawTimestamp),  // auto-detects format
      lat: 37.7749,                        // optional
      lon: -122.4194,                      // optional
      event_type: 'location',              // location|movement|voice_memo|calendar|daily_note|message|web_visit
      title: 'Event title',
      body: 'Optional body text',
      metadata: { key: 'value' },          // any JSON
      people: ['Alice', 'Bob'],            // mentioned people
      track: [{lat, lon, time}, ...],      // GPS polyline (movement only)
      source_ref: 'unique-id-in-source',   // for dedup on re-ingestion
    });

    return this.updateSourceStats(db, sourceId);
  }
}
```

3. Register in `cli.js`:
```javascript
const adapters = {
  yourdata: () => new (require('./yourdata'))(),
};
```

4. Add config to `config.json`:
```json
{ "sources": { "yourdata": { "path": "~/path/to/data" } } }
```

5. Run: `node ingest/cli.js yourdata`

## Event Types

| Type | Color | Description |
|------|-------|-------------|
| `location` | Green | Stationary place visits |
| `movement` | Blue | Walking, cycling, transport with GPS tracks |
| `voice_memo` | Purple | Audio recordings |
| `calendar` | Blue | Calendar events |
| `daily_note` | Gold | Journal entries |
| `message` | Magenta | Chat messages |
| `web_visit` | Orange | Browsing history |
