# Public Transport Game

Mobile-first web interface + Google Sheets game backend for a real-life public-transport / Ticket-to-Ride-style game.

The repository is designed so that:

- **players only need the GitHub Pages website**;
- **organizers manage the game in Google Sheets**;
- the **bus network is generated locally** from the selected line endpoints in `bus_lines_new.tsv`;
- the public web app loads static network geometry from GitHub Pages and polls a **read-only Google Apps Script API** for live game state;
- polling updates data **in place** and does not reset the current tab, map position, zoom level, selected line/stop/puzzle, or list scroll position.

The web UI is **Dutch by default** and has an `NL | EN` language switch. Content coming from the game data itself (team names, task descriptions, bus-line names, route cities, etc.) is shown exactly as entered and is not translated automatically.

---

## Repository layout

```text
.
├── README.md
├── index.html
├── bus_lines_new.tsv
├── .gitignore
├── .nojekyll
│
├── data/
│   └── .gitkeep
│
├── scripts/
│   └── build_network_from_geojson_endpoints_web_edges.py
│
└── google-sheets/
    ├── PublicTransportGame_Template.xlsx
    ├── PublicTransportGame_WebAPI.gs
    └── ControlPanel.html
```

After generating the network, `data/` will additionally contain files such as:

```text
data/
├── web_network.geojson       # commit this for GitHub Pages
├── game_edges.geojson        # commit this for GitHub Pages
├── stops.csv                 # upload to the Google Sheet
├── line_stops.csv            # upload to the Google Sheet
├── bus_network.geojson       # full authoritative network
├── stop_merge_report.csv     # merge audit log
└── raw/                      # downloaded source GeoJSON cache
```

The `.gitignore` intentionally ignores the raw/cache and spreadsheet-only generated files, while leaving `web_network.geojson` and `game_edges.geojson` trackable.

---

# Architecture

```text
                    ┌─────────────────────────────┐
                    │         Google Sheet         │
                    │                             │
                    │ Config / Teams              │
                    │ Stop Deposits                │
                    │ Tasks / Puzzles             │
                    │ Route Bonuses               │
                    │ Scoreboard                  │
                    └──────────────┬──────────────┘
                                   │
                          Apps Script Web API
                          read-only public state
                                   │
                                   ▼
┌──────────────────────┐   periodic polling   ┌──────────────────────────┐
│     GitHub Pages     │ ◄─────────────────── │      Player browser       │
│                      │                      │                          │
│ index.html           │ ───────────────────► │ Leaflet mobile web app   │
│ web_network.geojson  │   static files once  │                          │
│ game_edges.geojson   │                      └──────────────────────────┘
└──────────────────────┘
```

The large/static network geometry is served by GitHub Pages. Google Apps Script only serves the small changing game state.

---

# 1. Generate the network

## Requirements

- Python 3
- Internet access while downloading the line endpoints

The builder uses **only the Python standard library**; there is no `pip install` step.

The selected lines are defined in:

```text
bus_lines_new.tsv
```

It is a headerless four-column TSV:

```text
agency_id    line_ref    line_name    geojson_url
```

## Generate

From the repository root, run:

```bash
python scripts/build_network_from_geojson_endpoints_web_edges.py \
  --lines bus_lines_new.tsv \
  --output-dir data \
  --max-stop-distance 100 \
  --stop-merge-distance 50 \
  --web-simplify-distance 5
```

These are the settings used for the current game network.

The first run downloads the source GeoJSON files to `data/raw/`. Later runs reuse that cache. To force the source data to be downloaded again, add:

```bash
--refresh
```

## Generated outputs

### `data/stops.csv`

One row per final merged game stop. This is uploaded to the Google Sheet.

### `data/line_stops.csv`

Ordered stop sequences for every route variant. This is uploaded to the Google Sheet and is the authoritative source for graph connectivity/scoring.

### `data/bus_network.geojson`

Full canonical combined network with detailed source metadata. Useful for debugging/auditing, but not needed by the mobile frontend.

### `data/stop_merge_report.csv`

Audit report for exact-name and distance-based stop merging.

### `data/web_network.geojson`

Compact frontend network containing:

- simplified route geometry;
- exact merged stop coordinates;
- frontend-relevant line/stop metadata.

This file is loaded once by the player app.

### `data/game_edges.geojson`

One feature per undirected adjacency in the game graph. Each edge contains its two endpoint stop IDs and representative real route geometry.

When two adjacent stops are owned by the same team, the web app colors that edge with the team's color.

The edges are derived from the **same inferred stop sequences as `line_stops.csv`**, so the web map and spreadsheet Line-point scoring use the same graph.

