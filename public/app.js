/* ═══════════════════════════════════════════════════════════════════════════
   London Run Explorer — app.js
   ═══════════════════════════════════════════════════════════════════════════ */

// ── Constants ────────────────────────────────────────────────────────────────
const LONDON_CENTER = [51.505, -0.09];
const LONDON_BOUNDS = { minLat: 51.28, maxLat: 51.72, minLng: -0.51, maxLng: 0.34 };
const GRID_SIZE     = 0.01; // ~1 km grid cells

const TYPE_COLOR = {
  Run:        '#3b82f6', // blue
  VirtualRun: '#3b82f6',
  Ride:       '#f97316', // orange
  VirtualRide:'#f97316',
  Walk:       '#22c55e', // green
  Hike:       '#22c55e',
  default:    '#94a3b8', // grey
};

// Brighter variants for dark mode
const TYPE_COLOR_DARK = {
  Run:        '#60a5fa',
  VirtualRun: '#60a5fa',
  Ride:       '#fb923c',
  VirtualRide:'#fb923c',
  Walk:       '#4ade80',
  Hike:       '#4ade80',
  default:    '#94a3b8',
};

const TYPE_ICON = {
  Run: '🏃', VirtualRun: '🏃',
  Ride: '🚴', VirtualRide: '🚴',
  Walk: '🚶', Hike: '🥾',
  default: '●',
};

// ── State ────────────────────────────────────────────────────────────────────
let map;
let tileLayer       = null;
let labelsLayer     = null;
let boroughLayer    = null;
let boroughGeoJSON  = null;   // cached for re-render on theme switch
let allActivities   = [];
let polylineLayers  = {};    // { id: { layer, activity } }
let heatLayer       = null;
let coverageLayer   = null;
let suggestionMarker  = null;
let suggestionPolygon = null;
let suggestionRoute   = null;   // Leaflet polyline of the generated loop
let suggestionCoords  = null;   // [lat, lng] pairs of the loop (for GPX export)
let suggestDistanceKm = +(localStorage.getItem('suggestDistanceKm') || 10);
let boroughCellIndex  = null;   // Map: grid cell key → borough name (built lazily)
let parkCells         = new Set(); // grid keys overlapping OSM parks
let elevChart         = null;
let activeId        = null;
let currentView     = 'routes'; // 'routes' | 'heatmap'
let showUnexplored  = false;
let visitedCells    = new Set(); // "lat_lng" keys
let darkMode        = localStorage.getItem('darkMode') === 'true';

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

  setSuggestDistance(suggestDistanceKm);
  loadBoroughs();
  await loadActivities();
  loadParks(); // fire-and-forget; improves suggestions once resolved
}

// ── Map setup ─────────────────────────────────────────────────────────────────
function initMap() {
  const saved = (() => { try { return JSON.parse(localStorage.getItem('mapView')); } catch { return null; } })();

  map = L.map('map', {
    center: saved?.center ? [saved.center.lat, saved.center.lng] : LONDON_CENTER,
    zoom:   saved?.zoom   ?? 11,
    zoomControl: true,
  });

  // Custom panes: base (200) → boroughs (250) → routes (400, default) → labels (650)
  map.createPane('boroughs');
  map.getPane('boroughs').style.zIndex = 250;
  map.getPane('boroughs').style.pointerEvents = 'none';
  map.createPane('labels');
  map.getPane('labels').style.zIndex = 650;
  map.getPane('labels').style.pointerEvents = 'none';

  tileLayer   = makeTileLayer(darkMode).addTo(map);
  labelsLayer = makeLabelsLayer(darkMode).addTo(map);

  // Apply saved dark mode on load
  applyDarkMode(false);

  // Persist view
  map.on('moveend zoomend', () => {
    localStorage.setItem('mapView', JSON.stringify({ center: map.getCenter(), zoom: map.getZoom() }));
  });

  // Add legend
  const legend = L.control({ position: 'bottomright' });
  legend.onAdd = () => {
    const div = L.DomUtil.create('div', 'map-legend');
    const p = darkMode ? TYPE_COLOR_DARK : TYPE_COLOR;
    div.innerHTML = [
      ['🏃 Run',  p.Run],
      ['🚴 Ride', p.Ride],
      ['🚶 Walk', p.Walk],
      ['◌ Other', p.default],
    ].map(([label, color]) =>
      `<div class="leg-item"><div class="leg-swatch" style="background:${color}"></div>${label}</div>`
    ).join('');
    return div;
  };
  legend.addTo(map);
}

