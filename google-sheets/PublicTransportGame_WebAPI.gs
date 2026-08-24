/**
 * Public Transport Game — optimized Google Sheets engine
 *
 * User-facing management happens only through the Game Control sidebar.
 *
 * Scoring:
 *   - Stop points: owned stop = number of logical lines serving it.
 *   - Line points: size of the largest connected component of owned stops in
 *     the complete undirected bus-stop graph.
 *   - Route bonuses: a team completes a configured city-to-city route when
 *     one connected component of its owned stops contains both cities.
 *   - Gold bonuses: most stops / tasks / puzzles.
 *
 * Performance:
 *   - The network graph is compiled once and stored in Document Cache as a
 *     compact integer-indexed structure.
 *   - Every processed deposit edit reconciles from the CURRENT sheet values,
 *     so scoring does not depend on receiving every intermediate edit event.
 *   - Graph/Route Bonus work runs only when current ownership differs from the
 *     generated Owner column (or when explicitly forced).
 *   - Owner/Winning-deposit output writes are limited to rows that changed.
 *   - Task/puzzle edits recalculate only task/puzzle ticket scoring.
 *   - Full recalculation happens only for Config/team/network changes.
 */


const GAME = Object.freeze({
  sheets: Object.freeze({
    config: 'Config',
    teams: 'Teams',
    networkStops: 'Stop Data',
    lineStops: 'Route Data',
    stops: 'Stop Deposits',
    tasks: 'Tasks',
    puzzles: 'Puzzles',
    routeBonuses: 'Route Bonuses',
    scoreboard: 'Scoreboard',
  }),

  stopHeaders: Object.freeze([
    'stop_id', 'stop_name', 'city', 'name', 'num_lines', 'line_refs',
  ]),

  taskHeaders: Object.freeze([
    'task_id', 'title', 'description', 'type', 'tickets',
  ]),

  puzzleHeaders: Object.freeze([
    'puzzle_id', 'title', 'latitude', 'longitude', 'tickets',
  ]),

  scoreHeaders: Object.freeze([
    'Team',
    'Tickets earned',
    'Tickets deposited',
    'Tickets available',
    'Stops owned',
    'Tasks completed',
    'Puzzles completed',
    'Stop points',
    'Line points',
    'Route bonus',
    'Most stops bonus',
    'Most tasks bonus',
    'Most puzzles bonus',
    'Total points',
  ]),

  cacheBase: 'PTG_NETWORK_V11',
  cacheChunkChars: 80000,
  cacheSeconds: 21600,

  publicStateCacheBase: 'PTG_PUBLIC_STATE_V1',
  publicStateCacheSeconds: 300,
  publicStateCacheChunkChars: 80000,

  defaultColors: Object.freeze([
    '#E53935', '#1E88E5', '#43A047', '#FDD835',
    '#8E24AA', '#FB8C00', '#00897B', '#6D4C41',
  ]),

  colors: Object.freeze({
    navy: '#1F4E78',
    dark: '#263238',
    green: '#70AD47',
    input: '#FFF2CC',
    output: '#E2F0D9',
    red: '#F4CCCC',
    white: '#FFFFFF',
  }),
});


// =============================================================================
// Read-only public web API
// =============================================================================

/**
 * Public GET endpoint for the GitHub Pages player interface.
 *
 * Deploy the bound Apps Script as a Web App that executes as the game owner
 * and is accessible to anyone with the URL. The endpoint is deliberately
 * read-only; no game mutation is exposed through doGet().
 *
 * Normal JSON:
 *   <web-app-url>
 *
 * JSONP fallback for browsers/environments where cross-origin fetch to Apps
 * Script is inconvenient:
 *   <web-app-url>?callback=myCallback
 */
function doGet(e) {
  try {
    const state = getPublicGameState_();
    const json = JSON.stringify(state);
    const callback = String(
      e && e.parameter && e.parameter.callback || ''
    ).trim();

    if (callback) {
      if (!isSafeJsonpCallback_(callback)) {
        return ContentService
          .createTextOutput(
            JSON.stringify({error: 'Invalid callback name.'})
          )
          .setMimeType(ContentService.MimeType.JSON);
      }

      return ContentService
        .createTextOutput(`${callback}(${json});`)
        .setMimeType(ContentService.MimeType.JAVASCRIPT);
    }

    return ContentService
      .createTextOutput(json)
      .setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    console.error(error);

    const payload = JSON.stringify({
      error: 'Could not load public game state.',
      message: error.message,
    });

    const callback = String(
      e && e.parameter && e.parameter.callback || ''
    ).trim();

    if (callback && isSafeJsonpCallback_(callback)) {
      return ContentService
        .createTextOutput(`${callback}(${payload});`)
        .setMimeType(ContentService.MimeType.JAVASCRIPT);
    }

    return ContentService
      .createTextOutput(payload)
      .setMimeType(ContentService.MimeType.JSON);
  }
}


function isSafeJsonpCallback_(value) {
  return /^[A-Za-z_$][0-9A-Za-z_$]*(?:\.[A-Za-z_$][0-9A-Za-z_$]*)*$/.test(
    value
  );
}


function rememberGameSpreadsheet_(ss) {
  if (!ss) return;

  PropertiesService
    .getScriptProperties()
    .setProperty('PTG_GAME_SPREADSHEET_ID', ss.getId());
}


function getGameSpreadsheet_() {
  const properties = PropertiesService.getScriptProperties();
  const storedId = properties.getProperty('PTG_GAME_SPREADSHEET_ID');

  if (storedId) {
    return SpreadsheetApp.openById(storedId);
  }

  const active = SpreadsheetApp.getActiveSpreadsheet();

  if (active) {
    rememberGameSpreadsheet_(active);
    return active;
  }

  throw new Error(
    'Game spreadsheet is not initialized for web access. Open the sheet once '
    + 'after installing this script.'
  );
}


function getPublicGameState_() {
  const cached = readPublicStateCache_();
  if (cached) return cached;

  const ss = getGameSpreadsheet_();
  const teams = getTeams_(ss);
  const config = getConfig_(ss);

  const core = {
    schemaVersion: 1,
    teams: teams.map(team => ({
      name: team.name,
      color: team.color,
    })),
    config: {
      startingTickets: config.startingTickets,
    },
    stops: readPublicStops_(ss, teams),
    tasks: readPublicTasks_(ss),
    puzzles: readPublicPuzzles_(ss),
    routeBonuses: readPublicRouteBonuses_(ss, teams),
    scoreboard: readPublicScoreboard_(ss, teams),
  };

  const stableJson = JSON.stringify(core);
  const state = Object.assign({
    revision: sha256Hex_(stableJson),
    generatedAt: new Date().toISOString(),
  }, core);

  writePublicStateCache_(state);
  return state;
}


function readPublicStops_(ss, teams) {
  const sheet = requireSheet_(ss, GAME.sheets.stops);

  if (sheet.getLastRow() < 2) return {};

  const rowCount = sheet.getLastRow() - 1;
  const firstDepositIndex = GAME.stopHeaders.length;
  const ownerIndex = firstDepositIndex + teams.length;
  const winningIndex = ownerIndex + 1;

  const rows = sheet
    .getRange(2, 1, rowCount, winningIndex + 1)
    .getValues();

  const result = {};

  for (const row of rows) {
    const stopId = String(row[0] || '').trim();
    if (!stopId) continue;

    const deposits = [];

    for (let i = 0; i < teams.length; i++) {
      const raw = row[firstDepositIndex + i];

      if (raw === '' || raw === null || raw === undefined) {
        deposits.push(null);
      } else {
        const value = Number(raw);
        deposits.push(Number.isFinite(value) ? value : null);
      }
    }

    const ownerDisplay = String(row[ownerIndex] || '').trim();
    const owner = teams.some(team => team.name === ownerDisplay)
      ? ownerDisplay
      : null;

    const rawWinning = row[winningIndex];
    const winning = rawWinning === '' || rawWinning === null
      ? null
      : Number(rawWinning);

    result[stopId] = {
      owner,
      deposits,
      winningDeposit: Number.isFinite(winning) ? winning : null,
    };
  }

  return result;
}


function readPublicTasks_(ss) {
  const sheet = requireSheet_(ss, GAME.sheets.tasks);
  if (sheet.getLastRow() < 2) return [];

  const rows = sheet
    .getRange(2, 1, sheet.getLastRow() - 1, GAME.taskHeaders.length)
    .getValues();

  const result = [];

  for (const row of rows) {
    const taskId = String(row[0] || '').trim();
    const title = String(row[1] || '').trim();
    const description = String(row[2] || '').trim();
    const type = String(row[3] || '').trim();
    const rawTickets = row[4];

    if (!taskId && !title && !description && !type && rawTickets === '') {
      continue;
    }

    const tickets = Number(rawTickets);

    result.push({
      id: taskId,
      title,
      description,
      type,
      tickets: Number.isFinite(tickets) ? tickets : 0,
    });
  }

  return result;
}


function readPublicPuzzles_(ss) {
  const sheet = requireSheet_(ss, GAME.sheets.puzzles);
  if (sheet.getLastRow() < 2) return [];

  const rows = sheet
    .getRange(2, 1, sheet.getLastRow() - 1, GAME.puzzleHeaders.length)
    .getValues();

  const result = [];

  for (const row of rows) {
    const puzzleId = String(row[0] || '').trim();
    const title = String(row[1] || '').trim();
    const rawLat = row[2];
    const rawLon = row[3];
    const rawTickets = row[4];

    if (!puzzleId && !title && rawLat === '' && rawLon === '' && rawTickets === '') {
      continue;
    }

    const latitude = Number(rawLat);
    const longitude = Number(rawLon);
    const tickets = Number(rawTickets);

    result.push({
      id: puzzleId,
      title,
      latitude: Number.isFinite(latitude) ? latitude : null,
      longitude: Number.isFinite(longitude) ? longitude : null,
      tickets: Number.isFinite(tickets) ? tickets : 0,
    });
  }

  return result;
}


function readPublicRouteBonuses_(ss, teams) {
  const sheet = requireSheet_(ss, GAME.sheets.routeBonuses);
  if (sheet.getLastRow() < 2) return [];

  const rows = sheet
    .getRange(2, 1, sheet.getLastRow() - 1, 4)
    .getValues();

  const result = [];

  for (const row of rows) {
    const cityA = String(row[0] || '').trim();
    const cityB = String(row[1] || '').trim();
    const rawPoints = row[2];
    const completedText = String(row[3] || '').trim();

    if (!cityA && !cityB && rawPoints === '' && !completedText) continue;

    const points = Number(rawPoints);
    const completedBy = teams
      .filter(team => completedText
        .split(', ')
        .includes(team.name))
      .map(team => team.name);

    result.push({
      cityA,
      cityB,
      points: Number.isFinite(points) ? points : 0,
      completedBy,
    });
  }

  return result;
}


function readPublicScoreboard_(ss, teams) {
  const sheet = requireSheet_(ss, GAME.sheets.scoreboard);
  if (sheet.getLastRow() < 2) return [];

  const rows = sheet
    .getRange(2, 1, teams.length, GAME.scoreHeaders.length)
    .getValues();

  const byName = new Map();

  for (const row of rows) {
    const name = String(row[0] || '').trim();
    if (!name) continue;

    const routeBonus = numberOrZero_(row[9]);
    const mostStopsBonus = numberOrZero_(row[10]);
    const mostTasksBonus = numberOrZero_(row[11]);
    const mostPuzzlesBonus = numberOrZero_(row[12]);

    byName.set(name, {
      team: name,
      ticketsEarned: numberOrZero_(row[1]),
      ticketsDeposited: numberOrZero_(row[2]),
      ticketsAvailable: numberOrZero_(row[3]),
      stopsOwned: numberOrZero_(row[4]),
      tasksCompleted: numberOrZero_(row[5]),
      puzzlesCompleted: numberOrZero_(row[6]),
      stopPoints: numberOrZero_(row[7]),
      linePoints: numberOrZero_(row[8]),
      routeBonus,
      mostStopsBonus,
      mostTasksBonus,
      mostPuzzlesBonus,
      totalPoints: numberOrZero_(row[13]),
    });
  }

  return teams
    .map(team => byName.get(team.name))
    .filter(Boolean);
}


function sha256Hex_(value) {
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    value,
    Utilities.Charset.UTF_8
  );

  return digest
    .map(byte => (byte + 256) % 256)
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}


function publicStateMetaKey_() {
  return `${GAME.publicStateCacheBase}:meta`;
}


function publicStateChunkKey_(index) {
  return `${GAME.publicStateCacheBase}:chunk:${index}`;
}


