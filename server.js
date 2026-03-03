// Life Timeline — HTTPS server
// Single-file Node.js server with API + frontend
// Port 3004 (after dashboard:3000, api:3001, prompt-browser:3002, contact-verify:3003)

const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { getDb, close } = require('./lib/db');

// Config
const configPath = path.join(__dirname, 'config.json');
const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
const PORT = config.port || 3004;

// SSL
const sslCert = (config.ssl?.cert || '~/.ssl/localhost.crt').replace(/^~/, process.env.HOME);
const sslKey = (config.ssl?.key || '~/.ssl/localhost.key').replace(/^~/, process.env.HOME);

let sslOpts;
try {
  sslOpts = { cert: fs.readFileSync(sslCert), key: fs.readFileSync(sslKey) };
} catch {
  console.error(`SSL certs not found at ${sslCert} / ${sslKey}. Falling back to HTTP.`);
  sslOpts = null;
}

// ── API helpers ──

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function parseQuery(urlStr) {
  const u = new URL(urlStr, 'https://localhost');
  const q = {};
  for (const [k, v] of u.searchParams) q[k] = v;
  return { pathname: u.pathname, query: q };
}

// ── API routes ──

function apiSources(req, res) {
  const db = getDb();
  const sources = db.prepare('SELECT * FROM source ORDER BY name').all();
  json(res, { sources });
}

function apiTimelineBounds(req, res) {
  const db = getDb();
  const bounds = db.prepare(`
    SELECT MIN(timestamp) as earliest, MAX(timestamp) as latest, COUNT(*) as total
    FROM event
  `).get();
  json(res, bounds);
}

function apiTimelineDensity(req, res, query) {
  const db = getDb();
  const bucket = query.bucket || 'month';

  let strftime;
  switch (bucket) {
    case 'year': strftime = '%Y'; break;
    case 'month': strftime = '%Y-%m'; break;
    case 'week': strftime = '%Y-W%W'; break;
    case 'day': strftime = '%Y-%m-%d'; break;
    case 'hour': strftime = '%Y-%m-%dT%H'; break;
    default: strftime = '%Y-%m';
  }

  const rows = db.prepare(`
    SELECT strftime('${strftime}', timestamp) as bucket, event_type, COUNT(*) as count
    FROM event
    GROUP BY bucket, event_type
    ORDER BY bucket
  `).all();

  // Group by bucket
  const buckets = {};
  for (const r of rows) {
    if (!buckets[r.bucket]) buckets[r.bucket] = { bucket: r.bucket, total: 0, by_type: {} };
    buckets[r.bucket].total += r.count;
    buckets[r.bucket].by_type[r.event_type] = r.count;
  }

  json(res, { bucket, data: Object.values(buckets) });
}