## Commit the two web files

After generation, make sure these two generated files are added to Git:

```bash
git add data/web_network.geojson data/game_edges.geojson
```

The other generated network files are intentionally ignored by the provided `.gitignore` because they can always be regenerated and are not needed by GitHub Pages.

---

# 2. Create the Google Sheet backend

The repository contains a fresh empty spreadsheet template:

```text
google-sheets/PublicTransportGame_Template.xlsx
```

## Create the Sheet

1. Upload `PublicTransportGame_Template.xlsx` to Google Drive.
2. Open it with Google Sheets.
3. Convert/save it as a native Google Sheet.
4. Open **Extensions → Apps Script**.
5. Replace the default script contents with everything from:

   ```text
   google-sheets/PublicTransportGame_WebAPI.gs
   ```

6. In Apps Script, add an HTML file named exactly:

   ```text
   ControlPanel
   ```

7. Paste the contents of:

   ```text
   google-sheets/ControlPanel.html
   ```

8. Save the Apps Script project.
9. Reload the Google Sheet.

Reloading is important: the `onOpen()` function stores the bound spreadsheet ID for later public web-app executions and adds the **Game → Open control panel** menu.

---

# 3. Install the generated network in the Sheet

After generating the network in step 1:

1. In the Google Sheet, open **Game → Open control panel**.
2. Choose **Replace network**.
3. Upload:

   ```text
   data/stops.csv
   data/line_stops.csv
   ```

The control panel validates both files before replacing the installed network.

A successful network replacement resets game progress while preserving the organizer-defined configuration, teams, task/puzzle definitions, and Route Bonus definitions where applicable.

---

# 4. Configure the game in Google Sheets

The organizer-facing workbook contains these sheets:

## `Config`

Game-wide settings, including:

- Starting tickets
- Most stops bonus
- Most tasks bonus
- Most puzzles bonus
- Bonus tie rule
- Ownership tie rule

A team's available tickets are:

```text
Starting tickets + Tickets earned - Tickets deposited
```

## `Teams`

Team name and color.

## `Stop Deposits`

Live ticket deposits at each stop.

The team headers show their current available-ticket balance, for example:

```text
Team 1 (12)
```

Untouched/reset deposit cells remain blank rather than displaying `0`.

## `Tasks`

Columns include:

- task ID
- title
- description
- type (`One-time` or `Repeatable`)
- ticket reward
- one team column per team

For **One-time** tasks, team cells are checkboxes.

For **Repeatable** tasks, team cells contain a non-negative completion count.

A repeatable task awards its ticket reward for every completion, but still contributes at most **1** to that team's `Tasks completed` value for the Most Tasks bonus.

## `Puzzles`

Columns include:

- puzzle ID
- title
- latitude
- longitude
- ticket reward
- one checkbox per team

Puzzle coordinates are used by the player web map.

The puzzle content itself is intentionally not public through the web interface.

## `Route Bonuses`

Each row defines:

- City A
- City B
- points
- generated `Completed by`

A team completes a Route Bonus if one connected component of stops owned by that team contains at least one stop in City A and at least one stop in City B.

Multiple teams may complete the same Route Bonus.

## `Scoreboard`

Automatically generated team totals and score components.

## `Stop Data` / `Route Data`

Raw installed network data. These sheets are normally not edited manually.

---

# 5. Deploy the read-only Apps Script API

The player web app needs a public read-only endpoint for the current game state.

In the Apps Script project:

1. Choose **Deploy → New deployment**.
2. Select **Web app**.
3. Configure it to execute as the game owner/deployer.
4. Give the intended players access. If players should not need to sign in with Google, use the public/anonymous access option available for your account.
5. Deploy.
6. Copy the production URL ending in:

   ```text
   /exec
   ```

Use the production `/exec` URL, not the `/dev` test URL.

If you later change `PublicTransportGame_WebAPI.gs`, create/update the web-app deployment so the deployed version includes the new code.

## What the API exposes

The endpoint is **read-only** and publishes only information needed by players:

- teams and colors;
- starting tickets;
- stop owners;
- deposits per stop/team;
- task definitions;
- puzzle titles/coordinates/rewards;
- Route Bonus completion;
- scoreboard values.

It does **not** expose a write API.

Individual task/puzzle completion status is not published; only public aggregate scoreboard counts are visible.

The public snapshot is cached server-side, and successful game-state recalculations invalidate that cache.

---

# 6. Configure the web frontend

Open:

```text
index.html
```

Find the configuration block:

```js
const CONFIG = {
  APP_TITLE: 'Public Transport Game',
  API_URL: 'PASTE_APPS_SCRIPT_WEB_APP_URL_HERE',
  NETWORK_URL: './data/web_network.geojson',
  EDGES_URL: './data/game_edges.geojson',
  POLL_MS: 10000,
  BACKGROUND_POLL_MS: 60000,
  FETCH_TIMEOUT_MS: 12000,
};
```

Replace:

```text
PASTE_APPS_SCRIPT_WEB_APP_URL_HERE
```

with the Apps Script `/exec` URL from step 5.

You may also change `APP_TITLE` to the name of the event/game.

The network URLs are already configured for the repository's `data/` directory.

---

# 7. Test locally

Do not open `index.html` directly as a `file://` URL, because browsers may block loading the GeoJSON files that way.

From the repository root, start a simple local server:

```bash
python -m http.server 8000
```

Then open:

```text
http://localhost:8000/
```

The page still needs internet access for:

- the Leaflet JavaScript/CSS CDN;
- the light map tiles;
- the live Google Apps Script API.

---

# 8. Publish with GitHub Pages

Create a GitHub repository and place the contents of this bundle at the repository root.

After running the network builder, your repository should at minimum contain these public web files:

```text
index.html
data/web_network.geojson
data/game_edges.geojson
```

The repository can also contain the `scripts/`, `google-sheets/`, TSV, and README files; GitHub Pages will simply serve the frontend from `index.html`.

Commit and push, for example:

```bash
git init
git add .
git commit -m "Initial Public Transport Game"
git branch -M main
git remote add origin YOUR_GITHUB_REPOSITORY_URL
git push -u origin main
```

Then enable GitHub Pages for the repository using the `main` branch and repository root as the published source.

The included `.nojekyll` file tells GitHub Pages to serve the repository as a plain static site without Jekyll processing.

---

# Player web interface

The frontend is a single mobile-first page with five bottom-navigation tabs.

## Map

- light-grey basemap;
- all selected bus routes in neutral grey;
- stop markers;
- owned stops use the owning team's color;
- when adjacent stops have the same owner, the segment between them uses that team's color;
- selected stops are enlarged and outlined so the current selection is obvious;
- puzzle locations are shown as dedicated markers.

Tapping a stop opens a bottom sheet with:

- stop name;
- bus-line numbers;
- stop-point value;
- owner/tie state;
- deposits by every team.

Tapping a puzzle uses the same single bottom-sheet interaction—there is no second popup.

## Lines

Searchable list of logical bus lines.

Selecting a line:

- switches to the Map tab;
- highlights the route;
- highlights its stops;
- zooms to that line.

`line_id` is used internally, so two selected logical lines may safely share the same public line number.

## Tasks & puzzles

Puzzles are shown first with:

- title;
- ticket reward;
- a map action when coordinates are available.

Tasks are shown below with:

- title;
- description;
- one-time/repeatable type;
- ticket reward.

The player UI does not reveal which teams completed individual tasks or puzzles.

## Route Bonuses

Cards show:

- City A → City B;
- point value;
- teams that have completed the route.

## Scoreboard

One card per team, ordered by total score, showing metrics such as:

- Tasks completed;
- Puzzles completed;
- Stops owned;
- Stop points;
- Line points;
- Route Bonus points;
- other bonus points;
- Total points;
- available tickets.

A Tasks/Puzzles/Stops metric is visually emphasized when that team actually receives the corresponding configured Gold bonus.

---

# Language

The web UI has a language selector in the top-right:

```text
NL | EN
```

- Dutch is the default.
- The browser remembers the user's choice with `localStorage`.
- Switching language does not reset the map, tab, selection, search query, or scroll position.
- Data supplied by the backend/network is not translated automatically.

---

# Live-update behavior

The app polls the public Apps Script API periodically.

Default timing:

- foreground: every **10 seconds**;
- background tab: every **60 seconds**;
- return to foreground: immediate refresh;
- failures: retry with increasing delay.

Requests are sequential rather than overlapping.

Every public API response includes a content revision. If the revision is unchanged, the browser performs no map/DOM update.

Most importantly, game-state updates are applied **in place**. Polling does not recreate the Leaflet map, call `fitBounds()`, switch tabs, or reset UI state.

Therefore a player can remain zoomed into a particular stop or line while ownership/score information updates around them.

---

# Normal update workflow

## If only game state changes

No deployment is needed. Players automatically receive the new state through polling.

Examples:

- deposits;
- task/puzzle completion;
- Route Bonus completion;
- scores;
- team balances.

## If tasks, puzzles or Route Bonuses are redefined

Edit the Google Sheet. The public state updates automatically.