function readPublicStateCache_() {
  const cache = CacheService.getScriptCache();
  const rawMeta = cache.get(publicStateMetaKey_());

  if (!rawMeta) return null;

  let meta;
  try {
    meta = JSON.parse(rawMeta);
  } catch (_) {
    clearPublicStateCache_();
    return null;
  }

  const count = Number(meta.chunkCount);
  if (!Number.isInteger(count) || count < 1) return null;

  const keys = [];
  for (let i = 0; i < count; i++) {
    keys.push(publicStateChunkKey_(i));
  }

  const chunks = cache.getAll(keys);
  const parts = [];

  for (const key of keys) {
    if (!(key in chunks)) {
      clearPublicStateCache_();
      return null;
    }
    parts.push(chunks[key]);
  }

  try {
    return JSON.parse(parts.join(''));
  } catch (_) {
    clearPublicStateCache_();
    return null;
  }
}


function writePublicStateCache_(state) {
  const cache = CacheService.getScriptCache();
  const text = JSON.stringify(state);
  const chunkSize = GAME.publicStateCacheChunkChars;
  const chunks = [];

  for (let start = 0; start < text.length; start += chunkSize) {
    chunks.push(text.slice(start, start + chunkSize));
  }

  const values = {};
  chunks.forEach((chunk, index) => {
    values[publicStateChunkKey_(index)] = chunk;
  });

  if (Object.keys(values).length) {
    cache.putAll(values, GAME.publicStateCacheSeconds);
  }

  cache.put(
    publicStateMetaKey_(),
    JSON.stringify({chunkCount: chunks.length}),
    GAME.publicStateCacheSeconds
  );
}


function clearPublicStateCache_() {
  const cache = CacheService.getScriptCache();
  const rawMeta = cache.get(publicStateMetaKey_());
  const keys = [publicStateMetaKey_()];

  if (rawMeta) {
    try {
      const count = Number(JSON.parse(rawMeta).chunkCount);
      if (Number.isInteger(count) && count > 0) {
        for (let i = 0; i < count; i++) {
          keys.push(publicStateChunkKey_(i));
        }
      }
    } catch (_) {}
  }

  cache.removeAll(keys);
}


// =============================================================================
// UI
// =============================================================================

function onOpen() {
  rememberGameSpreadsheet_(SpreadsheetApp.getActiveSpreadsheet());

  SpreadsheetApp.getUi()
    .createMenu('Game')
    .addItem('Open control panel', 'showControlPanel')
    .addToUi();
}


function showControlPanel() {
  const html = HtmlService
    .createHtmlOutputFromFile('ControlPanel')
    .setTitle('Game Control');

  SpreadsheetApp.getUi().showSidebar(html);
}


/**
 * Keep normal gameplay automatic.
 *
 * There are deliberately no user-facing Sync/Recalculate/Validate actions.
 */
function onEdit(e) {
  if (!e || !e.range) return;

  const ss = e.source;
  const sheetName = e.range.getSheet().getName();

  try {
    if (sheetName === GAME.sheets.stops) {
      if (editTouchesDeposits_(e.range, ss)) {
        withShortLock_(function() {
          updateOwnershipScoring_(ss);
        });
      }
      return;
    }

    if (sheetName === GAME.sheets.tasks) {
      if (e.range.getLastRow() >= 2) {
        withShortLock_(function() {
          if (editTouchesTaskType_(e.range)) {
            configureTaskInputRows_(ss, getTeams_(ss), e.range);
          }
          updateTaskPuzzleScoring_(ss);
        });
      }
      return;
    }

    if (sheetName === GAME.sheets.puzzles) {
      if (e.range.getLastRow() >= 2) {
        withShortLock_(function() {
          updateTaskPuzzleScoring_(ss);
        });
      }
      return;
    }

    if (sheetName === GAME.sheets.config) {
      withShortLock_(function() {
        recalculateAll_(ss);
      });
      return;
    }

    if (sheetName === GAME.sheets.routeBonuses) {
      if (e.range.getLastRow() >= 2) {
        withShortLock_(function() {
          updateOwnershipScoring_(ss, true);
        });
      }
      return;
    }

    if (sheetName === GAME.sheets.teams) {
      withShortLock_(function() {
        syncTeamsAutomatically_(ss);
      });
      return;
    }

    if (
      sheetName === GAME.sheets.networkStops ||
      sheetName === GAME.sheets.lineStops
    ) {
      clearNetworkCache_();
      ss.toast(
        'Network source edited directly. Use Game → Open control panel → ' +
        'Replace network to install it safely.',
        'Public Transport Game',
        6
      );
    }

  } catch (error) {
    console.error(error);
    ss.toast(
      'Game update failed: ' + error.message,
      'Public Transport Game',
      8
    );
  }
}


// =============================================================================
// Control panel state/actions
// =============================================================================

function getControlPanelState() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  rememberGameSpreadsheet_(ss);

  let teamCount = 0;
  try {
    teamCount = getTeams_(ss).length;
  } catch (_) {}

  let network = null;
  let networkError = '';

  try {
    network = getNetworkOptional_(ss);
  } catch (error) {
    networkError = error.message;
  }

  return {
    teamCount,
    networkInstalled: Boolean(network),
    networkError,
    stopCount: network ? network.stopIds.length : 0,
    lineCount: network ? network.lineCount : 0,
    edgeCount: network ? network.edgeCount : 0,
    variantCount: network ? network.variantCount : 0,
  };
}


function resetGameFromControlPanel() {
  return withGameLock_(function() {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const teams = getTeams_(ss);

    clearProgress_(ss, teams);
    recalculateAll_(ss);

    return {
      ok: true,
      message: 'All deposits and task/puzzle completions were cleared.',
    };
  });
}


/**
 * Store one chunk of a locally selected CSV in the document cache.
 *
 * Local files are read as text in the sidebar rather than being submitted as
 * HTML file-input Blobs. This is more reliable for moderately large CSVs.
 */
function storeNetworkUploadChunk(sessionId, kind, index, chunk) {
  validateUploadSession_(sessionId);
  validateUploadKind_(kind);

  const chunkIndex = Number(index);

  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
    throw new Error('Invalid upload chunk index.');
  }

  if (typeof chunk !== 'string') {
    throw new Error('Invalid upload chunk.');
  }

  CacheService.getDocumentCache().put(
    uploadChunkKey_(sessionId, kind, chunkIndex),
    chunk,
    600
  );

  return {ok: true};
}


/**
 * Reassemble two chunked CSV uploads, validate them and install the network.
 */
function finishNetworkUpload(
  sessionId,
  stopsChunkCount,
  lineStopsChunkCount
) {
  validateUploadSession_(sessionId);

  return withGameLock_(function() {
    const stopCount = validateChunkCount_(stopsChunkCount);
    const lineCount = validateChunkCount_(lineStopsChunkCount);

    try {
      const stopsText = readUploadChunks_(
        sessionId,
        'stops',
        stopCount
      );

      const lineStopsText = readUploadChunks_(
        sessionId,
        'lineStops',
        lineCount
      );

      return installNetwork_(
        normalizeTable_(
          Utilities.parseCsv(stopsText),
          'stops.csv'
        ),
        normalizeTable_(
          Utilities.parseCsv(lineStopsText),
          'line_stops.csv'
        ),
        'uploaded CSV files'
      );

    } finally {
      removeUploadChunks_(
        sessionId,
        stopCount,
        lineCount
      );
    }
  });
}


function validateUploadSession_(sessionId) {
  const value = String(sessionId || '');

  if (!/^[A-Za-z0-9_-]{8,80}$/.test(value)) {
    throw new Error('Invalid upload session.');
  }
}


function validateUploadKind_(kind) {
  if (kind !== 'stops' && kind !== 'lineStops') {
    throw new Error('Invalid upload file type.');
  }
}


function validateChunkCount_(count) {
  const value = Number(count);

  if (
    !Number.isInteger(value) ||
    value < 1 ||
    value > 1000
  ) {
    throw new Error('Invalid upload chunk count.');
  }

  return value;
}


function uploadChunkKey_(sessionId, kind, index) {
  return `PTG_UPLOAD:${sessionId}:${kind}:${index}`;
}


function readUploadChunks_(sessionId, kind, count) {
  validateUploadKind_(kind);

  const cache = CacheService.getDocumentCache();
  const keys = [];

  for (let i = 0; i < count; i++) {
    keys.push(uploadChunkKey_(sessionId, kind, i));
  }

  const values = cache.getAll(keys);
  const parts = [];

  for (const key of keys) {
    if (!(key in values)) {
      throw new Error(
        'An upload chunk expired or was not received. ' +
        'Please try the upload again.'
      );
    }

    parts.push(values[key]);
  }

  return parts.join('');
}


function removeUploadChunks_(
  sessionId,
  stopsChunkCount,
  lineStopsChunkCount
) {
  const keys = [];

  for (let i = 0; i < stopsChunkCount; i++) {
    keys.push(uploadChunkKey_(sessionId, 'stops', i));
  }

  for (let i = 0; i < lineStopsChunkCount; i++) {
    keys.push(uploadChunkKey_(sessionId, 'lineStops', i));
  }

  if (keys.length) {
    CacheService.getDocumentCache().removeAll(keys);
  }
}


function replaceNetworkFromDrive(stopsReference, lineStopsReference) {
  return withGameLock_(function() {
    return installNetwork_(
      readDriveCsv_(stopsReference, 'stops.csv'),
      readDriveCsv_(lineStopsReference, 'line_stops.csv'),
      'Google Drive CSV files'
    );
  });
}


function replaceNetworkFromGoogleSheet(spreadsheetReference) {
  return withGameLock_(function() {
    const id = extractGoogleFileId_(spreadsheetReference);

    if (!id) {
      throw new Error(
        'Could not determine the Google Sheets file ID from that link/ID.'
      );
    }

    let source;
    try {
      source = SpreadsheetApp.openById(id);
    } catch (_) {
      throw new Error(
        'Could not open that Google Sheet. Check the link/ID and your access.'
      );
    }

    const stopSheet = source.getSheetByName(GAME.sheets.networkStops);
    const lineSheet = source.getSheetByName(GAME.sheets.lineStops);

    if (!stopSheet || !lineSheet) {
      throw new Error(
        `The source spreadsheet needs tabs named "${GAME.sheets.networkStops}" ` +
        `and "${GAME.sheets.lineStops}".`
      );
    }

    return installNetwork_(
      normalizeTable_(stopSheet.getDataRange().getValues(), 'Stop Data'),
      normalizeTable_(lineSheet.getDataRange().getValues(), 'Route Data'),
      `Google Sheet "${source.getName()}"`
    );
  });
}


// =============================================================================
// Network installation / compilation / cache
// =============================================================================

function installNetwork_(stopsTable, lineStopsTable, sourceDescription) {
  // Validate fully before altering the current workbook.
  const summary = validateImportedNetwork_(stopsTable, lineStopsTable);

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  writeSourceTable_(
    requireSheet_(ss, GAME.sheets.networkStops),
    stopsTable,
    true
  );
  writeSourceTable_(
    requireSheet_(ss, GAME.sheets.lineStops),
    lineStopsTable,
    false
  );

  clearNetworkCache_();

  // Build/cache from the newly installed source and derive stop line counts.
  const network = getNetwork_(ss, true);
  syncNetworkDerivedColumns_(ss, network);

  const teams = getTeams_(ss);

  // Network replacement is always a fresh game.
  syncStopsLayout_(ss, teams, network, false);
  syncTasksLayout_(ss, teams, false);
  syncPuzzlesLayout_(ss, teams, false);
  syncRouteBonusesLayout_(ss, network);
  syncScoreboardLayout_(ss, teams);
  recalculateAll_(ss);

  return {
    ok: true,
    message:
      `Installed ${summary.stopCount} stops, ${summary.lineCount} logical ` +
      `lines, ${summary.variantCount} route variants and ` +
      `${network.edgeCount} graph connections from ` +
      `${sourceDescription}. Game progress was reset.`,
  };
}


/**
 * Compact scoring representation:
 *   stopIds[index]
 *   stopCities[index]
 *   lineCounts[index]
 *   lineIdsByStop[index]
 *   lineRefsByStop[index]
 *   edges: [nodeIndexA, nodeIndexB]
 *
 * Only data needed by live scoring is retained in the cache.
 */
function getNetwork_(ss, forceRebuild) {
  if (!networkSourceHasData_(ss)) {
    throw new Error(
      'No network is installed. Open the Game control panel and replace network.'
    );
  }

  if (!forceRebuild) {
    const cached = getCachedJson_();

    if (cached) {
      return cached;
    }
  }

  const network = compileNetworkFromSheets_(ss);
  putCachedJson_(network);

  return network;
}