function apiTimeline(req, res, query) {
  const db = getDb();
  const start = query.start || '1970-01-01';
  const end = query.end || '2100-01-01';
  const scale = query.scale || 'day';
  const limit = Math.min(parseInt(query.limit) || 5000, 50000);
  const offset = parseInt(query.offset) || 0;
  const type = query.type || null;

  let where = 'timestamp >= ? AND timestamp < ?';
  const params = [new Date(start).toISOString(), new Date(end + 'T23:59:59Z').toISOString()];

  if (type) {
    where += ' AND event_type = ?';
    params.push(type);
  }

  const events = db.prepare(`
    SELECT id, source_id, timestamp, lat, lon, event_type, title, metadata, source_ref
    FROM event
    WHERE ${where}
    ORDER BY timestamp
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  // Parse metadata JSON
  for (const e of events) {
    try { e.metadata = JSON.parse(e.metadata); } catch { e.metadata = {}; }
  }

  json(res, { count: events.length, start, end, scale, events });
}

function apiLocations(req, res, query) {
  const db = getDb();
  const start = query.start || '1970-01-01';
  const end = query.end || '2100-01-01';

  const events = db.prepare(`
    SELECT id, timestamp, lat, lon, event_type, title, metadata
    FROM event
    WHERE timestamp >= ? AND timestamp < ? AND lat IS NOT NULL
    ORDER BY timestamp
    LIMIT 10000
  `).all(new Date(start).toISOString(), new Date(end + 'T23:59:59Z').toISOString());

  for (const e of events) {
    try { e.metadata = JSON.parse(e.metadata); } catch { e.metadata = {}; }
  }

  json(res, { count: events.length, events });
}

function apiTracks(req, res, query) {
  const db = getDb();
  const start = query.start || '1970-01-01';
  const end = query.end || '2100-01-01';

  const events = db.prepare(`
    SELECT id, timestamp, event_type, title, track, metadata
    FROM event
    WHERE timestamp >= ? AND timestamp < ? AND track IS NOT NULL
    ORDER BY timestamp
    LIMIT 2000
  `).all(new Date(start).toISOString(), new Date(end + 'T23:59:59Z').toISOString());

  for (const e of events) {
    try { e.track = JSON.parse(e.track); } catch { e.track = []; }
    try { e.metadata = JSON.parse(e.metadata); } catch { e.metadata = {}; }
  }

  json(res, { count: events.length, events });
}

function apiSearch(req, res, query) {
  const db = getDb();
  const q = query.q;
  if (!q) return json(res, { error: 'Missing query parameter q' }, 400);

  const results = db.prepare(`
    SELECT e.id, e.timestamp, e.lat, e.lon, e.event_type, e.title, e.body, e.metadata
    FROM event_fts fts
    JOIN event e ON e.id = fts.rowid
    WHERE event_fts MATCH ?
    ORDER BY e.timestamp DESC
    LIMIT 100
  `).all(q);

  for (const r of results) {
    try { r.metadata = JSON.parse(r.metadata); } catch { r.metadata = {}; }
  }

  json(res, { query: q, count: results.length, results });
}

function apiEventDetail(req, res, id) {
  const db = getDb();
  const event = db.prepare(`
    SELECT e.*, s.name as source_name
    FROM event e JOIN source s ON s.id = e.source_id
    WHERE e.id = ?
  `).get(id);

  if (!event) return json(res, { error: 'Not found' }, 404);

  try { event.metadata = JSON.parse(event.metadata); } catch { event.metadata = {}; }
  try { event.people = JSON.parse(event.people); } catch { event.people = []; }
  try { event.track = JSON.parse(event.track); } catch { event.track = null; }

  json(res, event);
}

// ── Frontend ──

function renderHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Life Timeline</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0a0a0a; color: #e0e0e0; font-family: 'SF Mono', 'Fira Code', monospace; overflow: hidden; height: 100vh; }

    #map { width: 100%; height: 60vh; background: #111; }
    #timeline-container { width: 100%; height: 25vh; background: #0d0d0d; border-top: 1px solid #222; position: relative; cursor: crosshair; }
    #timeline-canvas { width: 100%; height: 100%; display: block; }
    #detail { width: 100%; height: 15vh; background: #0a0a0a; border-top: 1px solid #222; padding: 12px 20px; overflow-y: auto; }

    /* Timeline controls overlay */
    #timeline-controls {
      position: absolute; top: 8px; left: 16px; z-index: 1000;
      display: flex; gap: 12px; align-items: center; font-size: 12px;
    }
    #timeline-controls .scale-label {
      background: #1a1a1a; padding: 4px 10px; border-radius: 4px; border: 1px solid #333;
      color: #8f8; font-weight: bold; min-width: 60px; text-align: center;
    }
    #timeline-controls .range-label { color: #888; }

    /* Detail panel */
    #detail h3 { color: #8f8; font-size: 14px; margin-bottom: 4px; }
    #detail .meta { color: #888; font-size: 12px; line-height: 1.6; }
    #detail .meta span { color: #ccc; }
    #detail .empty { color: #555; font-style: italic; }

    /* Map styling */
    .leaflet-container { background: #111 !important; }
    .leaflet-tile-pane { filter: brightness(0.7) contrast(1.1) saturate(0.3) hue-rotate(180deg) invert(1); }

    /* Loading overlay */
    #loading {
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.85); display: flex; flex-direction: column;
      align-items: center; justify-content: center; z-index: 9999;
      transition: opacity 0.5s;
    }
    #loading.hidden { opacity: 0; pointer-events: none; }
    #loading .spinner { width: 40px; height: 40px; border: 3px solid #333; border-top: 3px solid #8f8; border-radius: 50%; animation: spin 0.8s linear infinite; }
    #loading p { margin-top: 16px; color: #888; font-size: 13px; }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Source badges */
    .source-badge { display: inline-block; padding: 2px 8px; border-radius: 3px; font-size: 11px; margin: 2px; }
    .type-location { background: #1a3a1a; color: #6f6; }
    .type-movement { background: #1a2a3a; color: #6af; }
  </style>
</head>
<body>

<div id="loading"><div class="spinner"></div><p>Loading timeline...</p></div>

<div id="map"></div>

<div id="timeline-container">
  <div id="timeline-controls">
    <span class="scale-label" id="scale-display">month</span>
    <span class="range-label" id="range-display">—</span>
  </div>
  <canvas id="timeline-canvas"></canvas>
</div>

<div id="detail">
  <p class="empty">Select a time range on the timeline to see events. Scroll to zoom in/out.</p>
</div>

<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
(function() {
  // ── State ──
  const SCALES = ['hour', 'day', 'week', 'month', 'year'];
  let currentScale = 3; // month
  let viewStart = null;
  let viewEnd = null;
  let globalStart = null;
  let globalEnd = null;
  let densityData = [];
  let selectedBucket = null;
  let mapMarkers = [];
  let mapTracks = [];

  const TYPE_COLORS = {
    location: '#44cc44',
    movement: '#4488ff',
    voice_memo: '#cc88ff',
    calendar: '#4488ff',
    daily_note: '#ffcc44',
    message: '#cc44cc',
    web_visit: '#ff8844',
  };

  // ── Map ──
  const map = L.map('map', {
    center: [37.77, -122.41],
    zoom: 12,
    zoomControl: true,
    attributionControl: false,
  });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap',
  }).addTo(map);

  const markerGroup = L.layerGroup().addTo(map);
  const trackGroup = L.layerGroup().addTo(map);

  // ── Canvas Timeline ──
  const canvas = document.getElementById('timeline-canvas');
  const ctx = canvas.getContext('2d');
  const container = document.getElementById('timeline-container');

  function resizeCanvas() {
    const rect = container.getBoundingClientRect();
    canvas.width = rect.width * window.devicePixelRatio;
    canvas.height = rect.height * window.devicePixelRatio;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
  }

  // ── API ──
  async function apiFetch(url) {
    const r = await fetch(url);
    return r.json();
  }

  // ── Init ──
  async function init() {
    const bounds = await apiFetch('/api/timeline/bounds');
    globalStart = new Date(bounds.earliest);
    globalEnd = new Date(bounds.latest);
    viewStart = new Date(globalStart);
    viewEnd = new Date(globalEnd);

    document.getElementById('loading').classList.add('hidden');
    resizeCanvas();
    await loadDensity();
    drawTimeline();
    updateRangeDisplay();
  }

  async function loadDensity() {
    const scale = SCALES[currentScale];
    const data = await apiFetch('/api/timeline/density?bucket=' + scale);
    densityData = data.data || [];
    document.getElementById('scale-display').textContent = scale;
  }

  function updateRangeDisplay() {
    const fmt = d => d.toISOString().slice(0, 10);
    document.getElementById('range-display').textContent = fmt(viewStart) + ' to ' + fmt(viewEnd);
  }

  // ── Draw Timeline ──
  function drawTimeline() {
    const w = canvas.width / window.devicePixelRatio;
    const h = canvas.height / window.devicePixelRatio;
    ctx.clearRect(0, 0, w, h);

    if (!densityData.length) return;

    const viewMs = viewEnd - viewStart;
    if (viewMs <= 0) return;

    // Find max count for scaling
    let maxCount = 0;
    for (const d of densityData) {
      if (d.total > maxCount) maxCount = d.total;
    }
    if (maxCount === 0) maxCount = 1;

    const barPad = 1;
    const topPad = 32;
    const botPad = 24;
    const drawH = h - topPad - botPad;

    // Draw each bucket
    for (const d of densityData) {
      const bucketDate = parseBucketDate(d.bucket);
      if (!bucketDate) continue;

      const x = ((bucketDate - viewStart) / viewMs) * w;
      const bucketWidth = getBucketWidth(viewMs, w);
      if (x + bucketWidth < 0 || x > w) continue;

      // Stacked bars by type
      let yOff = 0;
      for (const [type, count] of Object.entries(d.by_type)) {
        const barH = (count / maxCount) * drawH;
        const color = TYPE_COLORS[type] || '#666';
        ctx.fillStyle = color;
        ctx.globalAlpha = d.bucket === selectedBucket ? 1.0 : 0.65;
        ctx.fillRect(x, topPad + drawH - yOff - barH, Math.max(bucketWidth - barPad, 1), barH);
        yOff += barH;
      }
    }
    ctx.globalAlpha = 1.0;

    // Selected bucket highlight
    if (selectedBucket) {
      const bucketDate = parseBucketDate(selectedBucket);
      if (bucketDate) {
        const x = ((bucketDate - viewStart) / viewMs) * w;
        const bw = getBucketWidth(viewMs, w);
        ctx.strokeStyle = '#8f8';
        ctx.lineWidth = 2;
        ctx.strokeRect(x, topPad, Math.max(bw, 2), drawH);
      }
    }

    // Time axis labels
    ctx.fillStyle = '#666';
    ctx.font = '11px monospace';
    ctx.textAlign = 'center';
    const labelCount = Math.min(12, densityData.length);
    const step = Math.max(1, Math.floor(densityData.length / labelCount));
    for (let i = 0; i < densityData.length; i += step) {
      const d = densityData[i];
      const bucketDate = parseBucketDate(d.bucket);
      if (!bucketDate) continue;
      const x = ((bucketDate - viewStart) / viewMs) * w;
      if (x >= 0 && x <= w) {
        ctx.fillText(d.bucket, x, h - 6);
      }
    }
  }

  function parseBucketDate(bucket) {
    // Handle week format "YYYY-Wnn"
    if (/^\d{4}-W\d{2}$/.test(bucket)) {
      const [year, week] = bucket.split('-W');
      const d = new Date(parseInt(year), 0, 1 + (parseInt(week) - 1) * 7);
      return d;
    }
    // Handle hour format
    if (/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(bucket)) {
      return new Date(bucket + ':00:00Z');
    }
    const d = new Date(bucket + (bucket.length <= 7 ? '-01' : '') + 'T00:00:00Z');
    return isNaN(d) ? null : d;
  }

  function getBucketWidth(viewMs, canvasW) {
    const scale = SCALES[currentScale];
    let bucketMs;
    switch (scale) {
      case 'hour': bucketMs = 3600000; break;
      case 'day': bucketMs = 86400000; break;
      case 'week': bucketMs = 604800000; break;
      case 'month': bucketMs = 2592000000; break;
      case 'year': bucketMs = 31536000000; break;
      default: bucketMs = 2592000000;
    }
    return Math.max((bucketMs / viewMs) * canvasW, 2);
  }

  // ── Interactions ──

  // Mousewheel zoom on timeline
  container.addEventListener('wheel', async (e) => {
    e.preventDefault();
    const oldScale = currentScale;
    if (e.deltaY < 0 && currentScale > 0) currentScale--;
    if (e.deltaY > 0 && currentScale < SCALES.length - 1) currentScale++;
    if (currentScale === oldScale) return;

    // Zoom toward mouse position
    const rect = container.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    const viewMs = viewEnd - viewStart;
    const mouseDate = new Date(viewStart.getTime() + pct * viewMs);

    // Adjust view range based on scale change
    const direction = currentScale > oldScale ? 2 : 0.5;
    const newSpan = viewMs * direction;
    viewStart = new Date(mouseDate.getTime() - pct * newSpan);
    viewEnd = new Date(mouseDate.getTime() + (1 - pct) * newSpan);

    // Clamp to global bounds
    if (viewStart < globalStart) viewStart = new Date(globalStart);
    if (viewEnd > globalEnd) viewEnd = new Date(globalEnd);

    await loadDensity();
    drawTimeline();
    updateRangeDisplay();
  });

  // Click on timeline to select bucket
  canvas.addEventListener('click', async (e) => {
    const rect = container.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    const viewMs = viewEnd - viewStart;
    const clickDate = new Date(viewStart.getTime() + pct * viewMs);

    // Find closest bucket
    let closest = null;
    let closestDist = Infinity;
    for (const d of densityData) {
      const bd = parseBucketDate(d.bucket);
      if (!bd) continue;
      const dist = Math.abs(bd - clickDate);
      if (dist < closestDist) {
        closestDist = dist;
        closest = d;
      }
    }

    if (closest) {
      selectedBucket = closest.bucket;
      drawTimeline();
      await loadBucketEvents(closest.bucket);
    }
  });

  // Drag to pan
  let isDragging = false;
  let dragStartX = 0;
  let dragStartViewStart = null;

  canvas.addEventListener('mousedown', (e) => {
    isDragging = true;
    dragStartX = e.clientX;
    dragStartViewStart = new Date(viewStart);
    canvas.style.cursor = 'grabbing';
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const rect = container.getBoundingClientRect();
    const dx = e.clientX - dragStartX;
    const viewMs = viewEnd - viewStart;
    const shift = -(dx / rect.width) * viewMs;
    viewStart = new Date(dragStartViewStart.getTime() + shift);
    viewEnd = new Date(viewStart.getTime() + viewMs);
    drawTimeline();
    updateRangeDisplay();
  });

  window.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      canvas.style.cursor = 'crosshair';
    }
  });

  // ── Load events for a bucket ──
  async function loadBucketEvents(bucket) {
    const scale = SCALES[currentScale];
    let start, end;
    const bd = parseBucketDate(bucket);

    switch (scale) {
      case 'hour':
        start = bd.toISOString().slice(0, 13) + ':00:00Z';
        end = new Date(bd.getTime() + 3600000).toISOString();
        break;
      case 'day':
        start = bd.toISOString().slice(0, 10);
        end = new Date(bd.getTime() + 86400000).toISOString().slice(0, 10);
        break;
      case 'week':
        start = bd.toISOString().slice(0, 10);
        end = new Date(bd.getTime() + 604800000).toISOString().slice(0, 10);
        break;
      case 'month':
        start = bucket + '-01';
        const m = parseInt(bucket.slice(5, 7));
        const y = parseInt(bucket.slice(0, 4));
        end = (m === 12 ? (y + 1) + '-01' : y + '-' + String(m + 1).padStart(2, '0')) + '-01';
        break;
      case 'year':
        start = bucket + '-01-01';
        end = (parseInt(bucket) + 1) + '-01-01';
        break;
    }

    // Load locations and tracks in parallel
    const [locData, trackData] = await Promise.all([
      apiFetch('/api/locations?start=' + encodeURIComponent(start) + '&end=' + encodeURIComponent(end)),
      apiFetch('/api/tracks?start=' + encodeURIComponent(start) + '&end=' + encodeURIComponent(end)),
    ]);

    updateMap(locData.events || [], trackData.events || []);
    updateDetail(locData.events || [], trackData.events || [], bucket);
  }

  // ── Map Update ──
  function updateMap(locations, tracks) {
    markerGroup.clearLayers();
    trackGroup.clearLayers();

    const bounds = [];

    // Add location markers
    for (const e of locations) {
      if (!e.lat || !e.lon) continue;
      const color = TYPE_COLORS[e.event_type] || '#888';
      const marker = L.circleMarker([e.lat, e.lon], {
        radius: e.event_type === 'location' ? 6 : 3,
        fillColor: color,
        color: color,
        fillOpacity: 0.7,
        weight: 1,
      });
      marker.bindPopup('<b>' + esc(e.title || '—') + '</b><br>' +
        '<small>' + e.timestamp.slice(0, 16).replace('T', ' ') + '</small>');
      markerGroup.addLayer(marker);
      bounds.push([e.lat, e.lon]);
    }

    // Add movement tracks
    for (const e of tracks) {
      if (!e.track || e.track.length < 2) continue;
      const latlngs = e.track.map(p => [p.lat, p.lon]);
      const color = e.title?.includes('walking') ? '#44cc44' :
                    e.title?.includes('cycling') ? '#ffcc44' :
                    e.title?.includes('running') ? '#ff6644' : '#4488ff';
      const line = L.polyline(latlngs, { color, weight: 2, opacity: 0.6 });
      trackGroup.addLayer(line);
      bounds.push(...latlngs);
    }

    if (bounds.length > 0) {
      map.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 });
    }
  }

  // ── Detail Panel ──
  function updateDetail(locations, tracks, bucket) {
    const el = document.getElementById('detail');
    const allEvents = [...locations, ...tracks].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    if (allEvents.length === 0) {
      el.innerHTML = '<p class="empty">No events for ' + esc(bucket) + '</p>';
      return;
    }

    // Summarize
    const places = locations.filter(e => e.event_type === 'location');
    const movements = [...locations.filter(e => e.event_type === 'movement'), ...tracks];
    const uniquePlaces = [...new Set(places.map(p => p.title).filter(Boolean))];
    const totalDistance = movements.reduce((sum, m) => sum + (m.metadata?.distance_m || 0), 0);
    const totalSteps = allEvents.reduce((sum, e) => sum + (e.metadata?.steps || 0), 0);

    let html = '<h3>' + esc(bucket) + ' — ' + allEvents.length + ' events</h3><div class="meta">';
    if (uniquePlaces.length > 0) {
      html += '<div>Places: <span>' + uniquePlaces.slice(0, 8).map(esc).join(', ') +
              (uniquePlaces.length > 8 ? ' +' + (uniquePlaces.length - 8) + ' more' : '') + '</span></div>';
    }
    if (totalDistance > 0) {
      html += '<div>Distance: <span>' + (totalDistance / 1000).toFixed(1) + ' km</span></div>';
    }
    if (totalSteps > 0) {
      html += '<div>Steps: <span>' + totalSteps.toLocaleString() + '</span></div>';
    }

    // Event list (first 20)
    html += '<div style="margin-top:6px">';
    for (const e of allEvents.slice(0, 20)) {
      const time = e.timestamp.slice(11, 16);
      const typeClass = 'type-' + e.event_type;
      html += '<div><span class="source-badge ' + typeClass + '">' + e.event_type + '</span> ' +
              '<span style="color:#666">' + time + '</span> ' +
              '<span>' + esc(e.title || '—') + '</span></div>';
    }
    if (allEvents.length > 20) {
      html += '<div style="color:#555">+' + (allEvents.length - 20) + ' more events</div>';
    }
    html += '</div></div>';
    el.innerHTML = html;
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── Resize ──
  window.addEventListener('resize', () => {
    resizeCanvas();
    drawTimeline();
  });

  // ── Boot ──
  init();
})();
</script>
</body>
</html>`;
}

// ── Router ──

function handleRequest(req, res) {
  const { pathname, query } = parseQuery(req.url);

  // API routes
  if (pathname === '/api/sources') return apiSources(req, res);
  if (pathname === '/api/timeline/bounds') return apiTimelineBounds(req, res);
  if (pathname === '/api/timeline/density') return apiTimelineDensity(req, res, query);
  if (pathname === '/api/timeline') return apiTimeline(req, res, query);
  if (pathname === '/api/locations') return apiLocations(req, res, query);
  if (pathname === '/api/tracks') return apiTracks(req, res, query);
  if (pathname === '/api/search') return apiSearch(req, res, query);

  // Event detail: /api/event/:id
  const eventMatch = pathname.match(/^\/api\/event\/(\d+)$/);
  if (eventMatch) return apiEventDetail(req, res, parseInt(eventMatch[1]));

  // Health
  if (pathname === '/health') return json(res, { status: 'ok', port: PORT });

  // Frontend
  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(renderHTML());
  }

  // Static files from public/
  const safePath = path.join(__dirname, 'public', pathname.replace(/\.\./g, ''));
  if (fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
    const ext = path.extname(safePath);
    const types = { '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    return fs.createReadStream(safePath).pipe(res);
  }

  // 404
  json(res, { error: 'Not found' }, 404);
}

// ── Start ──

const server = sslOpts
  ? https.createServer(sslOpts, handleRequest)
  : require('http').createServer(handleRequest);

server.listen(PORT, () => {
  const proto = sslOpts ? 'https' : 'http';
  console.log(`Life Timeline running at ${proto}://localhost:${PORT}`);
  console.log(`API: ${proto}://localhost:${PORT}/api/sources`);
});

// Graceful shutdown
process.on('SIGINT', () => { close(); process.exit(0); });
process.on('SIGTERM', () => { close(); process.exit(0); });
