// Unified timestamp normalization for all data sources
// Canonical form: ISO 8601 UTC (e.g. "2016-07-10T05:00:00.000Z")

// Apple epoch: 2001-01-01 00:00:00 UTC
const APPLE_EPOCH_OFFSET = 978307200;

/**
 * Parse Moves compact format: "20160710T000000-0500"
 * Returns ISO 8601 UTC string
 */
function parseMoves(s) {
  if (!s || s.length < 15) return null;
  // Format: YYYYMMDDTHHmmss±HHMM or YYYYMMDDTHHmmssZ
  const year = s.slice(0, 4);
  const month = s.slice(4, 6);
  const day = s.slice(6, 8);
  const hour = s.slice(9, 11);
  const min = s.slice(11, 13);
  const sec = s.slice(13, 15);
  const tz = s.slice(15); // e.g. "-0500" or "Z"

  let iso = `${year}-${month}-${day}T${hour}:${min}:${sec}`;
  if (tz === 'Z' || tz === '') {
    iso += 'Z';
  } else {
    // Convert -0500 to -05:00
    iso += tz.slice(0, 3) + ':' + tz.slice(3);
  }
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Parse ISO 8601 (standard format)
 */
function parseISO(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Parse Apple epoch seconds (Calendar, Safari)
 * Seconds since 2001-01-01 00:00:00 UTC
 */
function parseAppleEpoch(seconds) {
  if (seconds == null || isNaN(seconds)) return null;
  const d = new Date((seconds + APPLE_EPOCH_OFFSET) * 1000);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Parse Apple epoch nanoseconds (Messages)
 * Nanoseconds since 2001-01-01 00:00:00 UTC
 */
function parseAppleNano(nano) {
  if (nano == null || isNaN(nano)) return null;
  return parseAppleEpoch(nano / 1e9);
}

/**
 * Parse date-only filenames: "2026-03-02.md" → "2026-03-02T00:00:00.000Z"
 */
function parseDateFilename(filename) {
  if (!filename) return null;
  const match = filename.match(/(\d{4}-\d{2}-\d{2})/);
  if (!match) return null;
  const d = new Date(match[1] + 'T00:00:00Z');
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Parse EXIF datetime: "YYYY:MM:DD HH:MM:SS"
 */
function parseEXIF(s) {
  if (!s) return null;
  const fixed = s.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3');
  const d = new Date(fixed);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Universal parser — tries all formats
 */
function normalize(input) {
  if (!input) return null;

  // Number: Apple epoch
  if (typeof input === 'number') {
    if (input > 1e15) return parseAppleNano(input);
    if (input > 1e8) return parseAppleEpoch(input);
    return null;
  }

  const s = String(input).trim();

  // Moves compact: 20160710T000000-0500
  if (/^\d{8}T\d{6}/.test(s)) return parseMoves(s);

  // EXIF: 2016:07:10 12:00:00
  if (/^\d{4}:\d{2}:\d{2}\s/.test(s)) return parseEXIF(s);

  // Date-only filename: 2026-03-02.md
  if (/^\d{4}-\d{2}-\d{2}\.\w+$/.test(s)) return parseDateFilename(s);

  // Date-only: 2026-03-02
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return parseISO(s + 'T00:00:00Z');

  // Standard ISO 8601
  return parseISO(s);
}

module.exports = {
  normalize,
  parseMoves,
  parseISO,
  parseAppleEpoch,
  parseAppleNano,
  parseDateFilename,
  parseEXIF,
  APPLE_EPOCH_OFFSET,
};