function getNetworkOptional_(ss) {
  if (!networkSourceHasData_(ss)) return null;
  return getNetwork_(ss, false);
}


function networkSourceHasData_(ss) {
  const stops = ss.getSheetByName(GAME.sheets.networkStops);
  const lines = ss.getSheetByName(GAME.sheets.lineStops);

  return Boolean(
    stops && lines &&
    stops.getLastRow() >= 2 &&
    lines.getLastRow() >= 2
  );
}


function compileNetworkFromSheets_(ss) {
  const stopSheet = requireSheet_(ss, GAME.sheets.networkStops);
  const lineSheet = requireSheet_(ss, GAME.sheets.lineStops);

  const stopHeaders = getHeaderMap_(stopSheet);
  const lineHeaders = getHeaderMap_(lineSheet);

  requireHeaders_(
    stopHeaders,
    [
      'stop_id', 'stop_name', 'city', 'name',
      'longitude', 'latitude',
      'num_lines', 'line_ids', 'line_refs',
      'name_source_agency', 'source_agencies',
      'source_stop_ids', 'source_stop_names',
    ],
    GAME.sheets.networkStops
  );

  requireHeaders_(
    lineHeaders,
    [
      'line_id', 'line_ref', 'line_name', 'agency_id',
      'route_id', 'variant_id', 'shape_id', 'headsign',
      'trip_count', 'stop_order', 'stop_id', 'stop_name',
      'distance_to_shape_m', 'is_loop_closure',
    ],
    GAME.sheets.lineStops
  );

  const stopValues = stopSheet
    .getRange(
      2, 1,
      stopSheet.getLastRow() - 1,
      stopSheet.getLastColumn()
    )
    .getValues();

  const stopIds = [];
  const rawStopCities = [];
  const sourceStopNames = [];
  const indexByStopId = new Map();

  for (const row of stopValues) {
    const stopId = cellString_(row, stopHeaders.get('stop_id'));
    if (!stopId) continue;

    if (indexByStopId.has(stopId)) {
      throw new Error(`Duplicate stop_id "${stopId}" in Stop Data.`);
    }

    indexByStopId.set(stopId, stopIds.length);
    stopIds.push(stopId);
    rawStopCities.push(cellString_(row, stopHeaders.get('city')));
    sourceStopNames.push(
      cellString_(row, stopHeaders.get('source_stop_names'))
    );
  }

  if (!stopIds.length) {
    throw new Error('Stop Data contains no stops.');
  }

  // Infer city aliases from spatially merged stops whose source names use a
  // different city label than the canonical (QBUZZ-preferred) stop name.
  // Only unambiguous alias evidence is used.
  const cityAliasTargets = new Map();

  for (let i = 0; i < stopIds.length; i++) {
    const canonicalCity = rawStopCities[i];
    if (!canonicalCity) continue;

    const names = sourceStopNames[i]
      .split('|')
      .map(value => value.trim())
      .filter(Boolean);

    for (const stopName of names) {
      const comma = stopName.indexOf(',');
      if (comma < 0) continue;

      const sourceCity = stopName.slice(0, comma).trim();

      if (!sourceCity || sourceCity === canonicalCity) continue;

      if (!cityAliasTargets.has(sourceCity)) {
        cityAliasTargets.set(sourceCity, new Set());
      }

      cityAliasTargets.get(sourceCity).add(canonicalCity);
    }
  }

  const cityAliases = new Map();

  for (const [sourceCity, targets] of cityAliasTargets.entries()) {
    if (targets.size === 1) {
      cityAliases.set(sourceCity, Array.from(targets)[0]);
    }
  }

  const resolveCity = city => {
    let current = city;
    const seen = new Set();

    while (cityAliases.has(current) && !seen.has(current)) {
      seen.add(current);
      current = cityAliases.get(current);
    }

    return current;
  };

  const stopCities = rawStopCities.map(resolveCity);

  const lineValues = lineSheet
    .getRange(
      2, 1,
      lineSheet.getLastRow() - 1,
      lineSheet.getLastColumn()
    )
    .getValues();

  const variants = new Map();
  const lineIds = new Set();
  const lineMeta = new Map();
  const variantToLine = new Map();

  const lineIdsByStopSets = Array.from(
    {length: stopIds.length},
    () => new Set()
  );

  const lineRefsByStopSets = Array.from(
    {length: stopIds.length},
    () => new Set()
  );

  for (const row of lineValues) {
    const lineId = cellString_(row, lineHeaders.get('line_id'));
    const lineRef = cellString_(row, lineHeaders.get('line_ref'));
    const lineName = cellString_(row, lineHeaders.get('line_name'));
    const agencyId = cellString_(row, lineHeaders.get('agency_id'));
    const variantId = cellString_(row, lineHeaders.get('variant_id'));
    const stopId = cellString_(row, lineHeaders.get('stop_id'));
    const stopOrder = Number(row[lineHeaders.get('stop_order')]);

    if (!lineId && !variantId && !stopId) continue;

    if (
      !lineId ||
      !variantId ||
      !stopId ||
      !Number.isFinite(stopOrder)
    ) {
      throw new Error('Route Data contains an incomplete/invalid route row.');
    }

    const stopIndex = indexByStopId.get(stopId);

    if (stopIndex === undefined) {
      throw new Error(`Route Data references unknown stop_id "${stopId}".`);
    }

    if (
      variantToLine.has(variantId) &&
      variantToLine.get(variantId) !== lineId
    ) {
      throw new Error(
        `variant_id "${variantId}" occurs under multiple line_id values.`
      );
    }

    variantToLine.set(variantId, lineId);
    lineIds.add(lineId);

    if (!lineMeta.has(lineId)) {
      lineMeta.set(lineId, [lineRef, lineName, agencyId]);
    } else {
      const meta = lineMeta.get(lineId);

      if (
        meta[0] !== lineRef ||
        meta[1] !== lineName ||
        meta[2] !== agencyId
      ) {
        throw new Error(
          `line_id "${lineId}" has inconsistent line metadata.`
        );
      }
    }

    lineIdsByStopSets[stopIndex].add(lineId);
    if (lineRef) lineRefsByStopSets[stopIndex].add(lineRef);

    if (!variants.has(variantId)) {
      variants.set(variantId, []);
    }

    variants.get(variantId).push([stopOrder, stopIndex]);
  }

  if (!lineIds.size) {
    throw new Error('Route Data contains no logical lines.');
  }

  const edgeKeys = new Set();

  for (const occurrences of variants.values()) {
    occurrences.sort((a, b) => a[0] - b[0]);

    const sequence = [];

    for (const occurrence of occurrences) {
      const stopIndex = occurrence[1];

      if (
        !sequence.length ||
        sequence[sequence.length - 1] !== stopIndex
      ) {
        sequence.push(stopIndex);
      }
    }

    for (let i = 1; i < sequence.length; i++) {
      const a = Math.min(sequence[i - 1], sequence[i]);
      const b = Math.max(sequence[i - 1], sequence[i]);

      if (a !== b) edgeKeys.add(`${a},${b}`);
    }
  }

  const edges = Array.from(edgeKeys, key => {
    const [a, b] = key.split(',');
    return [Number(a), Number(b)];
  });

  const lineIdsByStop = lineIdsByStopSets.map(values =>
    Array.from(values).sort(naturalCompare_)
  );

  const lineRefsByStop = lineRefsByStopSets.map(values =>
    Array.from(values).sort(naturalCompare_)
  );

  const lineCounts = lineIdsByStop.map(values => values.length);
  const cityNames = Array.from(
    new Set(stopCities.filter(Boolean))
  ).sort(naturalCompare_);

  return {
    stopIds,
    stopCities,
    lineCounts,
    lineIdsByStop,
    lineRefsByStop,
    edges,
    cityNames,
    lineCount: lineIds.size,
    edgeCount: edges.length,
    variantCount: variants.size,
  };
}

function clearNetworkCache_() {
  const cache = CacheService.getDocumentCache();
  const countKey = `${GAME.cacheBase}:count`;
  const count = Number(cache.get(countKey) || 0);

  const keys = [countKey];

  for (let i = 0; i < count; i++) {
    keys.push(`${GAME.cacheBase}:${i}`);
  }

  cache.removeAll(keys);
}


function putCachedJson_(value) {
  const cache = CacheService.getDocumentCache();
  const text = JSON.stringify(value);
  const size = GAME.cacheChunkChars;
  const count = Math.ceil(text.length / size);

  const values = {};

  for (let i = 0; i < count; i++) {
    values[`${GAME.cacheBase}:${i}`] = text.slice(
      i * size,
      (i + 1) * size
    );
  }

  values[`${GAME.cacheBase}:count`] = String(count);
  cache.putAll(values, GAME.cacheSeconds);
}


function getCachedJson_() {
  const cache = CacheService.getDocumentCache();
  const count = Number(cache.get(`${GAME.cacheBase}:count`) || 0);

  if (!count) return null;

  const keys = [];

  for (let i = 0; i < count; i++) {
    keys.push(`${GAME.cacheBase}:${i}`);
  }

  const values = cache.getAll(keys);
  let text = '';

  for (const key of keys) {
    if (!(key in values)) return null;
    text += values[key];
  }

  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}


// =============================================================================
// Automatic structural synchronization
// =============================================================================

function syncTeamsAutomatically_(ss) {
  const teams = getTeams_(ss);
  const network = getNetworkOptional_(ss);

  syncStopsLayout_(ss, teams, network, true);
  syncTasksLayout_(ss, teams, true);
  syncPuzzlesLayout_(ss, teams, true);
  syncScoreboardLayout_(ss, teams);

  syncRouteBonusesLayout_(ss, network);

  recalculateAll_(ss);

  ss.toast(
    `Team layout updated for ${teams.length} teams.`,
    'Public Transport Game',
    4
  );
}


function syncStopsLayout_(ss, teams, network, preserveDeposits) {
  const sheet = requireSheet_(ss, GAME.sheets.stops);
  const oldDeposits = preserveDeposits
    ? readExistingDeposits_(sheet)
    : new Map();

  const headers = GAME.stopHeaders
    .concat(teams.map(team => team.name))
    .concat(['Owner', 'Winning deposit']);

  let rows = [];

  if (network) {
    const metadata = readNetworkStopMetadata_(ss, network);
    rows = metadata.map(item => {
      const old = oldDeposits.get(item.stopId);

      const deposits = teams.map(team => {
        if (!old || !old.has(team.name)) return '';

        const raw = old.get(team.name);

        // Preserve a genuinely empty progress cell as empty. A manually
        // entered numeric 0 remains 0, but fresh/reset cells stay blank.
        if (
          raw === '' ||
          raw === null ||
          raw === undefined
        ) {
          return '';
        }

        const value = Number(raw);
        return Number.isFinite(value) && value >= 0 ? value : '';
      });

      return [
        item.stopId,
        item.stopName,
        item.city,
        item.name,
        network.lineCounts[item.index],
        network.lineRefsByStop[item.index].join(', '),
        ...deposits,
        '',
        '',
      ];
    });
  }

  ensureSheetSize_(sheet, Math.max(rows.length + 1, 2), headers.length);
  sheet.clear();

  const firstDepositCol = GAME.stopHeaders.length + 1;
  const ownerCol = firstDepositCol + teams.length;

  if (rows.length) {
    setPlainTextColumns_(
      sheet,
      2,
      rows.length,
      [1, 2, 3, 4, 6, ownerCol]
    );

    setNumberFormatColumns_(
      sheet,
      2,
      rows.length,
      [5, ownerCol + 1],
      '0'
    );

    if (teams.length) {
      sheet
        .getRange(2, firstDepositCol, rows.length, teams.length)
        .setNumberFormat('0');
    }
  }

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

  if (rows.length) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }

  styleBaseSheet_(sheet);
  styleHeader_(sheet.getRange(1, 1, 1, GAME.stopHeaders.length), GAME.colors.navy);

  teams.forEach((team, i) => {
    const headerCell = sheet.getRange(
      1,
      GAME.stopHeaders.length + 1 + i
    );

    styleTeamHeader_(headerCell, team);

    // Preserve the canonical team name independently of the displayed
    // "Team (available tickets)" label.
    headerCell.setNote(team.name);
  });

  styleHeader_(sheet.getRange(1, ownerCol, 1, 2), GAME.colors.green);

  if (rows.length) {
    sheet
      .getRange(2, firstDepositCol, rows.length, teams.length)
      .setBackground(GAME.colors.input)
      .setNumberFormat('0')
      .setDataValidation(
        SpreadsheetApp
          .newDataValidation()
          .requireNumberGreaterThanOrEqualTo(0)
          .setAllowInvalid(false)
          .build()
      );

    sheet
      .getRange(2, ownerCol, rows.length, 2)
      .setBackground(GAME.colors.output);
  }

  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(2);

  setColumnWidths_(
    sheet,
    [
      330, 275, 140, 220, 105, 210,
      ...teams.map(() => 130),
      145, 115,
    ]
  );
}