## If the selected bus network changes

1. Edit `bus_lines_new.tsv` if necessary.
2. Rerun the builder.
3. Upload the new `data/stops.csv` and `data/line_stops.csv` through the Sheet control panel.
4. Commit/push the regenerated:

   ```text
   data/web_network.geojson
   data/game_edges.geojson
   ```

## If the frontend changes

Edit/push `index.html`.

## If the Apps Script backend changes

Update the bound Apps Script project and update/redeploy its Web app deployment.

---

# Notes on game-state robustness

Deposit scoring uses the **current contents of the Google Sheet as the source of truth** rather than relying on a sequence of edit deltas.

For normal deposit edits it recalculates current deposits/ownership from the sheet, but skips graph/Route Bonus work when ownership did not change and only rewrites generated stop-output rows that actually changed.

This gives a useful middle ground between responsiveness and robustness when edits happen quickly.

---

# Security / privacy note

The Apps Script web endpoint is intentionally public/read-only for the player app. Anyone who can access that endpoint can read the public game state it returns, including stop deposits and scoreboard information.

Do not put secrets, private contact information, or other sensitive information in fields exposed to the player interface.

---

# Files you normally edit

For most future use, these are the important files:

```text
bus_lines_new.tsv
index.html
google-sheets/PublicTransportGame_WebAPI.gs
scripts/build_network_from_geojson_endpoints_web_edges.py
```

The spreadsheet template and control panel are included so the repository remains fully self-contained for a fresh setup.


### UI polish in this version

- On wide screens, the white bottom navigation bar spans the full viewport; the five navigation buttons remain centered.
- Scoreboard cards show Tasks, Puzzles, and Stops owned in one row. Gold bonuses are shown directly in the applicable metric card when awarded.
- The Scoreboard includes a short Dutch/English explanation of how Stop points, Line points, Route Bonuses, and Gold bonuses combine into Total points.


### Final scoreboard card layout

The team cards use the achievement-row + vertical score-equation layout:

- Tasks, Puzzles, and Stops owned remain three compact metric boxes.
- When a gold bonus is awarded, `★ +N` appears inline to the right of the metric value.
- The point calculation below is a compact vertical list of Stop points, Line points, Route bonuses, and Gold bonuses.
- Total points are shown only once, in the top-right of the card.


### Additional UI polish

- In the scoreboard, the `Gold bonuses` / `Gouden bonussen` label remains neutral; only a positive bonus value is colored gold.
- Stop deposit values in the map detail sheet are displayed with a ticket symbol, for example `🎟 4`.
- Task types supplied by the API are translated in the frontend: `One-time` becomes `Eenmalig` and `Repeatable` becomes `Herhaalbaar` when Dutch is selected.


### Final subtitle polish

- The Scoreboard explanation now uses the same `section-subtitle` styling as the other tabs, with only `Gold bonuses` / `Gouden bonussen` emphasized in bold.
- The Tasks & Puzzles tab includes a concise bilingual explanation of the puzzle-location/photo/solution flow and how task proof should be submitted.


### Stop ownership help

The stop detail sheet includes a collapsed bilingual `How do you claim a stop?` explanation beneath the live deposits. It explains that the highest ticket deposit owns the stop, how teams prove presence and submit deposits, and the tie rule. The disclosure remains open during live refreshes for the currently selected stop and resets when another stop is selected.


### Final performance review

The final version keeps the conservative, source-of-truth scoring design while removing a few unnecessary operations:

- Stop-deposit header notes are written only when the team layout is rebuilt, rather than after every scoring update.
- The public API no longer emits the obsolete `bonusPoints` field from the earlier scoreboard design.
- Live polling compares state sections before rendering. Static task/puzzle lists and Route Bonus cards are not rebuilt for unrelated deposit changes.
- Leaflet stop and ownership-edge styles are only recalculated when a stop's actual owner (or team colors) changes. Deposit changes that leave ownership unchanged update only the selected stop detail and scoreboard as needed.

The robust Apps Script behavior is intentionally unchanged: deposit edits are still reconciled from current sheet values, and graph scoring is still recomputed only when ownership changes.


### Live API networking

The frontend uses a single CORS `fetch()` path for the Apps Script Web App.
Requests are allowed up to 20 seconds because Google's `/exec` redirect/content-serving
layer can occasionally be slow even when the Apps Script execution itself finishes in
under a second. A failed or timed-out poll leaves the last successful game state on
screen and is retried through the existing exponential-backoff polling loop. JSONP is
not used, avoiding duplicate fallback requests, MIME-type errors, and late-callback
errors during transient Google delivery failures.
