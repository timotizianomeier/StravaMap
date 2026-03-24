/* ═══════════════════════════════════════════════════════════════════════════
   London Run Explorer — app.js
   ═══════════════════════════════════════════════════════════════════════════ */

// ── Constants ────────────────────────────────────────────────────────────────
const LONDON_CENTER = [51.505, -0.09];
const LONDON_BOUNDS = { minLat: 51.28, maxLat: 51.72, minLng: -0.51, maxLng: 0.34 };
const GRID_SIZE     = 0.01; // ~1 km grid cells

const TYPE_COLOR = {
  Run:     '#2563eb', // blue
  VirtualRun: '#2563eb',
  Ride:    '#f97316', // orange
  VirtualRide:'#f97316',
  Walk:    '#16a34a', // green
  Hike:    '#16a34a',
  default: '#9ca3af', // grey
};

const TYPE_ICON = {
  Run: '🏃', VirtualRun: '🏃',
  Ride: '🚴', VirtualRide: '🚴',
  Walk: '🚶', Hike: '🥾',
  default: '●',
};

// ── State ────────────────────────────────────────────────────────────────────
let map;
let allActivities   = [];
let polylineLayers  = {};    // { id: { layer, activity } }
let heatLayer       = null;
let coverageLayer   = null;
let suggestionMarker = null;
let elevChart       = null;
let activeId        = null;
let currentView     = 'routes'; // 'routes' | 'heatmap'
let showUnexplored  = false;
let visitedCells    = new Set(); // "lat_lng" keys

// ── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);

async function init() {
  initMap();

  // Show auth success toast
  if (new URLSearchParams(location.search).get('auth') === 'success') {
    history.replaceState({}, '', '/');
    showToast('Connected to Strava!', 'success');
  }

  const status = await fetchStatus();
  if (!status.authenticated) {
    document.getElementById('auth-banner').classList.remove('hidden');
  }

  await loadActivities();
}

// ── Map setup ─────────────────────────────────────────────────────────────────
function initMap() {
  const saved = (() => { try { return JSON.parse(localStorage.getItem('mapView')); } catch { return null; } })();

  map = L.map('map', {
    center: saved?.center ? [saved.center.lat, saved.center.lng] : LONDON_CENTER,
    zoom:   saved?.zoom   ?? 11,
    zoomControl: true,
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  }).addTo(map);

  // Persist view
  map.on('moveend zoomend', () => {
    localStorage.setItem('mapView', JSON.stringify({ center: map.getCenter(), zoom: map.getZoom() }));
  });

  // Add legend
  const legend = L.control({ position: 'bottomright' });
  legend.onAdd = () => {
    const div = L.DomUtil.create('div', 'map-legend');
    div.innerHTML = [
      ['🏃 Run',  TYPE_COLOR.Run],
      ['🚴 Ride', TYPE_COLOR.Ride],
      ['🚶 Walk', TYPE_COLOR.Walk],
      ['◌ Other', TYPE_COLOR.default],
    ].map(([label, color]) =>
      `<div class="leg-item"><div class="leg-swatch" style="background:${color}"></div>${label}</div>`
    ).join('');
    return div;
  };
  legend.addTo(map);
}

// ── Data loading ──────────────────────────────────────────────────────────────
async function fetchStatus() {
  try {
    const r = await fetch('/api/status');
    const d = await r.json();
    if (d.athlete) document.getElementById('athlete-name').textContent = d.athlete;
    updateSyncTime(d.lastSync);
    return d;
  } catch { return {}; }
}

async function loadActivities() {
  try {
    const r    = await fetch('/api/activities');
    const data = await r.json();
    allActivities = data.activities || [];
    updateSyncTime(data.lastSync);
  } catch (err) {
    showBanner('error', 'Failed to load activities from cache.');
    return;
  }

  renderList();
  applyFilters();       // draws polylines + stats
  computeCoverage();
}

// ── Rendering ─────────────────────────────────────────────────────────────────
function applyFilters() {
  const types     = [...document.querySelectorAll('.type-filter:checked')].map(c => c.value);
  const daysValue = document.getElementById('date-filter').value;
  const cutoff    = daysValue === 'all' ? null : Date.now() - parseInt(daysValue) * 86400000;

  const filtered = allActivities.filter(a => {
    const matchType = types.some(t => {
      if (t === 'Other') return !['Run','VirtualRun','Ride','VirtualRide','Walk','Hike'].includes(a.type);
      return a.type === t || a.type === 'Virtual' + t;
    });
    const matchDate = !cutoff || new Date(a.start_date).getTime() >= cutoff;
    return matchType && matchDate;
  });

  drawPolylines(filtered);
  updateStats(filtered);
  renderList(filtered);
}