function syncTasksLayout_(ss, teams, preserveProgress) {
  const sheet = requireSheet_(ss, GAME.sheets.tasks);
  const existing = readExistingTasks_(sheet);

  if (!preserveProgress) {
    existing.progress = new Map();
  }

  const rowCapacity = Math.max(
    150,
    existing.staticRows.length + 20
  );

  const headers = GAME.taskHeaders.concat(
    teams.map(team => team.name)
  );

  ensureSheetSize_(sheet, rowCapacity + 1, headers.length);
  sheet.clear();

  // task_id, title, description and type are text. Tickets is numeric.
  setPlainTextColumns_(sheet, 2, rowCapacity, [1, 2, 3, 4]);
  setNumberFormatColumns_(sheet, 2, rowCapacity, [5], '0');

  if (teams.length) {
    sheet
      .getRange(2, 6, rowCapacity, teams.length)
      .setNumberFormat('General');
  }

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

  if (existing.staticRows.length) {
    sheet
      .getRange(2, 1, existing.staticRows.length, 5)
      .setValues(existing.staticRows);
  }

  styleBaseSheet_(sheet);
  styleHeader_(sheet.getRange(1, 1, 1, 5), GAME.colors.navy);

  teams.forEach((team, i) => {
    styleTeamHeader_(sheet.getRange(1, 6 + i), team);
  });

  sheet
    .getRange(2, 1, rowCapacity, 5)
    .setBackground(GAME.colors.input);

  sheet
    .getRange(2, 4, rowCapacity, 1)
    .setDataValidation(
      SpreadsheetApp
        .newDataValidation()
        .requireValueInList(['One-time', 'Repeatable'], true)
        .setAllowInvalid(false)
        .build()
    );

  sheet.getRange(2, 5, rowCapacity, 1).setNumberFormat('0');

  if (teams.length) {
    sheet
      .getRange(2, 6, rowCapacity, teams.length)
      .setBackground(GAME.colors.input)
      .clearDataValidations()
      .clearContent();
  }

  // Configure only defined task rows. Unused rows are already blank; when a
  // user chooses a Type later, onEdit configures that row immediately.
  for (let r = 0; r < existing.staticRows.length; r++) {
    const taskId = String(existing.staticRows[r][0] || '').trim();
    const type = String(existing.staticRows[r][3] || '').trim();

    const saved = taskId
      ? existing.progress.get(taskId)
      : null;

    const values = teams.map(team =>
      saved && saved.has(team.name)
        ? saved.get(team.name)
        : ''
    );

    applyTaskInputRow_(
      sheet,
      r + 2,
      teams,
      type,
      values
    );
  }

  sheet.setFrozenRows(1);
  setColumnWidths_(
    sheet,
    [105, 210, 420, 105, 90, ...teams.map(() => 105)]
  );
}


function syncPuzzlesLayout_(ss, teams, preserveCompletions) {
  const sheet = requireSheet_(ss, GAME.sheets.puzzles);
  const existing = readExistingPuzzles_(sheet);

  if (!preserveCompletions) {
    existing.completions = new Map();
  }

  const rowCapacity = Math.max(
    100,
    existing.staticRows.length + 20
  );

  const headers = GAME.puzzleHeaders.concat(
    teams.map(team => team.name)
  );

  ensureSheetSize_(sheet, rowCapacity + 1, headers.length);
  sheet.clear();

  setPlainTextColumns_(sheet, 2, rowCapacity, [1, 2]);
  setNumberFormatColumns_(sheet, 2, rowCapacity, [3, 4], '0.000000');
  setNumberFormatColumns_(sheet, 2, rowCapacity, [5], '0');

  if (teams.length) {
    sheet
      .getRange(2, 6, rowCapacity, teams.length)
      .setNumberFormat('General');
  }

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

  if (existing.staticRows.length) {
    sheet
      .getRange(2, 1, existing.staticRows.length, 5)
      .setValues(existing.staticRows);
  }

  styleBaseSheet_(sheet);
  styleHeader_(sheet.getRange(1, 1, 1, 5), GAME.colors.navy);

  teams.forEach((team, i) => {
    styleTeamHeader_(sheet.getRange(1, 6 + i), team);
  });

  sheet
    .getRange(2, 1, rowCapacity, 5)
    .setBackground(GAME.colors.input);

  sheet
    .getRange(2, 3, rowCapacity, 1)
    .setNumberFormat('0.000000')
    .setDataValidation(
      SpreadsheetApp
        .newDataValidation()
        .requireNumberBetween(-90, 90)
        .setAllowInvalid(false)
        .build()
    );

  sheet
    .getRange(2, 4, rowCapacity, 1)
    .setNumberFormat('0.000000')
    .setDataValidation(
      SpreadsheetApp
        .newDataValidation()
        .requireNumberBetween(-180, 180)
        .setAllowInvalid(false)
        .build()
    );

  sheet.getRange(2, 5, rowCapacity, 1).setNumberFormat('0');

  if (teams.length) {
    const teamRange = sheet.getRange(
      2, 6, rowCapacity, teams.length
    );

    teamRange
      .setBackground(GAME.colors.input)
      .setNumberFormat('General')
      .insertCheckboxes()
      .uncheck();

    const checkboxValues = [];

    for (let r = 0; r < rowCapacity; r++) {
      const puzzleId =
        r < existing.staticRows.length
          ? String(existing.staticRows[r][0] || '').trim()
          : '';

      checkboxValues.push(
        teams.map(team =>
          Boolean(
            puzzleId &&
            existing.completions.get(puzzleId)?.get(team.name)
          )
        )
      );
    }

    teamRange.setValues(checkboxValues);
  }

  sheet.setFrozenRows(1);
  setColumnWidths_(
    sheet,
    [105, 300, 110, 110, 90, ...teams.map(() => 105)]
  );
}


/**
 * Configure the team-input cells for task rows whose Type was just edited.
 * Changing task type deliberately clears progress on those rows because a
 * checkbox and a repeat count have different meanings.
 */
function configureTaskInputRows_(ss, teams, editedRange) {
  if (!teams.length) return;

  const sheet = requireSheet_(ss, GAME.sheets.tasks);
  const firstRow = Math.max(2, editedRange.getRow());
  const lastRow = Math.max(firstRow, editedRange.getLastRow());

  const types = sheet
    .getRange(firstRow, 4, lastRow - firstRow + 1, 1)
    .getValues();

  for (let offset = 0; offset < types.length; offset++) {
    applyTaskInputRow_(
      sheet,
      firstRow + offset,
      teams,
      String(types[offset][0] || '').trim(),
      teams.map(() => '')
    );
  }
}


function applyTaskInputRow_(sheet, row, teams, type, savedValues) {
  if (!teams.length) return;

  const range = sheet.getRange(row, 6, 1, teams.length);
  const normalized = String(type || '').trim().toLowerCase();

  range
    .setBackground(GAME.colors.input)
    .clearDataValidations()
    .clearContent();

  if (normalized === 'one-time') {
    range
      .setNumberFormat('General')
      .insertCheckboxes()
      .uncheck();

    range.setValues([
      savedValues.map(value => value === true)
    ]);
    return;
  }

  if (normalized === 'repeatable') {
    range
      .setNumberFormat('0')
      .setDataValidation(
        SpreadsheetApp
          .newDataValidation()
          .requireNumberGreaterThanOrEqualTo(0)
          .setAllowInvalid(false)
          .build()
      );

    range.setValues([
      savedValues.map(value => {
        if (value === '' || value === null || value === undefined) {
          return '';
        }

        const count = Number(value);
        return Number.isInteger(count) && count >= 0 ? count : '';
      })
    ]);
  }
}


function editTouchesTaskType_(range) {
  return (
    range.getLastColumn() >= 4 &&
    range.getColumn() <= 4
  );
}

function syncScoreboardLayout_(ss, teams) {
  const sheet = requireSheet_(ss, GAME.sheets.scoreboard);

  ensureSheetSize_(
    sheet,
    Math.max(teams.length + 1, 2),
    GAME.scoreHeaders.length
  );

  sheet.clear();

  const rows = teams.map(team => [
    team.name, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0,
  ]);

  if (rows.length) {
    setPlainTextColumns_(sheet, 2, rows.length, [1]);
    sheet
      .getRange(2, 2, rows.length, GAME.scoreHeaders.length - 1)
      .setNumberFormat('0');
  }

  sheet
    .getRange(1, 1, 1, GAME.scoreHeaders.length)
    .setValues([GAME.scoreHeaders]);

  if (rows.length) {
    sheet
      .getRange(2, 1, rows.length, GAME.scoreHeaders.length)
      .setValues(rows)
      .setBackground(GAME.colors.output);

    teams.forEach((team, i) => {
      sheet
        .getRange(i + 2, 1)
        .setBackground(team.color)
        .setFontColor(contrastTextColor_(team.color))
        .setFontWeight('bold');
    });
  }

  styleBaseSheet_(sheet);
  styleHeader_(
    sheet.getRange(1, 1, 1, GAME.scoreHeaders.length - 1),
    GAME.colors.navy
  );
  styleHeader_(
    sheet.getRange(1, GAME.scoreHeaders.length),
    GAME.colors.green
  );

  const rules = [];

  if (rows.length) {
    rules.push(
      SpreadsheetApp
        .newConditionalFormatRule()
        .whenNumberLessThan(0)
        .setBackground(GAME.colors.red)
        .setFontColor('#9C0006')
        .setRanges([sheet.getRange(2, 4, rows.length, 1)])
        .build()
    );
  }

  sheet.setConditionalFormatRules(rules);
  sheet.setFrozenRows(1);

  setColumnWidths_(
    sheet,
    [
      145, 110, 115, 115, 90, 105, 105,
      90, 90, 105, 105, 105, 105, 105,
    ]
  );
}


function syncRouteBonusesLayout_(ss, network) {
  const sheet = requireSheet_(ss, GAME.sheets.routeBonuses);
  const existing = readExistingRouteBonusDefinitions_(sheet);
  const rowCapacity = Math.max(100, existing.length + 20);

  ensureSheetSize_(sheet, rowCapacity + 1, 4);
  sheet.clear();

  setPlainTextColumns_(sheet, 2, rowCapacity, [1, 2, 4]);
  setNumberFormatColumns_(sheet, 2, rowCapacity, [3], '0');

  sheet
    .getRange(1, 1, 1, 4)
    .setValues([['City A', 'City B', 'Points', 'Completed by']]);

  if (existing.length) {
    sheet
      .getRange(2, 1, existing.length, 3)
      .setValues(existing);
  }

  styleBaseSheet_(sheet);
  styleHeader_(sheet.getRange(1, 1, 1, 4), GAME.colors.navy);

  sheet
    .getRange(2, 1, rowCapacity, 3)
    .setBackground(GAME.colors.input);

  sheet
    .getRange(2, 4, rowCapacity, 1)
    .setBackground(GAME.colors.output);

  sheet
    .getRange(2, 3, rowCapacity, 1)
    .setNumberFormat('0')
    .setDataValidation(
      SpreadsheetApp
        .newDataValidation()
        .requireNumberGreaterThanOrEqualTo(0)
        .setAllowInvalid(false)
        .build()
    );

  if (network && network.cityNames.length) {
    const cityValidation = SpreadsheetApp
      .newDataValidation()
      .requireValueInList(network.cityNames, true)
      .setAllowInvalid(false)
      .build();

    sheet
      .getRange(2, 1, rowCapacity, 2)
      .setDataValidation(cityValidation);
  }

  sheet.setFrozenRows(1);
  setColumnWidths_(sheet, [170, 170, 85, 260]);
}


function readExistingRouteBonusDefinitions_(sheet) {
  if (sheet.getLastRow() < 2) return [];

  return sheet
    .getRange(2, 1, sheet.getLastRow() - 1, 3)
    .getValues()
    .filter(row =>
      row.some(value => String(value ?? '').trim() !== '')
    );
}


function clearRouteBonusCompletion_(ss) {
  const sheet = requireSheet_(ss, GAME.sheets.routeBonuses);

  if (sheet.getLastRow() >= 2) {
    sheet
      .getRange(2, 4, sheet.getLastRow() - 1, 1)
      .clearContent();
  }
}

// =============================================================================
// Fast edit paths
// =============================================================================