// ── Dark mode ─────────────────────────────────────────────────────────────────
function makeTileLayer(dark) {
  const url = dark
    ? 'https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png'
    : 'https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png';
  return L.tileLayer(url, {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, © <a href="https://carto.com/attributions">CARTO</a>',
    maxZoom: 19,
  });
}

function makeLabelsLayer(dark) {
  const url = dark
    ? 'https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png'
    : 'https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png';
  return L.tileLayer(url, { pane: 'labels', maxZoom: 19, attribution: '' });
}

function applyDarkMode(redraw = true) {
  document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light');
  const btn = document.getElementById('btn-theme');
  if (btn) btn.textContent = darkMode ? '☀️' : '🌙';
  if (redraw) applyFilters();
}

function toggleDarkMode() {
  darkMode = !darkMode;
  localStorage.setItem('darkMode', darkMode);

  if (tileLayer)   { map.removeLayer(tileLayer);   tileLayer   = makeTileLayer(darkMode).addTo(map);   tileLayer.bringToBack(); }
  if (labelsLayer) { map.removeLayer(labelsLayer);  labelsLayer = makeLabelsLayer(darkMode).addTo(map); }
  if (boroughGeoJSON) renderBoroughs(boroughGeoJSON);

  applyDarkMode(true);
}

// ── Borough boundaries ────────────────────────────────────────────────────────
async function loadBoroughs() {
  try {
    const r = await fetch('/api/boroughs');
    boroughGeoJSON = await r.json();
    renderBoroughs(boroughGeoJSON);
  } catch (e) {
    console.warn('Could not load borough boundaries:', e);
  }
}

function renderBoroughs(geojson) {
  if (boroughLayer) map.removeLayer(boroughLayer);

  const lineColor = darkMode ? 'rgba(200,150,255,0.45)' : 'rgba(130,60,200,0.35)';

  boroughLayer = L.geoJSON(geojson, {
    pane: 'boroughs',
    style: {
      color:     lineColor,
      weight:    0.8,
      fill:      false,
      dashArray: '5,5',
    },
    onEachFeature(feature, layer) {
      const name = feature.properties?.name
                || feature.properties?.NAME
                || feature.properties?.lad19nm
                || '';
      if (!name) return;
      layer.bindTooltip(name, {
        permanent:  true,
        direction:  'center',
        className:  'borough-label',
      });
    },
  }).addTo(map);
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
    clearSuggestion();
  }
}

