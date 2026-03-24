# London Run Explorer 🗺

Visualise all your Strava activities as GPS traces on an interactive London map. Spot the gaps, discover new areas, and plan your next run.

---

## Features

- **Interactive map** — every run/ride/walk drawn as a coloured polyline on OpenStreetMap
- **Heatmap mode** — density view of where you run most
- **Unexplored areas** — red overlay showing parts of London you haven't covered yet
- **Suggest next run** — finds the largest unexplored cluster and pins a starting point
- **Elevation profile** — chart shown when you click any activity
- **Incremental sync** — only fetches new activities since last sync, respects Strava rate limits
- **Fully local cache** — all data stored in `cache/`; works offline once synced
- **Filter by type & date** — Run / Ride / Walk / Hike / Other, plus date-range picker

---

## Setup

### 1. Create a Strava API app

1. Go to [https://www.strava.com/settings/api](https://www.strava.com/settings/api)
2. Fill in:
   - **Application Name**: London Run Explorer (or anything)
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
```

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
| **All routes** | Show each activity as a coloured polyline |
| **Heatmap** | Density heatmap of all GPS points |
| **Unexplored** | Red overlay = areas within London you haven't visited |
| **💡 Suggest run** | Pins a starting point at the largest unexplored cluster |

**Filters** — check/uncheck activity types, or pick a date range, to narrow which routes are shown.

**Click a route** on the map or in the sidebar list to highlight it and see its elevation profile.

---

## Project structure

```
london-run-explorer/
├── .env                     # secrets — never committed
├── .env.example             # template
├── .gitignore
├── package.json
├── server.js                # Express backend
├── tokens.json              # OAuth tokens (auto-created, never committed)
├── cache/
│   ├── activities.json      # all activities metadata
│   └── streams/             # per-activity GPS streams (fetched on demand)
└── public/
    ├── index.html
    ├── app.js               # Leaflet map + all frontend logic
    └── style.css
```

---

## Ongoing use

- The app **only fetches new activities** each time you sync — it respects Strava's rate limits (100 req/15 min, 1000/day).
- GPS streams are fetched lazily — only when you click an activity for the elevation chart — and cached so they're never fetched twice.
- If you get a rate-limit warning, wait 15 minutes and sync again.

---

## Colour coding

| Colour | Type |
|---|---|
| 🔵 Blue | Run |
| 🟠 Orange | Ride |
| 🟢 Green | Walk / Hike |
| ⚫ Grey | Everything else |
