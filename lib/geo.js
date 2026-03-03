// Coordinate helpers for life-timeline

const EARTH_RADIUS_KM = 6371;

/**
 * Haversine distance between two points in km
 */
function distance(lat1, lon1, lat2, lon2) {
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Bounding box for a center point + radius in km
 * Returns { minLat, maxLat, minLon, maxLon }
 */
function boundingBox(lat, lon, radiusKm) {
  const latDelta = (radiusKm / EARTH_RADIUS_KM) * (180 / Math.PI);
  const lonDelta = latDelta / Math.cos((lat * Math.PI) / 180);
  return {
    minLat: lat - latDelta,
    maxLat: lat + latDelta,
    minLon: lon - lonDelta,
    maxLon: lon + lonDelta,
  };
}

/**
 * Simplify a GPS track by Douglas-Peucker algorithm
 * Points: [{lat, lon, ...}], tolerance in km
 */
function simplifyTrack(points, toleranceKm = 0.05) {
  if (points.length <= 2) return points;

  let maxDist = 0;
  let maxIdx = 0;
  const first = points[0];
  const last = points[points.length - 1];

  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistance(points[i], first, last);
    if (d > maxDist) {
      maxDist = d;
      maxIdx = i;
    }
  }

  if (maxDist > toleranceKm) {
    const left = simplifyTrack(points.slice(0, maxIdx + 1), toleranceKm);
    const right = simplifyTrack(points.slice(maxIdx), toleranceKm);
    return left.slice(0, -1).concat(right);
  }

  return [first, last];
}

function perpendicularDistance(point, lineStart, lineEnd) {
  // Approximate using cross-track distance
  const d13 = distance(lineStart.lat, lineStart.lon, point.lat, point.lon);
  const bearing13 = bearing(lineStart.lat, lineStart.lon, point.lat, point.lon);
  const bearing12 = bearing(lineStart.lat, lineStart.lon, lineEnd.lat, lineEnd.lon);
  return Math.abs(Math.asin(Math.sin(d13 / EARTH_RADIUS_KM) * Math.sin(bearing13 - bearing12)) * EARTH_RADIUS_KM);
}

function bearing(lat1, lon1, lat2, lon2) {
  const toRad = d => (d * Math.PI) / 180;
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
            Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return Math.atan2(y, x);
}

/**
 * Compute bounds for an array of {lat, lon} points
 */
function trackBounds(points) {
  if (!points || points.length === 0) return null;
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  return { minLat, maxLat, minLon, maxLon };
}

module.exports = { distance, boundingBox, simplifyTrack, trackBounds, EARTH_RADIUS_KM };
