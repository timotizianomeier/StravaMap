require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ─── Paths ────────────────────────────────────────────────────────────────────
const ROOT          = __dirname;
const CACHE_DIR     = path.join(ROOT,  'cache');
const STREAMS_DIR   = path.join(CACHE_DIR, 'streams');
const ACTIVITIES_F  = path.join(CACHE_DIR, 'activities.json');
const TOKENS_F      = path.join(ROOT,  'tokens.json');

[CACHE_DIR, STREAMS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

const PORT         = process.env.PORT || 3000;
const REDIRECT_URI = `http://localhost:${PORT}/auth/callback`;

// ─── Token helpers ────────────────────────────────────────────────────────────
function readTokens() {
  if (fs.existsSync(TOKENS_F)) return JSON.parse(fs.readFileSync(TOKENS_F, 'utf8'));
  if (process.env.STRAVA_REFRESH_TOKEN) return { refresh_token: process.env.STRAVA_REFRESH_TOKEN };
  return null;
}

function writeTokens(t) {
  fs.writeFileSync(TOKENS_F, JSON.stringify(t, null, 2));
}

async function getAccessToken() {
  const t = readTokens();
  if (!t?.refresh_token) throw new Error('NO_AUTH');

  // Still valid with 5-minute buffer
  if (t.access_token && t.expires_at && (Date.now() / 1000) < (t.expires_at - 300)) {
    return t.access_token;
  }

  const { data } = await axios.post('https://www.strava.com/oauth/token', {
    client_id:     process.env.STRAVA_CLIENT_ID,
    client_secret: process.env.STRAVA_CLIENT_SECRET,
    refresh_token: t.refresh_token,
    grant_type:    'refresh_token',
  });

  writeTokens({ ...t, access_token: data.access_token, refresh_token: data.refresh_token, expires_at: data.expires_at });
  return data.access_token;
}

// ─── Activity cache helpers ───────────────────────────────────────────────────
function readActivities() {
  return fs.existsSync(ACTIVITIES_F)
    ? JSON.parse(fs.readFileSync(ACTIVITIES_F, 'utf8'))
    : { activities: [], lastSync: null };
}

function writeActivities(data) {
  fs.writeFileSync(ACTIVITIES_F, JSON.stringify(data, null, 2));
}

// ─── Stream cache helpers ─────────────────────────────────────────────────────
function readStream(id) {
  const f = path.join(STREAMS_DIR, `${id}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

function writeStream(id, data) {
  fs.writeFileSync(path.join(STREAMS_DIR, `${id}.json`), JSON.stringify(data, null, 2));
  addTrack(id, data);
}

// ─── Full tracks ──────────────────────────────────────────────────────────────
// Strava trims privacy zones out of every activity's summary polyline, but the
// owner's latlng stream is complete. tracks.json maps activity id → encoded,
// simplified polyline built from cached streams, so the map can draw full
// routes without re-reading every stream file on each page load.
const TRACKS_F            = path.join(CACHE_DIR, 'tracks.json');
const TRACK_TOLERANCE_DEG = 0.00002; // ~2 m Douglas-Peucker tolerance
let   tracksMemo          = null;

function getTracks() {
  if (tracksMemo) return tracksMemo;
  if (fs.existsSync(TRACKS_F)) return (tracksMemo = JSON.parse(fs.readFileSync(TRACKS_F, 'utf8')));
  return rebuildTracks();
}

function rebuildTracks() {
  const tracks = {};
  for (const f of fs.readdirSync(STREAMS_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const t = trackFromStream(JSON.parse(fs.readFileSync(path.join(STREAMS_DIR, f), 'utf8')));
      if (t) tracks[f.slice(0, -5)] = t;
    } catch { /* skip unreadable stream */ }
  }
  tracksMemo = tracks;
  fs.writeFileSync(TRACKS_F, JSON.stringify(tracks));
  return tracks;
}

function addTrack(id, stream) {
  const t = trackFromStream(stream);
  if (!t) return;
  const tracks = getTracks();
  tracks[id] = t;
  fs.writeFileSync(TRACKS_F, JSON.stringify(tracks));
}

function hasStream(id) { return fs.existsSync(path.join(STREAMS_DIR, `${id}.json`)); }

// Encoded polyline of a stream's latlng data, or null when it has none.
function trackFromStream(stream) {
  const ll = stream?.latlng?.data;
  if (!Array.isArray(ll) || ll.length < 2) return null;
  return encodePolyline(simplify(ll, TRACK_TOLERANCE_DEG));
}

// Iterative Douglas-Peucker on [lat, lng] points.
function simplify(points, tol) {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = perpDistance(points[i], points[a], points[b]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return points.filter((_, i) => keep[i]);
}

// Distance from p to segment a–b in degrees, with longitude scaled by
// cos(lat) so the tolerance is roughly isotropic.
function perpDistance([py, px], [ay, ax], [by, bx]) {
  const k = Math.cos(py * Math.PI / 180);
  px *= k; ax *= k; bx *= k;
  const dx = bx - ax, dy = by - ay;
  if (dx === 0 && dy === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Google encoded polyline algorithm, 1e5 precision (what the client decodes).
function encodePolyline(points) {
  const enc = v => {
    v = v < 0 ? ~(v << 1) : (v << 1);
    let out = '';
    while (v >= 0x20) { out += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    return out + String.fromCharCode(v + 63);
  };
  let out = '', prevLat = 0, prevLng = 0;
  for (const [lat, lng] of points) {
    const la = Math.round(lat * 1e5), ln = Math.round(lng * 1e5);
    out += enc(la - prevLat) + enc(ln - prevLng);
    prevLat = la; prevLng = ln;
  }
  return out;
}

// True when Strava's 15-minute or daily read budget is nearly used up.
// Prefers the read-specific headers; falls back to the overall ones.
function readBudgetExhausted(headers) {
  const usage = (headers['x-readratelimit-usage'] || headers['x-ratelimit-usage'] || '0,0').split(',').map(Number);
  const limit = (headers['x-readratelimit-limit'] || headers['x-ratelimit-limit'] || '100,1000').split(',').map(Number);
  return usage[0] >= limit[0] - 10 || usage[1] >= limit[1] - 20;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
app.get('/auth/strava', (req, res) => {
  const u = new URL('https://www.strava.com/oauth/authorize');
  u.searchParams.set('client_id',     process.env.STRAVA_CLIENT_ID);
  u.searchParams.set('redirect_uri',  REDIRECT_URI);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope',         'activity:read_all');
  res.redirect(u.toString());
});

app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) {
    return res.status(400).send(`<h2>Auth failed: ${error || 'no code'}</h2><a href="/">← Back</a>`);
  }
  try {
    const { data } = await axios.post('https://www.strava.com/oauth/token', {
      client_id:     process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
    });
    writeTokens({
      access_token:  data.access_token,
      refresh_token: data.refresh_token,
      expires_at:    data.expires_at,
      athlete_id:    data.athlete?.id,
      athlete_name:  `${data.athlete?.firstname ?? ''} ${data.athlete?.lastname ?? ''}`.trim(),
    });
    res.redirect('/?auth=success');
  } catch (err) {
    console.error('OAuth error:', err.response?.data || err.message);
    res.status(500).send(`<h2>Auth error</h2><pre>${JSON.stringify(err.response?.data || err.message, null, 2)}</pre><a href="/">← Back</a>`);
  }
});

// ─── /api/status ──────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  const t     = readTokens();
  const cache = readActivities();
  res.json({
    authenticated:   !!(t?.access_token || t?.refresh_token),
    totalActivities: cache.activities.length,
    lastSync:        cache.lastSync,
    athlete:         t?.athlete_name || null,
  });
});

// ─── /api/activities ──────────────────────────────────────────────────────────
app.get('/api/activities', (req, res) => {
  res.json(readActivities());
});

// ─── /api/boroughs ────────────────────────────────────────────────────────────
const BOROUGHS_F = path.join(CACHE_DIR, 'boroughs.json');
const PARKS_DIR  = path.join(CACHE_DIR, 'parks');

app.get('/api/boroughs', async (req, res) => {
  if (fs.existsSync(BOROUGHS_F)) {
    return res.sendFile(BOROUGHS_F);
  }
  try {
    const { data } = await axios.get(
      'https://raw.githubusercontent.com/radoi90/housequest-data/master/london_boroughs.geojson',
      { timeout: 10000 }
    );
    fs.writeFileSync(BOROUGHS_F, JSON.stringify(data));
    res.json(data);
  } catch (err) {
    console.error('Failed to fetch borough boundaries:', err.message);
    res.json({ type: 'FeatureCollection', features: [] });
  }
});

// ─── /api/parks ───────────────────────────────────────────────────────────────
// Bounding boxes of OSM parks inside ?bbox=minLat,minLng,maxLat,maxLng
// (defaults to Greater London). Cached per box under cache/parks/.
const LONDON_BBOX = { minLat: 51.28, minLng: -0.51, maxLat: 51.72, maxLng: 0.34 };
const MAX_BBOX_DEG = 1.5;

app.get('/api/parks', async (req, res) => {
  let bbox = LONDON_BBOX;
  if (req.query.bbox) {
    const parts = String(req.query.bbox).split(',').map(Number);
    if (parts.length !== 4 || parts.some(n => !Number.isFinite(n))) {
      return res.status(400).json({ error: 'bbox must be minLat,minLng,maxLat,maxLng' });
    }
    const [minLat, minLng, maxLat, maxLng] = parts;
    if (maxLat <= minLat || maxLng <= minLng || maxLat - minLat > MAX_BBOX_DEG || maxLng - minLng > MAX_BBOX_DEG) {
      return res.status(400).json({ error: `bbox must be non-empty and at most ${MAX_BBOX_DEG}° per side` });
    }
    bbox = { minLat, minLng, maxLat, maxLng };
  }

  const bb   = `${bbox.minLat},${bbox.minLng},${bbox.maxLat},${bbox.maxLng}`;
  const file = path.join(PARKS_DIR, `${bb.replace(/,/g, '_')}.json`);
  if (fs.existsSync(file)) return res.sendFile(file);

  try {
    const query = `[out:json][timeout:30];(way["leisure"="park"](${bb});relation["leisure"="park"](${bb}););out bb;`;
    const { data } = await axios.post(
      'https://overpass-api.de/api/interpreter',
      `data=${encodeURIComponent(query)}`,
      {
        // overpass-api.de answers 406 to generic client User-Agents (e.g. axios/x.y)
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'RunExplorer/1.0 (local Strava visualiser)' },
        timeout: 35000,
      }
    );
    const parks = data.elements
      .filter(e => e.bounds)
      .map(e => ({
        minLat: e.bounds.minlat, maxLat: e.bounds.maxlat,
        minLng: e.bounds.minlon, maxLng: e.bounds.maxlon,
      }));
    fs.mkdirSync(PARKS_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(parks));
    res.json(parks);
  } catch (err) {
    console.error('Failed to fetch parks:', err.message);
    res.status(502).json({ error: `Overpass request failed: ${err.message}` });
  }
});

// ─── /api/route-suggestion ────────────────────────────────────────────────────
// Generates a round-trip running loop via OpenRouteService, seeded at a point.
// Requires ORS_API_KEY in .env (free key: https://openrouteservice.org/dev/#/signup)
app.get('/api/route-suggestion', async (req, res) => {
  const lat      = parseFloat(req.query.lat);
  const lng      = parseFloat(req.query.lng);
  const distance = parseInt(req.query.distance, 10); // metres
  const seed     = parseInt(req.query.seed, 10) || 0;

  if (!process.env.ORS_API_KEY) {
    return res.status(503).json({ error: 'ORS_API_KEY not configured' });
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(distance)) {
    return res.status(400).json({ error: 'lat, lng and distance are required' });
  }

  try {
    const { data } = await axios.post(
      'https://api.openrouteservice.org/v2/directions/foot-walking/geojson',
      {
        coordinates:  [[lng, lat]],
        instructions: false,
        options:      { round_trip: { length: distance, points: 4, seed } },
      },
      {
        headers: { Authorization: process.env.ORS_API_KEY, 'Content-Type': 'application/json' },
        timeout: 20000,
      }
    );
    res.json(data);
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data?.error?.message || err.response?.data?.error || err.message;
    console.error('Route suggestion error:', detail);
    if (status === 401 || status === 403) return res.status(503).json({ error: 'ORS_API_KEY invalid or quota exceeded' });
    res.status(502).json({ error: `Route generation failed: ${detail}` });
  }
});

// ─── /api/activity/:id/stream ─────────────────────────────────────────────────
app.get('/api/activity/:id/stream', async (req, res) => {
  const { id } = req.params;

  const cached = readStream(id);
  if (cached) return res.json(cached);

  try {
    const token      = await getAccessToken();
    const { data }   = await axios.get(
      `https://www.strava.com/api/v3/activities/${id}/streams`,
      {
        params:  { keys: 'latlng,altitude,time,distance', key_by_type: true },
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    writeStream(id, data);
    res.json(data);
  } catch (err) {
    if (err.message === 'NO_AUTH')        return res.status(401).json({ error: 'Not authenticated', redirect: '/auth/strava' });
    if (err.response?.status === 404)    return res.json(null);
    if (err.response?.status === 429)    return res.status(429).json({ error: 'Rate limited — try again shortly' });
    console.error(`Stream error ${id}:`, err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// ─── /api/tracks ──────────────────────────────────────────────────────────────
// All cached full tracks (id → encoded polyline) plus how many GPS activities
// still lack a cached stream.
app.get('/api/tracks', (req, res) => {
  const gps = readActivities().activities.filter(a => a.map?.summary_polyline);
  res.json({
    tracks:  getTracks(),
    total:   gps.length,
    missing: gps.filter(a => !hasStream(a.id)).length,
  });
});

// ─── /api/tracks/backfill ─────────────────────────────────────────────────────
// Fetches streams for up to ?limit GPS activities without a cached one, newest
// first. Stops early when Strava's read budget is nearly spent (or on 429) so
// a normal sync still has headroom; the client calls again for the next batch.
app.post('/api/tracks/backfill', async (req, res) => {
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
  let token;
  try { token = await getAccessToken(); }
  catch { return res.status(401).json({ error: 'Not authenticated', redirect: '/auth/strava' }); }

  const pending = readActivities().activities
    .filter(a => a.map?.summary_polyline && !hasStream(a.id))
    .sort((a, b) => new Date(b.start_date) - new Date(a.start_date));

  let fetched = 0, rateLimitHit = false, error = null;
  for (const a of pending.slice(0, limit)) {
    try {
      const { data, headers } = await axios.get(
        `https://www.strava.com/api/v3/activities/${a.id}/streams`,
        {
          params:  { keys: 'latlng,altitude,time,distance', key_by_type: true },
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      writeStream(a.id, data);
      fetched++;
      if (readBudgetExhausted(headers)) { rateLimitHit = true; break; }
    } catch (err) {
      const status = err.response?.status;
      if (status === 429) { rateLimitHit = true; break; }
      if (status === 404) { writeStream(a.id, {}); continue; } // no streams exist; don't retry forever
      error = err.response?.data?.message || err.message;
      break;
    }
  }

  res.json({
    fetched,
    remaining: pending.filter(a => !hasStream(a.id)).length,
    rateLimitHit,
    error,
  });
});

// ─── /api/sync ────────────────────────────────────────────────────────────────
app.post('/api/sync', async (req, res) => {
  let token;
  try { token = await getAccessToken(); }
  catch { return res.status(401).json({ error: 'Not authenticated', redirect: '/auth/strava' }); }

  const cache      = readActivities();
  const existingIds = new Set(cache.activities.map(a => a.id));

  // Only fetch activities newer than the latest we have
  let after = 0;
  if (cache.activities.length > 0) {
    after = Math.max(...cache.activities.map(a => Math.floor(new Date(a.start_date).getTime() / 1000)));
  }

  const newActivities = [];
  let page = 1;
  let rateLimitHit = false;
  let fetchError = null;

  try {
    while (true) {
      const { data, headers } = await axios.get(
        'https://www.strava.com/api/v3/athlete/activities',
        {
          params:  { after, page, per_page: 100 },
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      if (!data.length) break;
      newActivities.push(...data.filter(a => !existingIds.has(a.id)));
      if (data.length < 100) break;
      page++;

      // Respect daily / 15-min rate limits
      const [used15] = (headers['x-ratelimit-usage'] || '0,0').split(',').map(Number);
      if (used15 >= 90) { rateLimitHit = true; break; }
    }
  } catch (err) {
    if (err.response?.status === 429) rateLimitHit = true;
    else fetchError = err.response?.data?.message || err.message;
  }

  cache.activities = [...cache.activities, ...newActivities];
  cache.lastSync   = new Date().toISOString();
  writeActivities(cache);

  res.json({
    newActivities: newActivities.length,
    total:         cache.activities.length,
    lastSync:      cache.lastSync,
    rateLimitHit,
    error:         fetchError,
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🗺  Run Explorer  →  http://localhost:${PORT}`);
  const t = readTokens();
  if (!t?.refresh_token) {
    console.log(`\n   ⚠️  Not authenticated yet.`);
    console.log(`   Open http://localhost:${PORT}/auth/strava to connect Strava.\n`);
  } else {
    console.log(`   ✓  Strava credentials found — ready to sync.\n`);
  }
});