function clearSuggestion() {
  if (suggestionMarker)  { map.removeLayer(suggestionMarker);  suggestionMarker  = null; }
  if (suggestionPolygon) { map.removeLayer(suggestionPolygon); suggestionPolygon = null; }
  if (suggestionRoute)   { map.removeLayer(suggestionRoute);   suggestionRoute   = null; }
  suggestionCoords = null;
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
function setSuggestDistance(km) {
  suggestDistanceKm = km;
  localStorage.setItem('suggestDistanceKm', km);
  document.querySelectorAll('.dist-pill').forEach(b =>
    b.classList.toggle('active', +b.dataset.km === km));
}

async function suggestNextRun() {
  clearSuggestion();

  const btn = document.getElementById('btn-suggest');
  btn.disabled = true;
  btn.textContent = '⏳ Locating…';

  // Try to get current position (5-second timeout, non-blocking fallback)
  let userPos = null;
  try {
    userPos = await new Promise(resolve => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
        () => resolve(null),
        { timeout: 5000, maximumAge: 60000 }
      );
    });
  } catch {}

  try {
    // Restrict the search to boroughs the athlete has barely set foot in
    if (!boroughCellIndex) boroughCellIndex = buildBoroughCellIndex();
    const targetBoroughs = pickTargetBoroughs();

    // Build unvisited cells in inner London, limited to target boroughs
    const innerBounds = { minLat: 51.38, maxLat: 51.62, minLng: -0.35, maxLng: 0.18 };
    const getKey  = (lat, lng) => `${lat.toFixed(4)}_${lng.toFixed(4)}`;
    const unvisited = [];
    const cellSet   = new Set();
    for (let lat = innerBounds.minLat; lat < innerBounds.maxLat; lat = +(lat + GRID_SIZE).toFixed(4)) {
      for (let lng = innerBounds.minLng; lng < innerBounds.maxLng; lng = +(lng + GRID_SIZE).toFixed(4)) {
        const key = getKey(lat, lng);
        if (visitedCells.has(key)) continue;
        if (targetBoroughs && !targetBoroughs.has(boroughCellIndex.get(key))) continue;
        unvisited.push([lat, lng]);
        cellSet.add(key);
      }
    }

    if (!unvisited.length) {
      showToast("You've explored every borough! 🎉", 'success');
      return;
    }

    // A loop of L km reaches roughly L/4 km out from its start, so score each
    // candidate cell by how unexplored its (2r+1)² neighbourhood is, boosted
    // by parks and closeness to the user (or the current map view).
    const radiusCells = Math.max(1, Math.round(suggestDistanceKm / 4));
    const ref = userPos ?? { lat: map.getCenter().lat, lng: map.getCenter().lng };

    let best = null;
    for (const [lat, lng] of unvisited) {
      let local = 0, parks = 0, total = 0;
      for (let dy = -radiusCells; dy <= radiusCells; dy++) {
        for (let dx = -radiusCells; dx <= radiusCells; dx++) {
          const k = getKey(+(lat + dy * GRID_SIZE).toFixed(4), +(lng + dx * GRID_SIZE).toFixed(4));
          total++;
          if (cellSet.has(k))   local++;
          if (parkCells.has(k)) parks++;
        }
      }
      const cLat   = lat + GRID_SIZE / 2;
      const cLng   = lng + GRID_SIZE / 2;
      const distKm = haversineKm(ref.lat, ref.lng, cLat, cLng);
      const score  = (local / total) * (1 + 0.4 * parks / total) / (1 + distKm / 8);
      if (!best || score > best.score) {
        best = { lat, lng, cLat, cLng, local, distKm, parkFrac: parks / total, score };
      }
    }

    const boroughName = boroughCellIndex?.get(getKey(best.lat, best.lng)) ?? null;

    // Convex hull of the unexplored cells around the seed → area to explore
    const corners = [];
    for (let dy = -radiusCells; dy <= radiusCells; dy++) {
      for (let dx = -radiusCells; dx <= radiusCells; dx++) {
        const aLat = +(best.lat + dy * GRID_SIZE).toFixed(4);
        const aLng = +(best.lng + dx * GRID_SIZE).toFixed(4);
        if (!cellSet.has(getKey(aLat, aLng))) continue;
        corners.push([aLat,             aLng            ]);
        corners.push([aLat,             aLng + GRID_SIZE]);
        corners.push([aLat + GRID_SIZE, aLng            ]);
        corners.push([aLat + GRID_SIZE, aLng + GRID_SIZE]);
      }
    }
    const hull = convexHull(corners);

    suggestionPolygon = L.polygon(hull, {
      color:       '#f59e0b',
      fillColor:   '#f59e0b',
      fillOpacity: 0.12,
      weight:      2,
      dashArray:   '8,4',
    }).addTo(map);

    // Ask the server for a real round-trip loop seeded at the cluster centre
    btn.textContent = '⏳ Routing…';
    let routeFeature = null;
    let routeErr     = null;
    try {
      const seed = Math.floor(Math.random() * 100);
      const r    = await fetch(`/api/route-suggestion?lat=${best.cLat}&lng=${best.cLng}&distance=${suggestDistanceKm * 1000}&seed=${seed}`);
      const data = await r.json();
      if (r.ok && data.features?.length) routeFeature = data.features[0];
      else routeErr = data.error || 'No route returned';
    } catch (e) {
      routeErr = e.message;
    }

    const parkNote = best.parkFrac > 0.25 ? '<br>🌳 Includes park areas' : '';
    const distNote = userPos ? `<br>📍 ${best.distKm.toFixed(1)} km from you` : '';
    const inBorough = boroughName ? ` in ${boroughName}` : '';

    let markerPos, popupHtml;
    if (routeFeature) {
      suggestionCoords = routeFeature.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
      suggestionRoute  = L.polyline(suggestionCoords, { color: '#f59e0b', weight: 4, opacity: 0.9 }).addTo(map);
      const actualKm = (routeFeature.properties?.summary?.distance ?? 0) / 1000;
      markerPos = suggestionCoords[0];
      popupHtml = `<div class="suggest-popup">
        <strong>${suggestDistanceKm} km loop${inBorough}</strong><br>
        📏 ${actualKm.toFixed(1)} km actual${parkNote}${distNote}<br><br>
        <button class="gpx-btn" onclick="downloadSuggestionGpx()">⬇ Download GPX</button>
      </div>`;
    } else {
      markerPos = [best.cLat, best.cLng];
      popupHtml = `<div class="suggest-popup">
        <strong>Suggested next run${inBorough}</strong><br>
        ~${best.local} km² unexplored nearby${parkNote}${distNote}<br><br>
        <em>Explore the highlighted area!</em>
      </div>`;
      if (routeErr === 'ORS_API_KEY not configured') {
        showToast('Add ORS_API_KEY to .env to get real loop routes', 'warn');
      } else if (routeErr) {
        showToast(`Loop routing failed: ${routeErr}`, 'warn');
      }
    }

    const icon = L.divIcon({
      className: '',
      html: `<div style="background:#f59e0b;color:#fff;border-radius:50%;width:36px;height:36px;display:flex;align-items:center;justify-content:center;font-size:18px;box-shadow:0 2px 8px rgba(0,0,0,.3)">💡</div>`,
      iconSize:   [36, 36],
      iconAnchor: [18, 18],
    });

    suggestionMarker = L.marker(markerPos, { icon })
      .bindPopup(popupHtml, { maxWidth: 220 })
      .addTo(map)
      .openPopup();

    map.fitBounds((suggestionRoute ?? suggestionPolygon).getBounds(), { padding: [60, 60] });

    if (!showUnexplored) {
      showUnexplored = true;
      document.getElementById('btn-unexplored').classList.add('on');
      document.getElementById('btn-unexplored').textContent = 'Unexplored ✓';
      buildUnexploredLayer();
    }
  } finally {
    btn.disabled = false;
    btn.textContent = '💡 Suggest run';
  }
}