function updateOwnershipScoring_(ss, forceGraph) {
  const teams = getTeams_(ss);
  const network = getNetworkOptional_(ss);

  if (!network) return;

  const current = readScoreboardState_(ss, teams);

  if (!current) {
    recalculateAll_(ss);
    return;
  }

  const config = getConfig_(ss);

  // Always reconcile deposits and ownership from the CURRENT sheet state.
  // This keeps the calculation self-healing if Google drops an intermediate
  // onEdit event during a burst of rapid edits.
  const snapshot = readOwnershipSnapshot_(
    ss,
    teams,
    network
  );

  for (const team of teams) {
    const stats = current.get(team.name);
    const update = snapshot.stats.get(team.name);

    stats.ticketsDeposited = update.ticketsDeposited;
    stats.stopsOwned = update.stopsOwned;
    stats.stopPoints = update.stopPoints;
    stats.mostStopsBonus = 0;
  }

  // Only graph-dependent values need a traversal. Losing bids, winning-bid
  // increases, etc. normally leave the owner vector unchanged.
  if (forceGraph || snapshot.ownershipChanged) {
    applyGraphAndRouteMetrics_(
      ss,
      teams,
      network,
      snapshot.owners,
      current
    );
  }

  assignLeaderBonus_(
    teams,
    current,
    'stopsOwned',
    'mostStopsBonus',
    config.mostStopsBonus,
    config.bonusTieRule
  );

  // Repair only generated stop-output rows whose visible result differs from
  // the sheet. For a normal one-cell edit this is usually just one row.
  writeChangedOwnershipRows_(
    snapshot.sheet,
    snapshot.ownerColumn,
    snapshot.changedOutputRows
  );

  writeScoreboardValues_(ss, teams, current, config);
}

function updateTaskPuzzleScoring_(ss) {
  const teams = getTeams_(ss);
  const current = readScoreboardState_(ss, teams);

  if (!current) {
    recalculateAll_(ss);
    return;
  }

  const config = getConfig_(ss);
  const taskPuzzle = computeTaskPuzzleMetrics_(ss, teams);

  for (const team of teams) {
    const stats = current.get(team.name);
    const update = taskPuzzle.get(team.name);

    stats.ticketsEarned = update.ticketsEarned;
    stats.tasksCompleted = update.tasksCompleted;
    stats.puzzlesCompleted = update.puzzlesCompleted;
    stats.mostTasksBonus = 0;
    stats.mostPuzzlesBonus = 0;
  }

  assignLeaderBonus_(
    teams,
    current,
    'tasksCompleted',
    'mostTasksBonus',
    config.mostTasksBonus,
    config.bonusTieRule
  );

  assignLeaderBonus_(
    teams,
    current,
    'puzzlesCompleted',
    'mostPuzzlesBonus',
    config.mostPuzzlesBonus,
    config.bonusTieRule
  );

  writeScoreboardValues_(ss, teams, current, config);
}


function recalculateAll_(ss) {
  const teams = getTeams_(ss);
  const config = getConfig_(ss);
  const network = getNetworkOptional_(ss);

  const stats = createEmptyStats_(teams);
  const taskPuzzle = computeTaskPuzzleMetrics_(ss, teams);

  for (const team of teams) {
    Object.assign(stats.get(team.name), taskPuzzle.get(team.name));
  }

  if (network) {
    const ownership = computeOwnershipMetrics_(
      ss, teams, network, true
    );

    for (const team of teams) {
      const target = stats.get(team.name);
      const source = ownership.stats.get(team.name);

      target.ticketsDeposited = source.ticketsDeposited;
      target.stopsOwned = source.stopsOwned;
      target.stopPoints = source.stopPoints;
      target.linePoints = source.linePoints;
      target.routeBonus = source.routeBonus;
    }

  } else {
    clearRouteBonusCompletion_(ss);
  }

  assignLeaderBonus_(
    teams, stats,
    'stopsOwned', 'mostStopsBonus',
    config.mostStopsBonus, config.bonusTieRule
  );

  assignLeaderBonus_(
    teams, stats,
    'tasksCompleted', 'mostTasksBonus',
    config.mostTasksBonus, config.bonusTieRule
  );

  assignLeaderBonus_(
    teams, stats,
    'puzzlesCompleted', 'mostPuzzlesBonus',
    config.mostPuzzlesBonus, config.bonusTieRule
  );

  writeScoreboardValues_(ss, teams, stats, config);
}


// =============================================================================
// Ownership / graph / route-bonus scoring
// =============================================================================

function computeOwnershipMetrics_(
  ss,
  teams,
  network,
  writeOwners
) {
  const snapshot = readOwnershipSnapshot_(
    ss,
    teams,
    network
  );

  const routeBonusOutput = applyGraphAndRouteMetrics_(
    ss,
    teams,
    network,
    snapshot.owners,
    snapshot.stats
  );

  if (writeOwners) {
    writeChangedOwnershipRows_(
      snapshot.sheet,
      snapshot.ownerColumn,
      snapshot.changedOutputRows
    );
  }

  return {
    stats: snapshot.stats,
    owners: snapshot.owners,
    routeBonusOutput,
  };
}


/**
 * Read the current Stop Deposits state and calculate every stop owner.
 *
 * The whole calculation is based on current sheet values; it never applies
 * oldValue/newValue deltas from an edit event.
 *
 * We also compare the newly calculated output with the generated Owner /
 * Winning-deposit columns. That comparison determines whether graph-dependent
 * scoring can safely be skipped.
 */
function readOwnershipSnapshot_(ss, teams, network) {
  const sheet = requireSheet_(ss, GAME.sheets.stops);
  const headers = getHeaderMap_(sheet);

  for (const header of GAME.stopHeaders) {
    if (!headers.has(header)) {
      throw new Error(
        'Stop Deposits is not synchronized for the installed network.'
      );
    }
  }

  const ownerIndex = headers.get('Owner');
  const winningIndex = headers.get('Winning deposit');

  if (ownerIndex === undefined || winningIndex === undefined) {
    throw new Error(
      'Stop Deposits is missing ownership output columns.'
    );
  }

  const firstDepositIndex = GAME.stopHeaders.length;
  const expectedOwnerIndex = firstDepositIndex + teams.length;

  if (
    ownerIndex !== expectedOwnerIndex ||
    winningIndex !== expectedOwnerIndex + 1
  ) {
    throw new Error(
      'Stop Deposits has an unexpected team-column layout. ' +
      'Edit Teams to rebuild it.'
    );
  }

  if (sheet.getLastRow() - 1 !== network.stopIds.length) {
    throw new Error(
      'Stop Deposits does not match the installed network. Edit Teams or ' +
      'replace the network through the control panel to rebuild it.'
    );
  }

  // One contiguous read keeps Spreadsheet-service overhead low. Static stop
  // fields are included only because stop_id makes this robust to users
  // sorting the Stop Deposits rows.
  const values = sheet
    .getRange(
      2,
      1,
      network.stopIds.length,
      winningIndex + 1
    )
    .getValues();

  const indexByStopId = new Map(
    network.stopIds.map((id, i) => [id, i])
  );

  const teamNameSet = new Set(
    teams.map(team => team.name)
  );

  const owners = Array(network.stopIds.length).fill('');
  const stats = createEmptyStats_(teams);
  const changedOutputRows = [];
  let ownershipChanged = false;

  for (let rowOffset = 0; rowOffset < values.length; rowOffset++) {
    const row = values[rowOffset];
    const stopId = String(
      row[headers.get('stop_id')] || ''
    ).trim();

    const stopIndex = indexByStopId.get(stopId);

    if (stopIndex === undefined) {
      throw new Error(
        `Stop Deposits contains unknown stop_id "${stopId}".`
      );
    }

    const deposits = [];

    for (let i = 0; i < teams.length; i++) {
      const raw = row[firstDepositIndex + i];

      if (
        raw === '' ||
        raw === null ||
        raw === undefined
      ) {
        deposits.push(0);
        continue;
      }

      const value = Number(raw);

      if (!Number.isFinite(value) || value < 0) {
        throw new Error(
          `Invalid deposit at row ${rowOffset + 2}, ` +
          `${teams[i].name}.`
        );
      }

      deposits.push(value);
      stats.get(teams[i].name).ticketsDeposited += value;
    }

    const ownership = calculateStopOwnership_(
      teams,
      deposits
    );

    owners[stopIndex] = ownership.owner;

    if (ownership.owner) {
      const teamStats = stats.get(ownership.owner);
      teamStats.stopsOwned += 1;
      teamStats.stopPoints += network.lineCounts[stopIndex];
    }

    const previousDisplay = String(
      row[ownerIndex] || ''
    ).trim();

    const previousOwner = teamNameSet.has(previousDisplay)
      ? previousDisplay
      : '';

    if (previousOwner !== ownership.owner) {
      ownershipChanged = true;
    }

    const nextWinning = ownership.maxDeposit > 0
      ? ownership.maxDeposit
      : '';

    if (
      previousDisplay !== ownership.display ||
      !sameSheetScalar_(row[winningIndex], nextWinning)
    ) {
      changedOutputRows.push({
        row: rowOffset + 2,
        values: [ownership.display, nextWinning],
      });
    }
  }

  return {
    sheet,
    ownerColumn: ownerIndex + 1,
    stats,
    owners,
    ownershipChanged,
    changedOutputRows,
  };
}


/**
 * Compute the metrics that genuinely depend on graph connectivity and route
 * definitions. The same component traversal feeds Line points and all Route
 * Bonuses.
 */
function applyGraphAndRouteMetrics_(
  ss,
  teams,
  network,
  owners,
  stats
) {
  for (const team of teams) {
    stats.get(team.name).linePoints = 0;
    stats.get(team.name).routeBonus = 0;
  }

  const components = analyzeOwnedComponents_(
    teams,
    owners,
    buildAdjacency_(network),
    network.stopCities
  );

  for (const team of teams) {
    stats.get(team.name).linePoints =
      components.get(team.name).largestSize;
  }

  const routeBonuses = readRouteBonusDefinitions_(
    ss,
    network
  );

  for (const route of routeBonuses.routes) {
    if (!route.valid) continue;

    const completedBy = [];

    for (const team of teams) {
      const completed = components
        .get(team.name)
        .components
        .some(component =>
          component.cities.has(route.cityA) &&
          component.cities.has(route.cityB)
        );

      if (completed) {
        completedBy.push(team.name);
        stats.get(team.name).routeBonus += route.points;
      }
    }

    routeBonuses.output[route.offset][0] =
      completedBy.join(', ');
  }

  writeRouteBonusValues_(ss, routeBonuses);
  return routeBonuses;
}


function calculateStopOwnership_(teams, deposits) {
  const maxDeposit = Math.max(...deposits);
  let owner = '';
  let display = '';

  if (maxDeposit > 0) {
    let winnerIndex = -1;
    let winnerCount = 0;

    for (let i = 0; i < deposits.length; i++) {
      if (deposits[i] === maxDeposit) {
        winnerIndex = i;
        winnerCount += 1;
      }
    }

    if (winnerCount === 1) {
      owner = teams[winnerIndex].name;
      display = owner;
    } else {
      display = 'TIE';
    }
  }

  return {
    owner,
    display,
    maxDeposit,
  };
}


/**
 * Write only changed Owner/Winning-deposit rows.
 *
 * Consecutive changed rows are grouped into one setValues() call, so a rare
 * catch-up after missed events still avoids one service call per row.
 */
function writeChangedOwnershipRows_(
  sheet,
  ownerColumn,
  changedRows
) {
  if (!changedRows.length) return;

  let groupStart = 0;

  while (groupStart < changedRows.length) {
    let groupEnd = groupStart;

    while (
      groupEnd + 1 < changedRows.length &&
      changedRows[groupEnd + 1].row ===
        changedRows[groupEnd].row + 1
    ) {
      groupEnd += 1;
    }

    const group = changedRows.slice(
      groupStart,
      groupEnd + 1
    );

    sheet
      .getRange(
        group[0].row,
        ownerColumn,
        group.length,
        2
      )
      .setValues(
        group.map(item => item.values)
      );

    groupStart = groupEnd + 1;
  }
}


function sameSheetScalar_(a, b) {
  if (
    (a === '' || a === null || a === undefined) &&
    (b === '' || b === null || b === undefined)
  ) {
    return true;
  }

  if (
    typeof a === 'number' ||
    typeof b === 'number'
  ) {
    return Number(a) === Number(b);
  }

  return String(a) === String(b);
}

function buildAdjacency_(network) {
  const adjacency = Array.from(
    {length: network.stopIds.length},
    () => []
  );

  for (const edge of network.edges) {
    adjacency[edge[0]].push(edge[1]);
    adjacency[edge[1]].push(edge[0]);
  }

  return adjacency;
}