function drawPolylines(activities) {
  // Remove existing polyline layers
  Object.values(polylineLayers).forEach(({ layer }) => map.removeLayer(layer));
  polylineLayers = {};

  if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; }

  const activitiesWithGPS = activities.filter(a => a.map?.summary_polyline);

  if (currentView === 'heatmap') {
    drawHeatmap(activitiesWithGPS);
  } else {
    activitiesWithGPS.forEach(a => addPolyline(a));
  }
}

function addPolyline(activity) {
  const coords = decodePolyline(activity.map.summary_polyline);
  if (!coords.length) return;

  const color = getColor(activity.type);
  const layer = L.polyline(coords, {
    color,
    weight:  3,
    opacity: 0.7,
    bubblingMouseEvents: false,
  });

  layer.bindTooltip(
    `<strong>${escHtml(activity.name)}</strong><br>
     ${fmtDate(activity.start_date)} · ${fmtDist(activity.distance)}`,
    { sticky: true, className: 'run-tooltip' }
  );

  layer.on('click', () => selectActivity(activity.id));
  layer.on('mouseover', function () {
    if (activeId !== activity.id) this.setStyle({ weight: 5, opacity: 1 });
  });
  layer.on('mouseout', function () {
    if (activeId !== activity.id) this.setStyle({ weight: 3, opacity: 0.7 });
  });

  layer.addTo(map);
  polylineLayers[activity.id] = { layer, activity };
}

function drawHeatmap(activities) {
  const points = [];
  activities.forEach(a => {
    if (!a.map?.summary_polyline) return;
    const coords = decodePolyline(a.map.summary_polyline);
    // Sample every 3rd point for performance
    for (let i = 0; i < coords.length; i += 3) {
      points.push([coords[i][0], coords[i][1], 0.5]);
    }
  });
  if (points.length === 0) return;
  heatLayer = L.heatLayer(points, { radius: 12, blur: 15, maxZoom: 17, gradient: { 0.4:'blue', 0.65:'lime', 1:'red' } });
  heatLayer.addTo(map);
}

// ── Activity selection ────────────────────────────────────────────────────────
async function selectActivity(id) {
  // Deselect previous
  if (activeId && polylineLayers[activeId]) {
    polylineLayers[activeId].layer.setStyle({ weight: 3, opacity: 0.7 });
  }

  activeId = id;
  document.querySelectorAll('.activity-item').forEach(el => el.classList.remove('active'));
  const listItem = document.querySelector(`[data-id="${id}"]`);
  if (listItem) {
    listItem.classList.add('active');
    listItem.scrollIntoView({ block: 'nearest' });
  }

  const pl = polylineLayers[id];
  if (pl) {
    pl.layer.setStyle({ weight: 5, opacity: 1 });
    map.fitBounds(pl.layer.getBounds(), { padding: [40, 40] });
  }

  // Fetch full stream for elevation
  await loadElevation(id);
}

function deselectActivity() {
  if (activeId && polylineLayers[activeId]) {
    polylineLayers[activeId].layer.setStyle({ weight: 3, opacity: 0.7 });
  }
  activeId = null;
  document.querySelectorAll('.activity-item').forEach(el => el.classList.remove('active'));
  document.getElementById('elevation-panel').classList.add('hidden');
  if (elevChart) { elevChart.destroy(); elevChart = null; }
}

