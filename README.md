# Run Explorer 🗺

Visualise all your Strava activities as GPS traces on an interactive map. Spot the gaps, discover new areas, and plan your next run — wherever you are.

---

## Features

- **Interactive map** — every run/ride/walk drawn as a coloured polyline over [Stadia Maps](https://stadiamaps.com/) tiles (free, no API key needed when running on localhost)
- **Opens where you are** — the map zooms to your most recent GPS activity on load
- **Full tracks** — Strava trims your privacy zones out of every route it hands out (the first and last few hundred metres). One click fetches the complete GPS stream for each activity so your runs are drawn in full
- **Heatmap mode** — density view of where you run most
- **Unexplored areas** — red overlay showing the ~1 km grid cells in view that you haven't covered yet (zoom in to level 9 or closer)
- **Suggest next run** — generates a real 5/10/15 km loop route in an unexplored area within 15 km of you (or the map centre), with GPX download; inside London it targets a borough you haven't explored yet
- **London borough boundaries** — dashed outlines and labels for all 33 London boroughs (visible whenever you pan over London)
- **Dark mode** — 🌙 toggle switches the map tiles and UI theme
- **Elevation profile** — chart shown when you click any activity
- **Incremental sync** — only fetches new activities since last sync, respects Strava rate limits
- **Fully local cache** — all data stored in `cache/`; works offline once synced
- **Filter by type & date** — Run / Ride / Walk / Hike / Other, plus a date-range dropdown (last 30 days → all time)

---

## Setup

### 1. Create a Strava API app

1. Go to [https://www.strava.com/settings/api](https://www.strava.com/settings/api)
2. Fill in:
   - **Application Name**: Run Explorer (or anything)
   - **Category**: Visualisation
   - **Website**: `http://localhost:3000`
   - **Authorization Callback Domain**: `localhost`
3. Save. Note your **Client ID** and **Client Secret**.

### 2. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env`:

```
STRAVA_CLIENT_ID=12345
STRAVA_CLIENT_SECRET=your_secret_here
STRAVA_REFRESH_TOKEN=          # leave blank for now
PORT=3000
ORS_API_KEY=                   # optional — see "Loop route suggestions" below
```

**Loop route suggestions (optional):** to get real turn-by-turn 5/10/15 km loop routes from the 💡 Suggest button, grab a free API key from [openrouteservice.org](https://openrouteservice.org/dev/#/signup) (2,000 requests/day on the free tier) and put it in `ORS_API_KEY`. Without a key, the suggest button still works but only highlights an area to explore instead of drawing a route.

### 3. Install dependencies

```bash
npm install
```

### 4. Start the server

```bash
npm start
```

### 5. First-time OAuth login

Open your browser and visit:

```
http://localhost:3000/auth/strava
```

You'll be redirected to Strava to authorise the app. After approval, you'll be sent back to the map. The app saves your tokens in `tokens.json` automatically — you never need to do this again.

### 6. Sync your runs

Click **"↻ Sync new runs"** in the sidebar. The first sync fetches all your activities (may take a moment if you have many). Subsequent syncs only fetch new ones.

---

## Usage

| Button | What it does |
|---|---|
| **↻ Sync new runs** | Pull new activities from Strava since last sync |
| **⬇ Fetch full tracks** | Download the complete GPS stream for every activity that doesn't have one yet, so routes aren't cut short at your privacy zones. One API request per activity; stops at Strava's rate limit and continues when you click again. Hidden once everything is fetched |
| **All routes** | Show each activity as a coloured polyline |
| **Heatmap** | Density heatmap of all GPS points |
| **Unexplored** | Red overlay = ~1 km cells in the current view you haven't visited (zoom in to level 9+) |
| **💡 Suggest run** | Generates a loop route (length set by the 5/10/15 km pills) in an unexplored area near you; in London it picks a borough you've barely visited. Popup offers a GPX download |
| **Loop length pills** | Choose 5, 10 or 15 km for the suggested loop |
| **🌙 Dark mode** | Toggle between light and dark map tiles + UI theme |

**Filters** — check/uncheck activity types, or pick a date range, to narrow which routes are shown.

**Click a route** on the map or in the sidebar list to highlight it and see its elevation profile.

**Location** — Suggest run asks the browser for your position so it can search near you. If you decline (or it times out), the centre of the current map view is used instead.

---

## Project structure

```
StravaMap/
├── .env                     # secrets — never committed
├── .env.example             # template
├── .gitignore
├── package.json
├── server.js                # Express backend
├── tokens.json              # OAuth tokens (auto-created, never committed)
├── cache/
│   ├── activities.json      # all activities metadata
│   ├── boroughs.json        # London borough boundaries GeoJSON (auto-downloaded)
│   ├── parks/               # OSM park bounding boxes per search area (auto-downloaded)
│   ├── tracks.json          # simplified full routes built from streams/ (auto-generated)
│   └── streams/             # per-activity GPS streams (fetched on demand)
└── public/
    ├── index.html
    ├── app.js               # Leaflet map + all frontend logic
    └── style.css
```

---

## Ongoing use

- The app **only fetches new activities** each time you sync — it respects Strava's rate limits (100 req/15 min, 1000/day).
- GPS streams are fetched when you click an activity (for the elevation chart) or in bulk via **Fetch full tracks**, and cached so they're never fetched twice. The read limit is 100 requests per 15 minutes, so a few hundred activities take a few rounds.
- **Why routes were cut short:** Strava applies your privacy zones to the summary polyline in every API response, even for you as the owner. Your own activity streams are not trimmed, which is what Fetch full tracks uses. Nothing leaves your machine; everything is cached in `cache/`.
- If you get a rate-limit warning, wait 15 minutes and sync again.
- Park data for run suggestions comes from OpenStreetMap via the Overpass API, fetched once per search area and cached in `cache/parks/`. If Overpass is busy, the suggestion still works, just without the park bias; try again later to pick it up.

---

## Colour coding

| Colour | Type |
|---|---|
| 🔵 Blue | Run |
| 🟠 Orange | Ride |
| 🟢 Green | Walk / Hike |
| ⚫ Grey | Everything else |