/**
 * Find every connected component of owned stops in one graph traversal.
 *
 * For each team we retain:
 *   - largestSize: used directly for Line points;
 *   - components[].cities: used by every Route Bonus definition.
 *
 * Because ownership partitions the graph, this is O(V + E) overall rather
 * than running a separate graph search for every route or every team.
 */
function analyzeOwnedComponents_(teams, owners, adjacency, stopCities) {
  const result = new Map();

  for (const team of teams) {
    result.set(team.name, {
      largestSize: 0,
      components: [],
    });
  }

  const visited = new Uint8Array(owners.length);

  for (let start = 0; start < owners.length; start++) {
    const owner = owners[start];

    if (!owner || visited[start]) continue;

    let size = 0;
    const cities = new Set();
    const stack = [start];
    visited[start] = 1;

    while (stack.length) {
      const node = stack.pop();
      size += 1;

      const city = stopCities[node];
      if (city) cities.add(city);

      for (const neighbor of adjacency[node]) {
        if (
          !visited[neighbor] &&
          owners[neighbor] === owner
        ) {
          visited[neighbor] = 1;
          stack.push(neighbor);
        }
      }
    }

    const teamResult = result.get(owner);

    if (!teamResult) continue;

    teamResult.components.push({size, cities});
    if (size > teamResult.largestSize) {
      teamResult.largestSize = size;
    }
  }

  return result;
}


function readRouteBonusDefinitions_(ss, network) {
  const sheet = requireSheet_(ss, GAME.sheets.routeBonuses);
  const headers = getHeaderMap_(sheet);

  for (const header of ['City A', 'City B', 'Points', 'Completed by']) {
    if (!headers.has(header)) {
      throw new Error('Route Bonuses has an invalid layout.');
    }
  }

  if (sheet.getLastRow() < 2) {
    return {routes: [], output: [], rowCount: 0};
  }

  const rowCount = sheet.getLastRow() - 1;
  const rows = sheet
    .getRange(2, 1, rowCount, 3)
    .getValues();

  const validCities = new Set(network.cityNames);
  const routes = [];
  const output = Array.from({length: rowCount}, () => ['']);

  rows.forEach((row, offset) => {
    const cityA = String(row[0] || '').trim();
    const cityB = String(row[1] || '').trim();
    const rawPoints = row[2];

    if (!cityA && !cityB && String(rawPoints ?? '').trim() === '') {
      return;
    }

    const points = Number(rawPoints);
    let valid = true;
    let status = '';

    if (
      !cityA ||
      !cityB ||
      String(rawPoints ?? '').trim() === ''
    ) {
      valid = false;
      status = 'INCOMPLETE DEFINITION';
    } else if (cityA === cityB) {
      valid = false;
      status = 'INVALID: SAME CITY';
    } else if (!validCities.has(cityA) || !validCities.has(cityB)) {
      valid = false;
      status = 'INVALID CITY';
    } else if (!Number.isFinite(points) || points < 0) {
      valid = false;
      status = 'INVALID POINTS';
    }

    if (!valid) {
      output[offset][0] = status;
    }

    routes.push({
      offset,
      cityA,
      cityB,
      points: valid ? points : 0,
      valid,
    });
  });

  return {routes, output, rowCount};
}


// =============================================================================
// Tasks / puzzles / scoreboard
// =============================================================================

function computeTaskPuzzleMetrics_(ss, teams) {
  const stats = createEmptyStats_(teams);

  addTaskMetrics_(ss, teams, stats);
  addPuzzleMetrics_(ss, teams, stats);

  return stats;
}


function addTaskMetrics_(ss, teams, stats) {
  const sheet = requireSheet_(ss, GAME.sheets.tasks);

  if (sheet.getLastRow() < 2) return;

  const headers = getHeaderMap_(sheet);

  for (const header of GAME.taskHeaders) {
    if (!headers.has(header)) {
      throw new Error('Tasks has an invalid layout.');
    }
  }

  const teamColumns = teams.map(team => {
    const index = headers.get(team.name);

    if (index === undefined) {
      throw new Error(`Tasks is missing team "${team.name}".`);
    }

    return index;
  });

  const lastColumn = Math.max(
    headers.get('tickets'),
    ...teamColumns
  ) + 1;

  const rows = sheet
    .getRange(
      2, 1,
      sheet.getLastRow() - 1,
      lastColumn
    )
    .getValues();

  const seenIds = new Set();

  for (let rowOffset = 0; rowOffset < rows.length; rowOffset++) {
    const row = rows[rowOffset];
    const taskId = cellString_(row, headers.get('task_id'));

    if (!taskId) continue;

    if (seenIds.has(taskId)) {
      throw new Error(`Duplicate task_id "${taskId}".`);
    }
    seenIds.add(taskId);

    const type = cellString_(
      row,
      headers.get('type')
    ).toLowerCase();

    // A partially drafted task simply does not score yet.
    if (type !== 'one-time' && type !== 'repeatable') {
      continue;
    }

    const rawTickets = row[headers.get('tickets')];
    const ticketValue =
      rawTickets === '' || rawTickets === null
        ? 0
        : Number(rawTickets);

    if (!Number.isFinite(ticketValue) || ticketValue < 0) {
      throw new Error(
        `Invalid task ticket value at row ${rowOffset + 2}.`
      );
    }

    teams.forEach((team, i) => {
      const teamStats = stats.get(team.name);
      const value = row[teamColumns[i]];

      if (type === 'one-time') {
        if (value !== true) return;

        teamStats.ticketsEarned += ticketValue;
        teamStats.tasksCompleted += 1;
        return;
      }

      if (
        value === '' ||
        value === null ||
        value === undefined
      ) {
        return;
      }

      const count = Number(value);

      if (!Number.isInteger(count) || count < 0) {
        throw new Error(
          `Repeatable task count must be a non-negative integer at ` +
          `row ${rowOffset + 2}, ${team.name}.`
        );
      }

      teamStats.ticketsEarned += ticketValue * count;

      // A repeatable task contributes at most one task to the global
      // "most tasks completed" metric, regardless of how many repeats.
      if (count > 0) {
        teamStats.tasksCompleted += 1;
      }
    });
  }
}


function addPuzzleMetrics_(ss, teams, stats) {
  const sheet = requireSheet_(ss, GAME.sheets.puzzles);

  if (sheet.getLastRow() < 2) return;

  const headers = getHeaderMap_(sheet);

  for (const header of GAME.puzzleHeaders) {
    if (!headers.has(header)) {
      throw new Error('Puzzles has an invalid layout.');
    }
  }

  const teamColumns = teams.map(team => {
    const index = headers.get(team.name);

    if (index === undefined) {
      throw new Error(`Puzzles is missing team "${team.name}".`);
    }

    return index;
  });

  const lastColumn = Math.max(
    headers.get('tickets'),
    ...teamColumns
  ) + 1;

  const rows = sheet
    .getRange(
      2, 1,
      sheet.getLastRow() - 1,
      lastColumn
    )
    .getValues();

  const seenIds = new Set();

  for (let rowOffset = 0; rowOffset < rows.length; rowOffset++) {
    const row = rows[rowOffset];
    const puzzleId = cellString_(row, headers.get('puzzle_id'));

    if (!puzzleId) continue;

    if (seenIds.has(puzzleId)) {
      throw new Error(`Duplicate puzzle_id "${puzzleId}".`);
    }
    seenIds.add(puzzleId);

    const rawTickets = row[headers.get('tickets')];
    const ticketValue =
      rawTickets === '' || rawTickets === null
        ? 0
        : Number(rawTickets);

    if (!Number.isFinite(ticketValue) || ticketValue < 0) {
      throw new Error(
        `Invalid puzzle ticket value at row ${rowOffset + 2}.`
      );
    }

    teams.forEach((team, i) => {
      if (row[teamColumns[i]] !== true) return;

      const teamStats = stats.get(team.name);
      teamStats.ticketsEarned += ticketValue;
      teamStats.puzzlesCompleted += 1;
    });
  }
}

function createEmptyStats_(teams) {
  const map = new Map();

  for (const team of teams) {
    map.set(team.name, {
      ticketsEarned: 0,
      ticketsDeposited: 0,
      stopsOwned: 0,
      tasksCompleted: 0,
      puzzlesCompleted: 0,
      stopPoints: 0,
      linePoints: 0,
      routeBonus: 0,
      mostStopsBonus: 0,
      mostTasksBonus: 0,
      mostPuzzlesBonus: 0,
    });
  }

  return map;
}


function readScoreboardState_(ss, teams) {
  const sheet = requireSheet_(ss, GAME.sheets.scoreboard);
  const headers = getHeaderMap_(sheet);

  for (const header of GAME.scoreHeaders) {
    if (!headers.has(header)) return null;
  }

  if (sheet.getLastRow() - 1 !== teams.length) {
    return null;
  }

  const rows = sheet
    .getRange(
      2, 1,
      teams.length,
      GAME.scoreHeaders.length
    )
    .getValues();

  const map = new Map();

  for (const row of rows) {
    const name = String(row[0] || '').trim();
    if (!name) return null;

    map.set(name, {
      ticketsEarned: numberOrZero_(row[1]),
      ticketsDeposited: numberOrZero_(row[2]),
      stopsOwned: numberOrZero_(row[4]),
      tasksCompleted: numberOrZero_(row[5]),
      puzzlesCompleted: numberOrZero_(row[6]),
      stopPoints: numberOrZero_(row[7]),
      linePoints: numberOrZero_(row[8]),
      routeBonus: numberOrZero_(row[9]),
      mostStopsBonus: numberOrZero_(row[10]),
      mostTasksBonus: numberOrZero_(row[11]),
      mostPuzzlesBonus: numberOrZero_(row[12]),
    });
  }

  if (teams.some(team => !map.has(team.name))) return null;

  return map;
}


function writeScoreboardValues_(ss, teams, stats, config) {
  const sheet = requireSheet_(ss, GAME.sheets.scoreboard);

  if (
    sheet.getLastRow() - 1 !== teams.length ||
    sheet.getLastColumn() < GAME.scoreHeaders.length
  ) {
    syncScoreboardLayout_(ss, teams);
  }

  const rows = teams.map(team => {
    const s = stats.get(team.name);

    const total =
      s.stopPoints +
      s.linePoints +
      s.routeBonus +
      s.mostStopsBonus +
      s.mostTasksBonus +
      s.mostPuzzlesBonus;

    return [
      team.name,
      s.ticketsEarned,
      s.ticketsDeposited,
      config.startingTickets +
        s.ticketsEarned -
        s.ticketsDeposited,
      s.stopsOwned,
      s.tasksCompleted,
      s.puzzlesCompleted,
      s.stopPoints,
      s.linePoints,
      s.routeBonus,
      s.mostStopsBonus,
      s.mostTasksBonus,
      s.mostPuzzlesBonus,
      total,
    ];
  });

  if (rows.length) {
    sheet
      .getRange(2, 1, rows.length, GAME.scoreHeaders.length)
      .setValues(rows);

    refreshStopDepositTeamHeaders_(
      ss,
      teams,
      rows.map(row => row[3])
    );
  }

  // The public web app serves a cached snapshot. Any successful scoring write
  // can affect player-visible state, so invalidate that snapshot here rather
  // than duplicating invalidation calls across every edit path.
  clearPublicStateCache_();
}


/**
 * Show each team's currently available tickets directly in Stop Deposits,
 * e.g. "Team 1 (12)".
 *
 * A header note stores the canonical team name so the display label can
 * change every edit without affecting deposit preservation or scoring.
 */
function refreshStopDepositTeamHeaders_(
  ss,
  teams,
  availableTickets
) {
  const sheet = requireSheet_(ss, GAME.sheets.stops);
  const firstColumn = GAME.stopHeaders.length + 1;

  if (
    sheet.getLastColumn() <
      firstColumn + teams.length + 1
  ) {
    return;
  }

  const labels = teams.map((team, i) => {
    const value = Number(availableTickets[i]);
    const shown = Number.isFinite(value)
      ? formatTicketBalance_(value)
      : '0';

    return `${team.name} (${shown})`;
  });

  const range = sheet.getRange(
    1,
    firstColumn,
    1,
    teams.length
  );

  range.setValues([labels]);
}


function formatTicketBalance_(value) {
  if (Number.isInteger(value)) {
    return String(value);
  }

  return String(
    Math.round(value * 100) / 100
  );
}


function writeRouteBonusValues_(ss, routeBonusOutput) {
  const sheet = requireSheet_(ss, GAME.sheets.routeBonuses);

  if (!routeBonusOutput.rowCount) {
    clearRouteBonusCompletion_(ss);
    return;
  }

  sheet
    .getRange(2, 4, routeBonusOutput.rowCount, 1)
    .setValues(routeBonusOutput.output);
}

