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
  console.log(`\n🗺  London Run Explorer  →  http://localhost:${PORT}`);
  const t = readTokens();
  if (!t?.refresh_token) {
    console.log(`\n   ⚠️  Not authenticated yet.`);
    console.log(`   Open http://localhost:${PORT}/auth/strava to connect Strava.\n`);
  } else {
    console.log(`   ✓  Strava credentials found — ready to sync.\n`);
  }
});
