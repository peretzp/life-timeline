#!/usr/bin/env node
// CLI for data ingestion: node ingest/cli.js [source]

const fs = require('fs');
const path = require('path');
const { getDb, close } = require('../lib/db');

// Load config
const configPath = path.join(__dirname, '..', 'config.json');
let config = {};
if (fs.existsSync(configPath)) {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

// Available adapters
const adapters = {
  moves: () => new (require('./moves'))(),
};

async function main() {
  const source = process.argv[2];
  const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');

  if (!source || source === '--help') {
    console.log('Usage: node ingest/cli.js <source> [--verbose]');
    console.log('Sources:', Object.keys(adapters).join(', '));
    process.exit(0);
  }

  if (!adapters[source]) {
    console.error(`Unknown source: ${source}`);
    console.error('Available:', Object.keys(adapters).join(', '));
    process.exit(1);
  }

  const db = getDb();
  const adapter = adapters[source]();
  const sourceConfig = (config.sources || {})[source] || {};

  console.log(`\n=== Ingesting: ${adapter.description} ===\n`);
  const t0 = Date.now();

  try {
    const result = await adapter.ingest(db, sourceConfig, { verbose });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\nCompleted in ${elapsed}s`);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`\nFailed: ${err.message}`);
    if (verbose) console.error(err.stack);
    process.exit(1);
  } finally {
    close();
  }
}

main();