// ── Borough coverage helpers ──────────────────────────────────────────────────
// Map every ~1 km grid cell to the borough containing its centre. Built once
// (33 polygons × a few thousand candidate cells — a few ms).
function buildBoroughCellIndex() {
  if (!boroughGeoJSON?.features?.length) return null;
  const index = new Map();
  for (const f of boroughGeoJSON.features) {
    const name  = f.properties?.name || 'Unknown';
    const polys = f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [f.geometry.coordinates];
    for (const poly of polys) {
      const ring = poly[0]; // outer ring; borough polygons have no holes
      let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
      for (const [lng, lat] of ring) {
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
      }
      const startLat = +(Math.floor(minLat / GRID_SIZE) * GRID_SIZE).toFixed(4);
      const startLng = +(Math.floor(minLng / GRID_SIZE) * GRID_SIZE).toFixed(4);
      for (let lat = startLat; lat <= maxLat; lat = +(lat + GRID_SIZE).toFixed(4)) {
        for (let lng = startLng; lng <= maxLng; lng = +(lng + GRID_SIZE).toFixed(4)) {
          if (pointInRing(lng + GRID_SIZE / 2, lat + GRID_SIZE / 2, ring)) {
            index.set(`${lat.toFixed(4)}_${lng.toFixed(4)}`, name);
          }
        }
      }
    }
  }
  return index;
}