async function loadElevation(id) {
  const panel = document.getElementById('elevation-panel');
  const title = document.getElementById('elevation-title');
  const activity = allActivities.find(a => a.id === id);
  if (activity) title.textContent = escHtml(activity.name);

  try {
    const r    = await fetch(`/api/activity/${id}/stream`);
    const data = await r.json();

    if (!data?.altitude?.data?.length) {
      panel.classList.add('hidden');
      return;
    }

    const altitudes = data.altitude.data;
    const distances = data.distance?.data ?? altitudes.map((_, i) => i);

    panel.classList.remove('hidden');

    if (elevChart) elevChart.destroy();
    elevChart = new Chart(document.getElementById('elevation-chart'), {
      type: 'line',
      data: {
        labels: distances.map(d => `${(d / 1000).toFixed(1)}km`),
        datasets: [{
          data: altitudes,
          borderColor: '#2563eb',
          backgroundColor: 'rgba(37,99,235,0.15)',
          borderWidth: 1.5,
          pointRadius: 0,
          fill: true,
          tension: 0.3,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: {
          callbacks: { label: ctx => `${ctx.parsed.y.toFixed(0)} m`, title: items => items[0].label }
        }},
        scales: {
          x: { display: false },
          y: { ticks: { font: { size: 10 }, maxTicksLimit: 4 }, grid: { color: '#f3f4f6' } },
        },
      },
    });
  } catch {
    panel.classList.add('hidden');
  }
}

// ── View toggles ──────────────────────────────────────────────────────────────
function setView(view) {
  currentView = view;
  document.getElementById('btn-routes').classList.toggle('active',  view === 'routes');
  document.getElementById('btn-heatmap').classList.toggle('active', view === 'heatmap');
  applyFilters();
}

function toggleUnexplored() {
  showUnexplored = !showUnexplored;
  const btn = document.getElementById('btn-unexplored');
  btn.classList.toggle('on', showUnexplored);
  btn.textContent = showUnexplored ? 'Unexplored ✓' : 'Unexplored';

  if (showUnexplored) {
    buildUnexploredLayer();
  } else {
    if (coverageLayer) { coverageLayer.remove(); coverageLayer = null; }
    if (suggestionMarker) { map.removeLayer(suggestionMarker); suggestionMarker = null; }
  }
}

// ── Coverage grid & unexplored overlay ───────────────────────────────────────
function computeCoverage() {
  visitedCells.clear();

  for (const a of allActivities) {
    if (!a.map?.summary_polyline) continue;
    const coords = decodePolyline(a.map.summary_polyline);
    for (const [lat, lng] of coords) {
      // Snap to grid cell (SW corner)
      const cellLat = Math.floor(lat / GRID_SIZE) * GRID_SIZE;
      const cellLng = Math.floor(lng / GRID_SIZE) * GRID_SIZE;
      visitedCells.add(`${cellLat.toFixed(4)}_${cellLng.toFixed(4)}`);
    }
  }

  // Update "areas covered" stat
  document.getElementById('stat-areas').textContent = visitedCells.size;
}

function buildUnexploredLayer() {
  if (coverageLayer) { coverageLayer.remove(); coverageLayer = null; }

  // Collect all unvisited cells within London bounds
  const unvisited = [];
  for (let lat = LONDON_BOUNDS.minLat; lat < LONDON_BOUNDS.maxLat; lat = +(lat + GRID_SIZE).toFixed(4)) {
    for (let lng = LONDON_BOUNDS.minLng; lng < LONDON_BOUNDS.maxLng; lng = +(lng + GRID_SIZE).toFixed(4)) {
      const key = `${lat.toFixed(4)}_${lng.toFixed(4)}`;
      if (!visitedCells.has(key)) unvisited.push([lat, lng]);
    }
  }

  coverageLayer = new CanvasCoverageLayer(unvisited);
  coverageLayer.addTo(map);
}

// ── Canvas coverage layer ─────────────────────────────────────────────────────
class CanvasCoverageLayer {
  constructor(cells) {
    this._cells  = cells;
    this._canvas = null;
    this._map    = null;
    this._onMove = () => this._render();
  }

  addTo(map) {
    this._map    = map;
    this._canvas = document.createElement('canvas');
    Object.assign(this._canvas.style, {
      position: 'absolute', top: '0', left: '0',
      pointerEvents: 'none', zIndex: '450',
    });
    map.getContainer().appendChild(this._canvas);
    map.on('move zoom resize', this._onMove);
    this._render();
    return this;
  }

  remove() {
    this._map?.off('move zoom resize', this._onMove);
    this._canvas?.remove();
    this._canvas = null;
    return this;
  }

  _render() {
    if (!this._map || !this._canvas) return;
    const c   = this._map.getContainer();
    this._canvas.width  = c.offsetWidth;
    this._canvas.height = c.offsetHeight;
    const ctx = this._canvas.getContext('2d');
    ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
    ctx.fillStyle = 'rgba(239,68,68,0.18)';

    const gs = GRID_SIZE;
    for (const [lat, lng] of this._cells) {
      const sw = this._map.latLngToContainerPoint([lat, lng]);
      const ne = this._map.latLngToContainerPoint([lat + gs, lng + gs]);
      const x  = Math.min(sw.x, ne.x);
      const y  = Math.min(sw.y, ne.y);
      const w  = Math.abs(ne.x - sw.x) + 1;
      const h  = Math.abs(ne.y - sw.y) + 1;
      if (w > 0.5 && h > 0.5) ctx.fillRect(x, y, w, h);
    }
  }
}

// ── Suggest next run ──────────────────────────────────────────────────────────
function suggestNextRun() {
  if (suggestionMarker) { map.removeLayer(suggestionMarker); suggestionMarker = null; }

  // Build unvisited cells within a tighter "inner London" area
  const innerBounds = { minLat: 51.38, maxLat: 51.62, minLng: -0.35, maxLng: 0.18 };
  const unvisited   = [];
  for (let lat = innerBounds.minLat; lat < innerBounds.maxLat; lat = +(lat + GRID_SIZE).toFixed(4)) {
    for (let lng = innerBounds.minLng; lng < innerBounds.maxLng; lng = +(lng + GRID_SIZE).toFixed(4)) {
      const key = `${lat.toFixed(4)}_${lng.toFixed(4)}`;
      if (!visitedCells.has(key)) unvisited.push([lat, lng]);
    }
  }

  if (!unvisited.length) {
    showToast("You've explored all of inner London! 🎉", 'success');
    return;
  }

  // Find largest cluster via BFS
  const cellSet   = new Set(unvisited.map(([lat, lng]) => `${lat.toFixed(4)}_${lng.toFixed(4)}`));
  const visited   = new Set();
  let bestCluster = [];

  const getKey = (lat, lng) => `${lat.toFixed(4)}_${lng.toFixed(4)}`;

  for (const [startLat, startLng] of unvisited) {
    const sk = getKey(startLat, startLng);
    if (visited.has(sk)) continue;

    const cluster = [];
    const queue   = [[startLat, startLng]];
    visited.add(sk);

    while (queue.length) {
      const [lat, lng] = queue.shift();
      cluster.push([lat, lng]);

      for (const [dlat, dlng] of [[GRID_SIZE,0],[-GRID_SIZE,0],[0,GRID_SIZE],[0,-GRID_SIZE]]) {
        const nLat = +(lat + dlat).toFixed(4);
        const nLng = +(lng + dlng).toFixed(4);
        const nk   = getKey(nLat, nLng);
        if (cellSet.has(nk) && !visited.has(nk)) {
          visited.add(nk);
          queue.push([nLat, nLng]);
        }
      }
    }
    if (cluster.length > bestCluster.length) bestCluster = cluster;
  }

  // Center of the best cluster
  const avgLat = bestCluster.reduce((s, [lat]) => s + lat, 0) / bestCluster.length;
  const avgLng = bestCluster.reduce((s, [, lng]) => s + lng, 0) / bestCluster.length;

  const icon = L.divIcon({
    className: '',
    html: `<div style="background:#f59e0b;color:#fff;border-radius:50%;width:36px;height:36px;display:flex;align-items:center;justify-content:center;font-size:18px;box-shadow:0 2px 8px rgba(0,0,0,.3)">💡</div>`,
    iconSize:   [36, 36],
    iconAnchor: [18, 18],
  });

  suggestionMarker = L.marker([avgLat, avgLng], { icon })
    .bindPopup(
      `<div class="suggest-popup">
        <strong>Suggested next run</strong>
        Unexplored area: ~${bestCluster.length} grid cells (≈${(bestCluster.length).toFixed(0)} km²) not yet covered.<br><br>
        <em>Start here and explore!</em>
      </div>`,
      { maxWidth: 200 }
    )
    .addTo(map)
    .openPopup();

  map.setView([avgLat, avgLng], 14);

  if (!showUnexplored) {
    showUnexplored = true;
    document.getElementById('btn-unexplored').classList.add('on');
    document.getElementById('btn-unexplored').textContent = 'Unexplored ✓';
    buildUnexploredLayer();
  }
}

// ── Activity list rendering ───────────────────────────────────────────────────
function renderList(activities) {
  const search    = document.getElementById('search').value.toLowerCase();
  const source    = activities ?? getFilteredByUI();
  const displayed = search ? source.filter(a => a.name.toLowerCase().includes(search)) : source;

  const ul = document.getElementById('activity-list');

  if (!displayed.length) {
    ul.innerHTML = `<li class="empty-state">${
      allActivities.length === 0
        ? 'No activities yet.<br><a href="#" onclick="syncRuns()">Sync from Strava →</a>'
        : 'No activities match the current filters.'
    }</li>`;
    return;
  }

  ul.innerHTML = displayed.slice().sort((a, b) =>
    new Date(b.start_date) - new Date(a.start_date)
  ).map(a => `
    <li class="activity-item${a.id === activeId ? ' active' : ''}" data-id="${a.id}" onclick="selectActivity(${a.id})">
      <span class="activity-icon">${getIcon(a.type)}</span>
      <div class="activity-info">
        <div class="activity-name">${escHtml(a.name)}</div>
        <div class="activity-meta">${fmtDate(a.start_date)}</div>
      </div>
      <span class="activity-dist">${fmtDist(a.distance)}</span>
    </li>
  `).join('');
}

function getFilteredByUI() {
  const types  = [...document.querySelectorAll('.type-filter:checked')].map(c => c.value);
  const days   = document.getElementById('date-filter').value;
  const cutoff = days === 'all' ? null : Date.now() - parseInt(days) * 86400000;
  return allActivities.filter(a => {
    const matchType = types.some(t => {
      if (t === 'Other') return !['Run','VirtualRun','Ride','VirtualRide','Walk','Hike'].includes(a.type);
      return a.type === t || a.type === 'Virtual' + t;
    });
    const matchDate = !cutoff || new Date(a.start_date).getTime() >= cutoff;
    return matchType && matchDate;
  });
}

// ── Stats ─────────────────────────────────────────────────────────────────────
function updateStats(activities) {
  const source = activities ?? allActivities;
  const runs   = source.filter(a => a.type === 'Run' || a.type === 'VirtualRun').length;
  const kmTotal = source.reduce((s, a) => s + (a.distance || 0), 0) / 1000;

  document.getElementById('stat-runs').textContent = source.length;
  document.getElementById('stat-km').textContent   = kmTotal.toFixed(0);
  // stat-areas is set in computeCoverage()
}

// ── Sync ──────────────────────────────────────────────────────────────────────
async function syncRuns() {
  const btn = document.getElementById('btn-sync');
  btn.disabled = true;
  btn.classList.add('syncing');

  document.getElementById('rate-banner').classList.add('hidden');
  document.getElementById('error-banner').classList.add('hidden');

  try {
    const r    = await fetch('/api/sync', { method: 'POST' });
    const data = await r.json();

    if (r.status === 401) {
      window.location.href = '/auth/strava';
      return;
    }

    if (data.rateLimitHit) {
      document.getElementById('rate-banner').classList.remove('hidden');
    }

    if (data.error) {
      showBanner('error', `Sync error: ${data.error}`);
    } else {
      showToast(data.newActivities > 0
        ? `Synced ${data.newActivities} new activit${data.newActivities === 1 ? 'y' : 'ies'}!`
        : 'Already up to date.', 'success');
    }

    updateSyncTime(data.lastSync);
    await loadActivities();
  } catch (err) {
    showBanner('error', 'Could not reach the server — check your connection.');
  } finally {
    btn.disabled = false;
    btn.classList.remove('syncing');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function updateSyncTime(iso) {
  const el = document.getElementById('last-sync');
  if (!iso) { el.textContent = 'Never synced'; return; }
  const d = new Date(iso);
  el.textContent = `Last sync: ${d.toLocaleString()}`;
}

function getColor(type) {
  return TYPE_COLOR[type] ?? TYPE_COLOR.default;
}

function getIcon(type) {
  return TYPE_ICON[type] ?? TYPE_ICON.default;
}

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtDist(m) {
  if (!m) return '—';
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showBanner(type, msg) {
  const el = document.getElementById('error-banner');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function showToast(msg, _type) {
  const t = document.createElement('div');
  Object.assign(t.style, {
    position: 'fixed', bottom: '20px', right: '20px', zIndex: '99999',
    background: '#1f2937', color: '#fff',
    padding: '10px 16px', borderRadius: '8px', fontSize: '13px',
    boxShadow: '0 4px 12px rgba(0,0,0,.3)', transition: 'opacity .3s',
  });
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 3000);
}

// ── Filter change handlers ────────────────────────────────────────────────────
document.querySelectorAll('.type-filter').forEach(cb => cb.addEventListener('change', applyFilters));
document.getElementById('date-filter').addEventListener('change', applyFilters);

// ── Google encoded polyline decoder ──────────────────────────────────────────
function decodePolyline(encoded) {
  const poly = [];
  let idx = 0, lat = 0, lng = 0;
  while (idx < encoded.length) {
    let shift = 0, result = 0, b;
    do { b = encoded.charCodeAt(idx++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = result = 0;
    do { b = encoded.charCodeAt(idx++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    poly.push([lat / 1e5, lng / 1e5]);
  }
  return poly;
}