function assignLeaderBonus_(
  teams,
  stats,
  metricKey,
  bonusKey,
  bonusValue,
  tieRule
) {
  for (const team of teams) {
    stats.get(team.name)[bonusKey] = 0;
  }

  if (bonusValue <= 0) return;

  const maxValue = Math.max(
    ...teams.map(team => stats.get(team.name)[metricKey])
  );

  if (maxValue <= 0) return;

  const leaders = teams.filter(
    team => stats.get(team.name)[metricKey] === maxValue
  );

  if (
    leaders.length > 1 &&
    tieRule !== 'All tied leaders'
  ) {
    return;
  }

  for (const team of leaders) {
    stats.get(team.name)[bonusKey] = bonusValue;
  }
}


// =============================================================================
// Reset
// =============================================================================

function clearProgress_(ss, teams) {
  const stops = requireSheet_(ss, GAME.sheets.stops);

  if (
    stops.getLastRow() >= 2 &&
    teams.length
  ) {
    stops
      .getRange(
        2,
        GAME.stopHeaders.length + 1,
        stops.getLastRow() - 1,
        teams.length
      )
      .clearContent();
  }

  const tasks = requireSheet_(ss, GAME.sheets.tasks);

  if (tasks.getLastRow() >= 2 && teams.length) {
    const rowCount = tasks.getLastRow() - 1;
    const types = tasks
      .getRange(2, 4, rowCount, 1)
      .getValues();

    for (let r = 0; r < rowCount; r++) {
      const teamRange = tasks.getRange(
        r + 2,
        6,
        1,
        teams.length
      );

      const type = String(types[r][0] || '')
        .trim()
        .toLowerCase();

      if (type === 'one-time') {
        teamRange.uncheck();
      } else {
        teamRange.clearContent();
      }
    }
  }

  const puzzles = requireSheet_(ss, GAME.sheets.puzzles);

  if (puzzles.getLastRow() >= 2 && teams.length) {
    puzzles
      .getRange(
        2,
        6,
        puzzles.getLastRow() - 1,
        teams.length
      )
      .uncheck();
  }
}


// =============================================================================
// Teams / Config
// =============================================================================

function getTeams_(ss) {
  const sheet = requireSheet_(ss, GAME.sheets.teams);
  const rowCount = Math.max(sheet.getLastRow() - 1, 1);

  const values = sheet
    .getRange(2, 1, rowCount, 2)
    .getValues();

  const teams = [];
  const seen = new Set();

  for (const row of values) {
    const name = String(row[0] || '').trim();
    if (!name) continue;

    if (seen.has(name)) {
      throw new Error(`Duplicate team name "${name}".`);
    }
    seen.add(name);

    let color = String(row[1] || '').trim();

    if (!/^#[0-9A-Fa-f]{6}$/.test(color)) {
      color = GAME.defaultColors[
        teams.length % GAME.defaultColors.length
      ];
    }

    teams.push({name, color});
  }

  if (!teams.length) {
    throw new Error('Add at least one team on the Teams sheet.');
  }

  return teams;
}


function getConfig_(ss) {
  const sheet = requireSheet_(ss, GAME.sheets.config);
  const values = sheet
    .getRange(
      2, 1,
      Math.max(sheet.getLastRow() - 1, 1),
      2
    )
    .getValues();

  const map = new Map();

  for (const row of values) {
    const key = String(row[0] || '').trim();
    if (key) map.set(key, row[1]);
  }

  const numeric = (key, fallback) => {
    const value = Number(map.get(key));
    return Number.isFinite(value) ? value : fallback;
  };

  return {
    startingTickets: Math.max(
      0,
      numeric('Starting tickets', 0)
    ),
    mostStopsBonus: Math.max(
      0,
      numeric('Most stops bonus', 0)
    ),
    mostTasksBonus: Math.max(
      0,
      numeric('Most tasks bonus', 0)
    ),
    mostPuzzlesBonus: Math.max(
      0,
      numeric('Most puzzles bonus', 0)
    ),
    bonusTieRule: String(
      map.get('Bonus tie rule') || 'All tied leaders'
    ).trim(),
  };
}


// =============================================================================
// Network source table helpers / replacement validation
// =============================================================================

function validateImportedNetwork_(stopsTable, lineStopsTable) {
  const stops = normalizeTable_(stopsTable, 'Stop Data');
  const lines = normalizeTable_(lineStopsTable, 'Route Data');

  const stopHeaders = headerMapFromRow_(stops[0]);
  const lineHeaders = headerMapFromRow_(lines[0]);

  requireImportedHeaders_(
    stopHeaders,
    [
      'stop_id', 'stop_name', 'city', 'name',
      'longitude', 'latitude',
      'num_lines', 'line_ids', 'line_refs',
      'name_source_agency', 'source_agencies',
      'source_stop_ids', 'source_stop_names',
    ],
    'Stop Data'
  );

  requireImportedHeaders_(
    lineHeaders,
    [
      'line_id', 'line_ref', 'line_name', 'agency_id',
      'route_id', 'variant_id', 'shape_id', 'headsign',
      'trip_count', 'stop_order', 'stop_id', 'stop_name',
      'distance_to_shape_m', 'is_loop_closure',
    ],
    'Route Data'
  );

  const stopIds = new Set();

  for (let i = 1; i < stops.length; i++) {
    const row = stops[i];

    const stopId = importedCellString_(
      row,
      stopHeaders.get('stop_id')
    );

    const stopName = importedCellString_(
      row,
      stopHeaders.get('stop_name')
    );

    if (!stopId && !stopName) continue;

    if (!stopId || !stopName) {
      throw new Error(
        `Stop Data row ${i + 1} is missing stop_id or stop_name.`
      );
    }

    if (stopIds.has(stopId)) {
      throw new Error(
        `Duplicate stop_id "${stopId}" in Stop Data row ${i + 1}.`
      );
    }

    const longitude = Number(row[stopHeaders.get('longitude')]);
    const latitude = Number(row[stopHeaders.get('latitude')]);

    if (
      !Number.isFinite(longitude) ||
      !Number.isFinite(latitude)
    ) {
      throw new Error(
        `Stop Data row ${i + 1} has invalid coordinates.`
      );
    }

    stopIds.add(stopId);
  }

  if (!stopIds.size) {
    throw new Error('Stop Data contains no stops.');
  }

  const lineIds = new Set();
  const variantIds = new Set();
  const variantToLine = new Map();
  const lineMeta = new Map();
  const ordersByVariant = new Map();

  for (let i = 1; i < lines.length; i++) {
    const row = lines[i];

    const lineId = importedCellString_(
      row,
      lineHeaders.get('line_id')
    );

    const lineRef = importedCellString_(
      row,
      lineHeaders.get('line_ref')
    );

    const lineName = importedCellString_(
      row,
      lineHeaders.get('line_name')
    );

    const agencyId = importedCellString_(
      row,
      lineHeaders.get('agency_id')
    );

    const variantId = importedCellString_(
      row,
      lineHeaders.get('variant_id')
    );

    const stopId = importedCellString_(
      row,
      lineHeaders.get('stop_id')
    );

    const stopOrder = Number(
      row[lineHeaders.get('stop_order')]
    );

    if (!lineId && !variantId && !stopId) continue;

    if (
      !lineId ||
      !lineRef ||
      !lineName ||
      !agencyId ||
      !variantId ||
      !stopId
    ) {
      throw new Error(
        `Route Data row ${i + 1} is missing required route metadata.`
      );
    }

    if (!Number.isFinite(stopOrder) || stopOrder < 1) {
      throw new Error(
        `Route Data row ${i + 1} has an invalid stop_order.`
      );
    }

    if (!stopIds.has(stopId)) {
      throw new Error(
        `Route Data row ${i + 1} references unknown stop_id "${stopId}".`
      );
    }

    if (
      variantToLine.has(variantId) &&
      variantToLine.get(variantId) !== lineId
    ) {
      throw new Error(
        `variant_id "${variantId}" occurs under multiple line_id values.`
      );
    }

    variantToLine.set(variantId, lineId);

    if (!lineMeta.has(lineId)) {
      lineMeta.set(lineId, [lineRef, lineName, agencyId]);
    } else {
      const meta = lineMeta.get(lineId);

      if (
        meta[0] !== lineRef ||
        meta[1] !== lineName ||
        meta[2] !== agencyId
      ) {
        throw new Error(
          `line_id "${lineId}" has inconsistent line metadata.`
        );
      }
    }

    if (!ordersByVariant.has(variantId)) {
      ordersByVariant.set(variantId, new Set());
    }

    if (ordersByVariant.get(variantId).has(stopOrder)) {
      throw new Error(
        `variant_id "${variantId}" contains duplicate stop_order ${stopOrder}.`
      );
    }

    ordersByVariant.get(variantId).add(stopOrder);
    lineIds.add(lineId);
    variantIds.add(variantId);
  }

  if (!lineIds.size) {
    throw new Error('Route Data contains no logical lines.');
  }

  return {
    stopCount: stopIds.size,
    lineCount: lineIds.size,
    variantCount: variantIds.size,
  };
}

function readNetworkStopMetadata_(ss, network) {
  const sheet = requireSheet_(ss, GAME.sheets.networkStops);
  const headers = getHeaderMap_(sheet);

  requireHeaders_(
    headers,
    ['stop_id', 'stop_name', 'city', 'name'],
    GAME.sheets.networkStops
  );

  const values = sheet
    .getRange(
      2, 1,
      sheet.getLastRow() - 1,
      sheet.getLastColumn()
    )
    .getValues();

  const indexByStopId = new Map(
    network.stopIds.map((id, i) => [id, i])
  );

  const result = [];

  for (const row of values) {
    const stopId = cellString_(row, headers.get('stop_id'));
    if (!stopId) continue;

    const index = indexByStopId.get(stopId);

    if (index === undefined) {
      throw new Error(`Unknown Stop Data ID "${stopId}".`);
    }

    const stopName = cellString_(row, headers.get('stop_name'));
    const city = cellString_(row, headers.get('city'));
    const name = cellString_(row, headers.get('name'));

    result.push({
      stopId,
      stopName,
      city,
      name,
      index,
    });
  }

  result.sort((a, b) => naturalCompare_(a.stopName, b.stopName));
  return result;
}


function syncNetworkDerivedColumns_(ss, network) {
  const sheet = requireSheet_(ss, GAME.sheets.networkStops);
  const headers = getHeaderMap_(sheet);

  requireHeaders_(
    headers,
    ['stop_id', 'num_lines', 'line_ids', 'line_refs'],
    GAME.sheets.networkStops
  );

  const indexByStopId = new Map(
    network.stopIds.map((id, i) => [id, i])
  );

  const stopIds = sheet
    .getRange(
      2,
      headers.get('stop_id') + 1,
      sheet.getLastRow() - 1,
      1
    )
    .getValues();

  const counts = [];
  const lineIds = [];
  const lineRefs = [];

  for (const row of stopIds) {
    const stopId = String(row[0] || '').trim();
    const index = indexByStopId.get(stopId);

    counts.push([
      index === undefined ? 0 : network.lineCounts[index]
    ]);

    lineIds.push([
      index === undefined
        ? ''
        : network.lineIdsByStop[index].join(', ')
    ]);

    lineRefs.push([
      index === undefined
        ? ''
        : network.lineRefsByStop[index].join(', ')
    ]);
  }

  const numLinesRange = sheet.getRange(
    2,
    headers.get('num_lines') + 1,
    counts.length,
    1
  );
  numLinesRange
    .setNumberFormat('0')
    .setValues(counts);

  const lineIdsRange = sheet.getRange(
    2,
    headers.get('line_ids') + 1,
    lineIds.length,
    1
  );
  lineIdsRange
    .setNumberFormat('@')
    .setValues(lineIds);

  const lineRefsRange = sheet.getRange(
    2,
    headers.get('line_refs') + 1,
    lineRefs.length,
    1
  );
  lineRefsRange
    .setNumberFormat('@')
    .setValues(lineRefs);

  styleHeader_(
    sheet.getRange(1, 1, 1, sheet.getLastColumn()),
    GAME.colors.navy
  );
}