// Boroughs where <5% of cells are visited count as "not been to yet".
// If fewer than 3 qualify, fall back to the 5 least-explored so there is
// always somewhere to suggest. Returns null when boroughs aren't loaded.
function pickTargetBoroughs() {
  if (!boroughCellIndex) return null;
  const cov = new Map(); // name → { total, visited }
  for (const [key, name] of boroughCellIndex) {
    const c = cov.get(name) || { total: 0, visited: 0 };
    c.total++;
    if (visitedCells.has(key)) c.visited++;
    cov.set(name, c);
  }
  const ranked = [...cov.entries()]
    .map(([name, c]) => ({ name, frac: c.visited / c.total }))
    .sort((a, b) => a.frac - b.frac);
  const fresh = ranked.filter(b => b.frac < 0.05);
  return new Set((fresh.length >= 3 ? fresh : ranked.slice(0, 5)).map(b => b.name));
}

// Ray casting; ring is GeoJSON-order [lng, lat] pairs
function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// ── GPX export of the suggested loop ──────────────────────────────────────────
function downloadSuggestionGpx() {
  if (!suggestionCoords) return;
  const pts = suggestionCoords
    .map(([lat, lng]) => `      <trkpt lat="${lat.toFixed(6)}" lon="${lng.toFixed(6)}"></trkpt>`)
    .join('\n');
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="London Run Explorer" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Suggested ${suggestDistanceKm} km loop</name>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>`;
  const blob = new Blob([gpx], { type: 'application/gpx+xml' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = `suggested-run-${suggestDistanceKm}km.gpx`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── Parks + helpers for suggestions ───────────────────────────────────────────
async function loadParks() {
  try {
    const r = await fetch('/api/parks');
    const parks = await r.json();
    // Precompute a Set of all grid cell keys that overlap any park bounding box
    const cells = new Set();
    for (const p of parks) {
      const startLat = +(Math.floor(p.minLat / GRID_SIZE) * GRID_SIZE).toFixed(4);
      const startLng = +(Math.floor(p.minLng / GRID_SIZE) * GRID_SIZE).toFixed(4);
      for (let lat = startLat; lat <= p.maxLat; lat = +(lat + GRID_SIZE).toFixed(4)) {
        for (let lng = startLng; lng <= p.maxLng; lng = +(lng + GRID_SIZE).toFixed(4)) {
          cells.add(`${lat.toFixed(4)}_${lng.toFixed(4)}`);
        }
      }
    }
    parkCells = cells;
  } catch { /* non-critical */ }
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R    = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a    = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Andrew's monotone chain — returns hull as [lat, lng] pairs
function convexHull(points) {
  if (points.length < 3) return points;
  const pts   = points.slice().sort((a, b) => a[1] !== b[1] ? a[1] - b[1] : a[0] - b[0]);
  const cross = (O, A, B) => (A[0]-O[0])*(B[1]-O[1]) - (A[1]-O[1])*(B[0]-O[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length-2], lower[lower.length-1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length-2], upper[upper.length-1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return [...lower, ...upper];
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
  const palette = darkMode ? TYPE_COLOR_DARK : TYPE_COLOR;
  return palette[type] ?? palette.default;
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