function writeSourceTable_(sheet, table, isStops) {
  const rows = normalizeTable_(
    table,
    isStops ? 'Stop Data' : 'Route Data'
  );

  ensureSheetSize_(sheet, rows.length, rows[0].length);
  sheet.clear();

  const dataRowCount = Math.max(rows.length - 1, 0);

  if (dataRowCount) {
    if (isStops) {
      // Text/mixed:
      // stop_id, stop_name, city, name, line_ids, line_refs,
      // name_source_agency, source_agencies, source_stop_ids,
      // source_stop_names.
      setPlainTextColumns_(
        sheet,
        2,
        dataRowCount,
        [1, 2, 3, 4, 8, 9, 10, 11, 12, 13]
      );

      // Numeric:
      // longitude, latitude, num_lines.
      setNumberFormatColumns_(sheet, 2, dataRowCount, [5, 6], '0.0000000');
      setNumberFormatColumns_(sheet, 2, dataRowCount, [7], '0');
    } else {
      // Text/identifier:
      // line_id, line_ref, line_name, agency_id, route_id, variant_id,
      // shape_id, headsign, stop_id, stop_name.
      setPlainTextColumns_(
        sheet,
        2,
        dataRowCount,
        [1, 2, 3, 4, 5, 6, 7, 8, 11, 12]
      );

      // Numeric:
      // trip_count, stop_order, distance_to_shape_m, is_loop_closure.
      setNumberFormatColumns_(sheet, 2, dataRowCount, [9, 10, 14], '0');
      setNumberFormatColumns_(sheet, 2, dataRowCount, [13], '0.000');
    }
  }

  sheet
    .getRange(1, 1, rows.length, rows[0].length)
    .setValues(rows)
    .setVerticalAlignment('middle')
    .setWrap(true);

  styleHeader_(
    sheet.getRange(1, 1, 1, rows[0].length),
    GAME.colors.navy
  );

  sheet.setFrozenRows(1);

  setColumnWidths_(
    sheet,
    isStops
      ? [
          330, 275, 140, 220, 105, 105, 80,
          230, 170, 135, 135, 250, 360,
        ]
      : [
          105, 75, 320, 90, 105, 180, 105,
          210, 90, 90, 330, 275, 130, 115,
        ]
  );
}


// =============================================================================
// File import helpers
// =============================================================================

function readDriveCsv_(reference, label) {
  const id = extractGoogleFileId_(reference);

  if (!id) {
    throw new Error(`Could not determine the Drive file ID for ${label}.`);
  }

  let file;
  try {
    file = DriveApp.getFileById(id);
  } catch (_) {
    throw new Error(
      `Could not access ${label}. Check the Drive link/ID and permissions.`
    );
  }

  if (file.getMimeType() === MimeType.GOOGLE_SHEETS) {
    throw new Error(
      `${label} is a Google Sheet. Use the Google Sheet import option instead.`
    );
  }

  return normalizeTable_(
    Utilities.parseCsv(file.getBlob().getDataAsString('UTF-8')),
    file.getName()
  );
}


function extractGoogleFileId_(reference) {
  const value = String(reference || '').trim();

  if (!value) return '';

  if (/^[A-Za-z0-9_-]{20,}$/.test(value)) {
    return value;
  }

  for (const pattern of [
    /\/d\/([A-Za-z0-9_-]{20,})/,
    /[?&]id=([A-Za-z0-9_-]{20,})/,
  ]) {
    const match = value.match(pattern);
    if (match) return match[1];
  }

  return '';
}


// =============================================================================
// Preservation helpers
// =============================================================================

function readExistingDeposits_(sheet) {
  const result = new Map();

  if (sheet.getLastRow() < 2) return result;

  const headerRange = sheet.getRange(
    1,
    1,
    1,
    sheet.getLastColumn()
  );

  const headers = headerRange
    .getValues()[0]
    .map(value => String(value || '').trim());

  const notes = headerRange
    .getNotes()[0]
    .map(value => String(value || '').trim());

  const stopIdIndex = headers.indexOf('stop_id');
  const ownerIndex = headers.indexOf('Owner');

  if (stopIdIndex < 0) return result;

  const start = GAME.stopHeaders.length;
  const end = ownerIndex >= 0
    ? ownerIndex
    : headers.length;

  const teamNames = headers
    .slice(start, end)
    .map((label, i) => {
      const note = notes[start + i];
      return note || label;
    });

  const rows = sheet
    .getRange(
      2,
      1,
      sheet.getLastRow() - 1,
      sheet.getLastColumn()
    )
    .getValues();

  for (const row of rows) {
    const stopId = String(
      row[stopIdIndex] || ''
    ).trim();

    if (!stopId) continue;

    const values = new Map();

    teamNames.forEach((name, i) => {
      if (name) {
        values.set(
          name,
          row[start + i]
        );
      }
    });

    result.set(stopId, values);
  }

  return result;
}

function readExistingTasks_(sheet) {
  const staticRows = [];
  const progress = new Map();

  if (sheet.getLastRow() < 2) {
    return {staticRows, progress};
  }

  const headers = sheet
    .getRange(1, 1, 1, sheet.getLastColumn())
    .getValues()[0]
    .map(value => String(value || '').trim());

  const teamHeaders = headers.slice(GAME.taskHeaders.length);

  const rows = sheet
    .getRange(
      2, 1,
      sheet.getLastRow() - 1,
      sheet.getLastColumn()
    )
    .getValues();

  for (const row of rows) {
    const staticPart = row.slice(0, GAME.taskHeaders.length);

    if (
      !staticPart.some(value => String(value ?? '').trim() !== '')
    ) {
      continue;
    }

    staticRows.push(staticPart);

    const taskId = String(staticPart[0] || '').trim();
    if (!taskId) continue;

    const teamMap = new Map();

    teamHeaders.forEach((name, i) => {
      if (name) {
        teamMap.set(
          name,
          row[GAME.taskHeaders.length + i]
        );
      }
    });

    progress.set(taskId, teamMap);
  }

  return {staticRows, progress};
}


function readExistingPuzzles_(sheet) {
  const staticRows = [];
  const completions = new Map();

  if (sheet.getLastRow() < 2) {
    return {staticRows, completions};
  }

  const headers = sheet
    .getRange(1, 1, 1, sheet.getLastColumn())
    .getValues()[0]
    .map(value => String(value || '').trim());

  const teamHeaders = headers.slice(GAME.puzzleHeaders.length);

  const rows = sheet
    .getRange(
      2, 1,
      sheet.getLastRow() - 1,
      sheet.getLastColumn()
    )
    .getValues();

  for (const row of rows) {
    const staticPart = row.slice(0, GAME.puzzleHeaders.length);

    if (
      !staticPart.some(value => String(value ?? '').trim() !== '')
    ) {
      continue;
    }

    staticRows.push(staticPart);

    const puzzleId = String(staticPart[0] || '').trim();
    if (!puzzleId) continue;

    const teamMap = new Map();

    teamHeaders.forEach((name, i) => {
      if (name) {
        teamMap.set(
          name,
          row[GAME.puzzleHeaders.length + i] === true
        );
      }
    });

    completions.set(puzzleId, teamMap);
  }

  return {staticRows, completions};
}

// =============================================================================
// Generic table / validation / formatting helpers
// =============================================================================

function editTouchesDeposits_(range, ss) {
  if (range.getLastRow() < 2) return false;

  const teams = getTeams_(ss);
  const first = GAME.stopHeaders.length + 1;
  const last = first + teams.length - 1;

  return (
    range.getLastColumn() >= first &&
    range.getColumn() <= last
  );
}


function normalizeTable_(table, label) {
  if (!Array.isArray(table)) {
    throw new Error(`${label} is not a table.`);
  }

  const rows = table
    .map(row => Array.isArray(row) ? row.slice() : [])
    .filter(row =>
      row.some(value => String(value ?? '').trim() !== '')
    );

  if (!rows.length) {
    throw new Error(`${label} is empty.`);
  }

  rows[0][0] = String(rows[0][0] ?? '').replace(/^\uFEFF/, '');

  let width = rows[0].length;

  while (
    width &&
    String(rows[0][width - 1] ?? '').trim() === ''
  ) {
    width -= 1;
  }

  if (!width) {
    throw new Error(`${label} has no header row.`);
  }

  return rows.map(row => {
    const output = row.slice(0, width);
    while (output.length < width) output.push('');
    return output;
  });
}


function headerMapFromRow_(row) {
  const result = new Map();

  row.forEach((value, i) => {
    const header = String(value ?? '')
      .replace(/^\uFEFF/, '')
      .trim();

    if (!header) return;

    if (result.has(header)) {
      throw new Error(`Duplicate imported header "${header}".`);
    }

    result.set(header, i);
  });

  return result;
}


function requireImportedHeaders_(map, required, label) {
  for (const header of required) {
    if (!map.has(header)) {
      throw new Error(`${label} is missing required column "${header}".`);
    }
  }
}


function importedCellString_(row, index) {
  return index === undefined ? '' : String(row[index] ?? '').trim();
}


function requireSheet_(ss, name) {
  const sheet = ss.getSheetByName(name);

  if (!sheet) {
    throw new Error(`Missing required sheet "${name}".`);
  }

  return sheet;
}


function getHeaderMap_(sheet) {
  const lastColumn = sheet.getLastColumn();
  const result = new Map();

  if (lastColumn < 1) return result;

  const headers = sheet
    .getRange(1, 1, 1, lastColumn)
    .getValues()[0];

  headers.forEach((value, i) => {
    const header = String(value || '').trim();
    if (header) result.set(header, i);
  });

  return result;
}


function requireHeaders_(map, required, label) {
  for (const header of required) {
    if (!map.has(header)) {
      throw new Error(`${label} is missing required column "${header}".`);
    }
  }
}


function cellString_(row, index) {
  return index === undefined ? '' : String(row[index] || '').trim();
}


function numberOrZero_(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}


function naturalCompare_(a, b) {
  return String(a).localeCompare(
    String(b),
    undefined,
    {numeric: true, sensitivity: 'base'}
  );
}


function ensureSheetSize_(sheet, rows, columns) {
  if (sheet.getMaxRows() < rows) {
    sheet.insertRowsAfter(
      sheet.getMaxRows(),
      rows - sheet.getMaxRows()
    );
  }

  if (sheet.getMaxColumns() < columns) {
    sheet.insertColumnsAfter(
      sheet.getMaxColumns(),
      columns - sheet.getMaxColumns()
    );
  }
}


function styleBaseSheet_(sheet) {
  sheet
    .getDataRange()
    .setVerticalAlignment('middle')
    .setWrap(true);
}


/**
 * Format selected data columns as Google Sheets Plain text.
 *
 * This is intentionally applied before setValues() for generated/imported
 * tables so values such as "1, 2, 182" can never be auto-parsed as dates.
 */
function setPlainTextColumns_(sheet, startRow, rowCount, columns) {
  if (rowCount <= 0) return;

  for (const column of columns) {
    sheet
      .getRange(startRow, column, rowCount, 1)
      .setNumberFormat('@');
  }
}


/**
 * Apply one numeric display format to selected data columns.
 */
function setNumberFormatColumns_(
  sheet,
  startRow,
  rowCount,
  columns,
  numberFormat
) {
  if (rowCount <= 0) return;

  for (const column of columns) {
    sheet
      .getRange(startRow, column, rowCount, 1)
      .setNumberFormat(numberFormat);
  }
}


function styleHeader_(range, color) {
  range
    .setBackground(color)
    .setFontColor(GAME.colors.white)
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle')
    .setWrap(true);
}


function styleTeamHeader_(range, team) {
  range
    .setBackground(team.color)
    .setFontColor(contrastTextColor_(team.color))
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle')
    .setWrap(true);
}


function contrastTextColor_(hex) {
  const value = String(hex || '').replace('#', '');

  if (!/^[0-9A-Fa-f]{6}$/.test(value)) {
    return '#FFFFFF';
  }

  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);

  return (
    0.299 * r +
    0.587 * g +
    0.114 * b
  ) > 170
    ? '#1F1F1F'
    : '#FFFFFF';
}


function setColumnWidths_(sheet, widths) {
  widths.forEach((width, i) => {
    sheet.setColumnWidth(i + 1, width);
  });
}


// =============================================================================
// Locks
// =============================================================================

function withShortLock_(callback) {
  const lock = LockService.getDocumentLock();

  // Normal gameplay updates are now short, so a 15-second contention window
  // mainly protects rapid consecutive edits from abandoning the later update
  // while a previous one is still finishing.
  if (!lock.tryLock(15000)) {
    throw new Error(
      'Another game update is still running. Please make one more edit if ' +
      'the displayed state does not catch up automatically.'
    );
  }

  try {
    callback();
  } finally {
    lock.releaseLock();
  }
}


function withGameLock_(callback) {
  const lock = LockService.getDocumentLock();

  if (!lock.tryLock(30000)) {
    throw new Error(
      'Another game-management action is running. Try again shortly.'
    );
  }

  try {
    return callback();
  } finally {
    lock.releaseLock();
  }
}
