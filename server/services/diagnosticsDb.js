// ─── Diagnostics Database Service ───────────────────────────────────────────
// Port of DiagnosticsDatabaseService.cs — SQLite CRUD via better-sqlite3.

import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';
import crypto from 'crypto';

let db = null;
let dbPath = '';

export function init() {
  const envDbPath = process.env.DATABASE_PATH;
  if (envDbPath) {
    dbPath = path.resolve(envDbPath);
  } else {
    // Use same path as the C# version for backwards compatibility
    const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    const folder = path.join(configDir, 'BoundaryQC');
    dbPath = path.join(folder, 'BoundaryQCDiagnostics.db');
  }

  const parent = path.dirname(dbPath);
  fs.mkdirSync(parent, { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  initializeDatabase();
  purgeOldLogs(90);
}

function initializeDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS BatchRuns (
      BatchId TEXT PRIMARY KEY,
      Timestamp TEXT NOT NULL,
      TotalFiles INTEGER NOT NULL,
      PassRate REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS DeedLogs (
      Id INTEGER PRIMARY KEY AUTOINCREMENT,
      BatchId TEXT NOT NULL,
      FileName TEXT NOT NULL,
      ParcelName TEXT,
      GeoCallCount INTEGER NOT NULL,
      LinearError REAL NOT NULL,
      PrecisionRatio REAL NOT NULL,
      Status TEXT NOT NULL,
      RepairStageUsed TEXT,
      Timestamp TEXT NOT NULL,
      ExtractionJson TEXT,
      TraverseJson TEXT,
      AgentTurnsJson TEXT,
      TrustScore REAL,
      SolutionStepsJson TEXT,
      FileHash TEXT,
      FOREIGN KEY (BatchId) REFERENCES BatchRuns(BatchId)
    );

    CREATE TABLE IF NOT EXISTS HeuristicTracking (
      Id INTEGER PRIMARY KEY AUTOINCREMENT,
      ProblemName TEXT NOT NULL,
      SolutionApplied TEXT NOT NULL,
      SuccessCount INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS Users (
      Id INTEGER PRIMARY KEY AUTOINCREMENT,
      Username TEXT UNIQUE NOT NULL,
      PasswordHash TEXT NOT NULL,
      Role TEXT NOT NULL DEFAULT 'user',
      Plan TEXT NOT NULL DEFAULT 'free',
      Timestamp TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS Sessions (
      Token TEXT PRIMARY KEY,
      UserId INTEGER NOT NULL,
      ExpiresAt TEXT NOT NULL,
      FOREIGN KEY (UserId) REFERENCES Users(Id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS Subscriptions (
      Id INTEGER PRIMARY KEY AUTOINCREMENT,
      UserId INTEGER UNIQUE NOT NULL,
      Plan TEXT NOT NULL DEFAULT 'free',
      StripeCustomerId TEXT,
      StripeSubscriptionId TEXT,
      Status TEXT NOT NULL DEFAULT 'inactive',
      PeriodEnd TEXT,
      UpdatedAt TEXT NOT NULL,
      FOREIGN KEY (UserId) REFERENCES Users(Id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS UsageTracking (
      Id INTEGER PRIMARY KEY AUTOINCREMENT,
      UserId INTEGER NOT NULL,
      Date TEXT NOT NULL,
      DeedSolves INTEGER NOT NULL DEFAULT 0,
      UNIQUE(UserId, Date),
      FOREIGN KEY (UserId) REFERENCES Users(Id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS AuditLog (
      Id INTEGER PRIMARY KEY AUTOINCREMENT,
      UserId INTEGER,
      ActorId INTEGER,
      Action TEXT NOT NULL,
      Target TEXT,
      Detail TEXT,
      IpAddress TEXT,
      Timestamp TEXT NOT NULL,
      FOREIGN KEY (UserId) REFERENCES Users(Id) ON DELETE SET NULL,
      FOREIGN KEY (ActorId) REFERENCES Users(Id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS InviteTokens (
      Token TEXT PRIMARY KEY,
      CreatedByUserId INTEGER NOT NULL,
      Email TEXT,
      Note TEXT,
      UsedByUserId INTEGER,
      UsedAt TEXT,
      ExpiresAt TEXT NOT NULL,
      CreatedAt TEXT NOT NULL,
      FOREIGN KEY (CreatedByUserId) REFERENCES Users(Id) ON DELETE CASCADE,
      FOREIGN KEY (UsedByUserId) REFERENCES Users(Id) ON DELETE SET NULL
    );
  `);

  // ── Versioned migrations ───────────────────────────────────────────────────────────
  // Each entry has a unique name and a SQL statement. Already-applied migrations
  // are tracked in _Migrations so each runs exactly once, idempotently.
  db.exec(`
    CREATE TABLE IF NOT EXISTS _Migrations (
      Name TEXT PRIMARY KEY,
      AppliedAt TEXT NOT NULL
    );
  `);

  const appliedMigrations = new Set(
    db.prepare('SELECT Name FROM _Migrations').all().map(r => r.Name)
  );

  const migrations = [
    { name: 'add_ExtractionJson',          sql: 'ALTER TABLE DeedLogs ADD COLUMN ExtractionJson TEXT' },
    { name: 'add_TraverseJson',            sql: 'ALTER TABLE DeedLogs ADD COLUMN TraverseJson TEXT' },
    { name: 'add_AgentTurnsJson',          sql: 'ALTER TABLE DeedLogs ADD COLUMN AgentTurnsJson TEXT' },
    { name: 'add_TrustScore',              sql: 'ALTER TABLE DeedLogs ADD COLUMN TrustScore REAL' },
    { name: 'add_SolutionStepsJson',       sql: 'ALTER TABLE DeedLogs ADD COLUMN SolutionStepsJson TEXT' },
    { name: 'add_ReferencePointName',      sql: 'ALTER TABLE DeedLogs ADD COLUMN ReferencePointName TEXT' },
    { name: 'add_ReferencePointNorthing',  sql: 'ALTER TABLE DeedLogs ADD COLUMN ReferencePointNorthing REAL' },
    { name: 'add_ReferencePointEasting',   sql: 'ALTER TABLE DeedLogs ADD COLUMN ReferencePointEasting REAL' },
    { name: 'add_PobNorthing',             sql: 'ALTER TABLE DeedLogs ADD COLUMN PobNorthing REAL' },
    { name: 'add_PobEasting',              sql: 'ALTER TABLE DeedLogs ADD COLUMN PobEasting REAL' },
    { name: 'add_FileHash',               sql: 'ALTER TABLE DeedLogs ADD COLUMN FileHash TEXT' },
    { name: 'add_Users_Plan',             sql: "ALTER TABLE Users ADD COLUMN Plan TEXT NOT NULL DEFAULT 'free'" },
    { name: 'add_Users_LastLogin',        sql: 'ALTER TABLE Users ADD COLUMN LastLogin TEXT' },
    { name: 'add_Users_DisplayName',      sql: 'ALTER TABLE Users ADD COLUMN DisplayName TEXT' },
    { name: 'add_Users_AvatarUrl',        sql: 'ALTER TABLE Users ADD COLUMN AvatarUrl TEXT' },
    { name: 'add_Sessions_UserAgent',     sql: 'ALTER TABLE Sessions ADD COLUMN UserAgent TEXT' },
    { name: 'add_Sessions_IpAddress',     sql: 'ALTER TABLE Sessions ADD COLUMN IpAddress TEXT' },
    { name: 'add_Sessions_CreatedAt',     sql: 'ALTER TABLE Sessions ADD COLUMN CreatedAt TEXT' },
    { name: 'add_Users_ForceResetPw',     sql: 'ALTER TABLE Users ADD COLUMN ForceResetPw INTEGER NOT NULL DEFAULT 0' },
  ];

  const applyMigration = db.transaction((m) => {
    try {
      db.exec(m.sql);
    } catch (e) {
      // Column already exists (SQLITE_ERROR) is the only acceptable silent failure
      if (!e.message.includes('duplicate column name')) throw e;
    }
    db.prepare('INSERT OR IGNORE INTO _Migrations (Name, AppliedAt) VALUES (?, ?)').run(m.name, now());
  });

  for (const m of migrations) {
    if (!appliedMigrations.has(m.name)) {
      applyMigration(m);
      console.log(`  ✓ Migration applied: ${m.name}`);
    }
  }

  // Seed heuristics if empty
  const count = db.prepare('SELECT COUNT(*) as c FROM HeuristicTracking').get().c;
  if (count === 0) {
    const insert = db.prepare('INSERT INTO HeuristicTracking (ProblemName, SolutionApplied, SuccessCount) VALUES (?, ?, 0)');
    const seedData = [
      ['Sequence Out of Order', 'Moore-Neighbor Rearrange'],
      ['Intersecting Boundary', 'Bowtie Inversion Auto-Fix'],
      ['Ambiguous Arc Concavity', 'Convexity Right Turn Rule'],
      ['Shoreline Centerline Meanders', 'Shoreline Gap Solver'],
      ['Pixel Dimension guessing', 'Explicit Chord Parsing'],
    ];
    for (const [p, s] of seedData) insert.run(p, s);
  }
}

export function saveBatchRun(batchId, totalFiles, passRate) {
  db.prepare(`INSERT OR REPLACE INTO BatchRuns (BatchId, Timestamp, TotalFiles, PassRate) VALUES (?, ?, ?, ?)`)
    .run(batchId, now(), totalFiles, passRate);
}

export function saveDeedLog(batchId, fileName, parcelName, geoCallCount, linearError, precisionRatio, status, repairStageUsed, extractionJson = null, traverseJson = null, agentTurnsJson = null, trustScore = null, solutionStepsJson = null, referencePointName = null, referencePointNorthing = null, referencePointEasting = null, pobNorthing = null, pobEasting = null, fileHash = null) {
  let finalRefPointName = referencePointName;
  if (!finalRefPointName && extractionJson) {
    try {
      const parsed = JSON.parse(extractionJson);
      finalRefPointName = parsed.ReferencePointName || parsed.referencePointName || null;
    } catch {}
  }

  db.prepare(`
    INSERT INTO DeedLogs (
      BatchId, FileName, ParcelName, GeoCallCount, LinearError, PrecisionRatio, Status, RepairStageUsed, Timestamp,
      ExtractionJson, TraverseJson, AgentTurnsJson, TrustScore, SolutionStepsJson,
      ReferencePointName, ReferencePointNorthing, ReferencePointEasting, PobNorthing, PobEasting, FileHash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    batchId, fileName, parcelName, geoCallCount, linearError, precisionRatio, status, repairStageUsed, now(),
    extractionJson, traverseJson, agentTurnsJson, trustScore, solutionStepsJson,
    finalRefPointName, referencePointNorthing, referencePointEasting, pobNorthing, pobEasting, fileHash
  );
}

export function saveCorrectedDeed(fileName, parcelName, status, repairStageUsed, extractionJson, traverseJson, agentTurnsJson = null, trustScore = null, solutionStepsJson = null, referencePointName = null, referencePointNorthing = null, referencePointEasting = null, pobNorthing = null, pobEasting = null, fileHash = null) {
  let finalRefPointName = referencePointName;
  if (!finalRefPointName && extractionJson) {
    try {
      const parsed = JSON.parse(extractionJson);
      finalRefPointName = parsed.ReferencePointName || parsed.referencePointName || null;
    } catch {}
  }

  const row = db.prepare("SELECT Id, BatchId FROM DeedLogs WHERE FileName = ? ORDER BY Timestamp DESC LIMIT 1").get(fileName);
  const batchId = row ? row.BatchId : 'CORRECTED';
  
  if (row) {
    db.prepare(`
      UPDATE DeedLogs 
      SET Status = ?, RepairStageUsed = ?, ExtractionJson = ?, TraverseJson = ?, AgentTurnsJson = ?, TrustScore = ?, SolutionStepsJson = ?, Timestamp = ?,
          ReferencePointName = ?, ReferencePointNorthing = ?, ReferencePointEasting = ?, PobNorthing = ?, PobEasting = ?, FileHash = ?
      WHERE Id = ?
    `).run(
      status, repairStageUsed, extractionJson, traverseJson, agentTurnsJson, trustScore, solutionStepsJson, now(),
      finalRefPointName, referencePointNorthing, referencePointEasting, pobNorthing, pobEasting, fileHash, row.Id
    );
    return row.Id;
  } else {
    const result = db.prepare(`
      INSERT INTO DeedLogs (
        BatchId, FileName, ParcelName, GeoCallCount, LinearError, PrecisionRatio, Status, RepairStageUsed, Timestamp,
        ExtractionJson, TraverseJson, AgentTurnsJson, TrustScore, SolutionStepsJson,
        ReferencePointName, ReferencePointNorthing, ReferencePointEasting, PobNorthing, PobEasting, FileHash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      batchId, fileName, parcelName || 'Manual Corrected', 0, 0, 0, status, repairStageUsed, now(),
      extractionJson, traverseJson, agentTurnsJson, trustScore, solutionStepsJson,
      finalRefPointName, referencePointNorthing, referencePointEasting, pobNorthing, pobEasting, fileHash
    );
    return result.lastInsertRowid;
  }
}

export function searchDeedLogs(query, status, maxError) {
  let sql = 'SELECT * FROM DeedLogs WHERE 1=1';
  const params = [];

  if (query) { sql += ' AND (FileName LIKE ? OR ParcelName LIKE ?)'; params.push(`%${query}%`, `%${query}%`); }
  if (status) { sql += ' AND Status = ?'; params.push(status); }
  if (maxError != null) { sql += ' AND LinearError <= ?'; params.push(maxError); }

  sql += ' ORDER BY Timestamp DESC LIMIT 100';
  return db.prepare(sql).all(...params).map(mapDeedLog);
}

export function findSolvedCase(fileName, fileHash = null) {
  // Find the most recent PASS or MEANDER entry with real extraction data.
  // Guards against stale cache from degenerate/zero-segment runs:
  //   1. Must have ExtractionJson with at least 1 course
  //   2. Must have TraverseJson (computed result)
  //   3. GeoCallCount > 0 (courses were actually extracted)
  let rows = [];
  if (fileHash) {
    // 1. Search by exact file hash (highest precision)
    rows = db.prepare(
      `SELECT * FROM DeedLogs
       WHERE FileHash = ? AND Status IN ('PASS', 'MEANDER')
         AND TraverseJson IS NOT NULL
         AND ExtractionJson IS NOT NULL
         AND GeoCallCount > 0
       ORDER BY Timestamp DESC LIMIT 5`
    ).all(fileHash);

    // 2. Fall back to filename match only for legacy entries with no hash stored
    if (rows.length === 0) {
      rows = db.prepare(
        `SELECT * FROM DeedLogs
         WHERE FileName = ? AND (FileHash IS NULL OR FileHash = '') AND Status IN ('PASS', 'MEANDER')
           AND TraverseJson IS NOT NULL
           AND ExtractionJson IS NOT NULL
           AND GeoCallCount > 0
         ORDER BY Timestamp DESC LIMIT 5`
      ).all(fileName);
    }
  } else {
    // Legacy / no hash provided
    rows = db.prepare(
      `SELECT * FROM DeedLogs
       WHERE FileName = ? AND Status IN ('PASS', 'MEANDER')
         AND TraverseJson IS NOT NULL
         AND ExtractionJson IS NOT NULL
         AND GeoCallCount > 0
       ORDER BY Timestamp DESC LIMIT 5`
    ).all(fileName);
  }

  // Pick the first row whose ExtractionJson actually contains courses
  for (const row of rows) {
    try {
      const ex = JSON.parse(row.ExtractionJson);
      const courses = ex.courses || ex.Courses || [];
      if (courses.length > 0) {
        console.log(`Cache hit for ${fileName} (hash=${fileHash}): ${courses.length} courses, ratio=${row.PrecisionRatio}`);
        return mapDeedLog(row);
      }
    } catch { /* invalid JSON — skip */ }
  }

  return null; // No valid cache entry found
}

export function findSkippedCase(fileName, fileHash = null) {
  let rows = [];
  if (fileHash) {
    rows = db.prepare(
      `SELECT * FROM DeedLogs
       WHERE FileHash = ? AND Status = 'SKIPPED'
       ORDER BY Timestamp DESC LIMIT 1`
    ).all(fileHash);

    if (rows.length === 0) {
      rows = db.prepare(
        `SELECT * FROM DeedLogs
         WHERE FileName = ? AND (FileHash IS NULL OR FileHash = '') AND Status = 'SKIPPED'
         ORDER BY Timestamp DESC LIMIT 1`
      ).all(fileName);
    }
  } else {
    rows = db.prepare(
      `SELECT * FROM DeedLogs
       WHERE FileName = ? AND Status = 'SKIPPED'
       ORDER BY Timestamp DESC LIMIT 1`
    ).all(fileName);
  }

  return rows.length > 0 ? mapDeedLog(rows[0]) : null;
}

/**
 * Remove stale PASS entries that have degenerate data:
 * - PrecisionRatio = 999999999 (zero-segment sentinel)
 * - GeoCallCount = 0 (no courses extracted)
 * Call this after a fix deployment to ensure re-processing happens.
 */
export function purgeStaleCache(fileName = null) {
  const condition = fileName
    ? `AND FileName = '${fileName.replace(/'/g, "''")}' `
    : '';
  const result = db.prepare(
    `DELETE FROM DeedLogs
     WHERE Status = 'PASS'
       ${condition}
       AND (PrecisionRatio >= 999999990 OR GeoCallCount = 0 OR TraverseJson IS NULL)`
  ).run();
  console.log(`purgeStaleCache: removed ${result.changes} stale entries${fileName ? ` for ${fileName}` : ''}`);
  return result.changes;
}

export function getRecentBatchRuns() {
  return db.prepare('SELECT * FROM BatchRuns ORDER BY Timestamp DESC LIMIT 20').all().map(r => ({
    batchId: r.BatchId, timestamp: r.Timestamp, totalFiles: r.TotalFiles, passRate: r.PassRate,
  }));
}

export function getHeuristicTracking() {
  return db.prepare('SELECT * FROM HeuristicTracking ORDER BY SuccessCount DESC').all().map(r => ({
    id: r.Id, problemName: r.ProblemName, solutionApplied: r.SolutionApplied, successCount: r.SuccessCount,
  }));
}

export function incrementHeuristic(problemName, solutionApplied) {
  const row = db.prepare('SELECT Id FROM HeuristicTracking WHERE ProblemName = ? AND SolutionApplied = ?').get(problemName, solutionApplied);
  if (row) {
    db.prepare('UPDATE HeuristicTracking SET SuccessCount = SuccessCount + 1 WHERE Id = ?').run(row.Id);
  } else {
    db.prepare('INSERT INTO HeuristicTracking (ProblemName, SolutionApplied, SuccessCount) VALUES (?, ?, 1)').run(problemName, solutionApplied);
  }
}

/**
 * Returns distinct file names that are currently failing (ERROR or FAIL)
 * and have NOT been resolved by a later PASS entry.
 * Excludes pure plat/lot-block docs that can never produce a traverse.
 */
export function getFailedFileNames() {
  return db.prepare(`
    SELECT DISTINCT FileName
    FROM DeedLogs d
    WHERE Status IN ('ERROR', 'FAIL')
      AND NOT EXISTS (
        SELECT 1 FROM DeedLogs p
        WHERE p.FileName = d.FileName
          AND p.Status IN ('PASS', 'MEANDER')
          AND p.Timestamp >= d.Timestamp
      )
    ORDER BY FileName
  `).all().map(r => r.FileName);
}

/**
 * Returns the most-recent FAIL/ERROR log entry per distinct FileName,
 * deduped so each file only appears once even across multiple batch runs.
 * Optionally filtered to a specific linear-error bucket.
 *
 * @param {number} limit   - max rows to return (default 200)
 * @param {string|null} bucket - 'nearClosed' | 'minorError' | 'moderateError' | 'majorError' | null
 */
export function getFailedDeedList(limit = 200, bucket = null) {
  const bucketWhere = {
    nearClosed:     'AND LinearError <= 1.0',
    minorError:     'AND LinearError > 1.0 AND LinearError <= 10.0',
    moderateError:  'AND LinearError > 10.0 AND LinearError <= 100.0',
    majorError:     'AND LinearError > 100.0',
  }[bucket] || '';

  // Subquery: pick the single latest row per FileName that is FAIL/ERROR,
  // but ONLY if the file has no newer PASS or MEANDER record (i.e. it's genuinely still failing).
  const rows = db.prepare(`
    SELECT d.FileName, d.LinearError, d.PrecisionRatio, d.Status, d.RepairStageUsed,
           d.Timestamp, d.BatchId, d.GeoCallCount, d.TrustScore, d.ExtractionJson
    FROM DeedLogs d
    INNER JOIN (
      SELECT FileName, MAX(Timestamp) AS LatestFailTs
      FROM DeedLogs
      WHERE Status IN ('FAIL','ERROR')
      ${bucketWhere}
      GROUP BY FileName
    ) latest ON d.FileName = latest.FileName AND d.Timestamp = latest.LatestFailTs
    WHERE d.Status IN ('FAIL','ERROR')
      AND NOT EXISTS (
        SELECT 1 FROM DeedLogs p
        WHERE p.FileName = d.FileName
          AND p.Status IN ('PASS','MEANDER')
          AND p.Timestamp >= d.Timestamp
      )
    ORDER BY d.LinearError DESC, d.FileName
    LIMIT ?
  `).all(limit);

  return rows.map(r => ({
    fileName:        r.FileName,
    linearError:     r.LinearError,
    precisionRatio:  r.PrecisionRatio,
    status:          r.Status,
    repairStageUsed: r.RepairStageUsed,
    timestamp:       r.Timestamp,
    batchId:         r.BatchId,
    geoCallCount:    r.GeoCallCount,
    trustScore:      r.TrustScore,
    parcelName:      r.ParcelName,
    // Include a trimmed preview of the extraction message for the list
    extractionSummary: (() => {
      try {
        const ex = JSON.parse(r.ExtractionJson || 'null');
        return ex ? (ex.mentalMapSummary || ex.message || null) : null;
      } catch { return null; }
    })(),
  }));
}

/**
 * Full deed record for a single file — used by the Dashboard deed preview panel.
 * Returns the most recent FAIL/ERROR row with fully parsed extraction & traverse.
 */
export function getDeedDetail(fileName) {
  const r = db.prepare(`
    SELECT *
    FROM DeedLogs
    WHERE FileName = ? AND Status IN ('FAIL','ERROR','MEANDER')
    ORDER BY Timestamp DESC LIMIT 1
  `).get(fileName);

  if (!r) return null;

  let extraction = null;
  let traverse   = null;
  let agentTurns = null;

  try { extraction = JSON.parse(r.ExtractionJson); } catch {}
  try { traverse   = JSON.parse(r.TraverseJson);   } catch {}
  try { agentTurns = JSON.parse(r.AgentTurnsJson); } catch {}

  return {
    id:              r.Id,
    fileName:        r.FileName,
    parcelName:      r.ParcelName,
    status:          r.Status,
    linearError:     r.LinearError,
    precisionRatio:  r.PrecisionRatio,
    geoCallCount:    r.GeoCallCount,
    repairStageUsed: r.RepairStageUsed,
    timestamp:       r.Timestamp,
    batchId:         r.BatchId,
    trustScore:      r.TrustScore,
    extraction,
    traverse,
    agentTurns,
  };
}

export function getDatabaseStats() {

  let fileSizeBytes = 0;
  try { fileSizeBytes = fs.statSync(dbPath).size; } catch {}

  const deedLogCount = db.prepare('SELECT COUNT(*) as c FROM DeedLogs').get().c;
  // Count per-file CURRENT status (latest log entry per file), not raw row counts.
  // A file fixed from FAIL → PASS counts as PASS only, not both.
  const currentStatusCounts = db.prepare(`
    SELECT Status, COUNT(*) as cnt
    FROM (
      SELECT FileName, Status
      FROM DeedLogs d
      WHERE Timestamp = (SELECT MAX(Timestamp) FROM DeedLogs WHERE FileName = d.FileName)
      GROUP BY FileName
    )
    GROUP BY Status
  `).all();
  const _sm = Object.fromEntries(currentStatusCounts.map(r => [r.Status, r.cnt]));
  const passCount    = _sm['PASS']    || 0;
  const failCount    = _sm['FAIL']    || 0;
  const meanderCount = _sm['MEANDER'] || 0;
  const errorCount   = _sm['ERROR']   || 0;
  const batchRunCount = db.prepare('SELECT COUNT(*) as c FROM BatchRuns').get().c;
  const heuristicCount = db.prepare('SELECT COUNT(*) as c FROM HeuristicTracking').get().c;
  const range = db.prepare('SELECT MIN(Timestamp) as oldest, MAX(Timestamp) as newest FROM DeedLogs').get();

  const classifications = db.prepare(`
    SELECT 
      CASE 
        WHEN ExtractionJson IS NOT NULL AND json_valid(ExtractionJson) THEN json_extract(ExtractionJson, '$.Classification')
        WHEN ParcelName LIKE '[%]%' THEN substr(ParcelName, 2, instr(ParcelName, ']') - 2)
        ELSE 'UNKNOWN'
      END as class,
      COUNT(*) as count,
      SUM(CASE WHEN Status = 'PASS' THEN 1 ELSE 0 END) as passed,
      SUM(CASE WHEN Status = 'FAIL' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN Status = 'MEANDER' THEN 1 ELSE 0 END) as meanders,
      SUM(CASE WHEN Status = 'ERROR' THEN 1 ELSE 0 END) as errors
    FROM DeedLogs
    GROUP BY class
    ORDER BY count DESC
  `).all().map(c => ({
    class: c.class || 'UNKNOWN',
    count: c.count,
    passed: c.passed,
    failed: c.failed,
    meanders: c.meanders,
    errors: c.errors
  }));

  const repairStages = db.prepare(`
    SELECT 
      RepairStageUsed as stage,
      COUNT(*) as count,
      SUM(CASE WHEN Status = 'PASS' THEN 1 ELSE 0 END) as passed
    FROM DeedLogs
    WHERE stage IS NOT NULL AND stage != ''
    GROUP BY stage
    ORDER BY count DESC
  `).all().map(s => ({
    stage: s.stage || 'Unknown',
    count: s.count,
    passed: s.passed
  }));

  const errors = db.prepare(`
    SELECT 
      SUM(CASE WHEN LinearError <= 1.0 THEN 1 ELSE 0 END) as nearClosed,
      SUM(CASE WHEN LinearError > 1.0 AND LinearError <= 10.0 THEN 1 ELSE 0 END) as minorError,
      SUM(CASE WHEN LinearError > 10.0 AND LinearError <= 100.0 THEN 1 ELSE 0 END) as moderateError,
      SUM(CASE WHEN LinearError > 100.0 THEN 1 ELSE 0 END) as majorError
    FROM DeedLogs d
    WHERE Status = 'FAIL'
      AND NOT EXISTS (
        SELECT 1 FROM DeedLogs p
        WHERE p.FileName = d.FileName
          AND p.Status IN ('PASS','MEANDER')
          AND p.Timestamp >= d.Timestamp
      )
  `).get();


  return {
    dbPath,
    fileSizeMb: Math.round(fileSizeBytes / 1048576 * 100) / 100,
    fileSizeBytes,
    deedLogCount, passCount, failCount, meanderCount, errorCount, batchRunCount, heuristicCount,
    oldestTimestamp: (range ? range.oldest : null) || null,
    newestTimestamp: (range ? range.newest : null) || null,
    classifications,
    repairStages,
    errorDistribution: {
      nearClosed: (errors ? errors.nearClosed : 0) || 0,
      minorError: (errors ? errors.minorError : 0) || 0,
      moderateError: (errors ? errors.moderateError : 0) || 0,
      majorError: (errors ? errors.majorError : 0) || 0
    }
  };
}

export function purgeOldLogs(retentionDays) {
  const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString().replace('T', ' ').slice(0, 19);
  let deleted = 0;
  deleted += db.prepare('DELETE FROM DeedLogs WHERE Timestamp < ?').run(cutoff).changes;
  deleted += db.prepare('DELETE FROM BatchRuns WHERE Timestamp < ?').run(cutoff).changes;
  db.exec('VACUUM');
  return deleted;
}

export function clearFailedCache() {
  const deleted = db.prepare("DELETE FROM DeedLogs WHERE Status != 'PASS'").run().changes;
  db.exec('VACUUM');
  return deleted;
}

export function clearAllCache() {
  let deleted = 0;
  deleted += db.prepare('DELETE FROM DeedLogs').run().changes;
  deleted += db.prepare('DELETE FROM BatchRuns').run().changes;
  db.exec('VACUUM');
  return deleted;
}

/**
 * Full statistics for a single batch run.
 */
export function getBatchStats(batchId) {
  const counts = db.prepare(`
    SELECT
      COUNT(*)                                                    AS total,
      SUM(CASE WHEN Status='PASS'    THEN 1 ELSE 0 END)          AS passed,
      SUM(CASE WHEN Status='FAIL'    THEN 1 ELSE 0 END)          AS failed,
      SUM(CASE WHEN Status='ERROR'   THEN 1 ELSE 0 END)          AS errors,
      SUM(CASE WHEN Status='MEANDER' THEN 1 ELSE 0 END)          AS meanders,
      SUM(CASE WHEN Status='SKIPPED' THEN 1 ELSE 0 END)          AS skipped,
      AVG(CASE WHEN Status='PASS' AND PrecisionRatio > 0 AND PrecisionRatio < 999999990
               THEN PrecisionRatio ELSE NULL END)                AS avgPrecision,
      MAX(CASE WHEN Status='PASS' AND PrecisionRatio < 999999990
               THEN PrecisionRatio ELSE NULL END)                AS bestPrecision,
      AVG(CASE WHEN Status='FAIL'    THEN LinearError  ELSE NULL END) AS avgLinearErr,
      MAX(CASE WHEN Status='FAIL'    THEN LinearError  ELSE NULL END) AS maxLinearErr,
      AVG(CASE WHEN Status='PASS'    THEN TrustScore   ELSE NULL END) AS avgTrustScore
    FROM DeedLogs WHERE BatchId = ?
  `).get(batchId);

  const stages = db.prepare(`
    SELECT RepairStageUsed AS stage,
           COUNT(*)        AS count,
           SUM(CASE WHEN Status='PASS' THEN 1 ELSE 0 END) AS passed
    FROM DeedLogs WHERE BatchId = ?
    GROUP BY RepairStageUsed
    ORDER BY count DESC
    LIMIT 12
  `).all(batchId).map(r => ({ stage: r.stage || 'Unknown', count: r.count, passed: r.passed }));

  const failedFiles = db.prepare(`
    SELECT FileName, LinearError, RepairStageUsed
    FROM DeedLogs
    WHERE BatchId = ? AND Status IN ('FAIL','ERROR')
    ORDER BY LinearError DESC
    LIMIT 50
  `).all(batchId).map(r => ({ fileName: r.FileName, linearError: r.LinearError, stage: r.RepairStageUsed }));

  const precisionBuckets = db.prepare(`
    SELECT
      SUM(CASE WHEN PrecisionRatio >= 50000  AND PrecisionRatio < 999999990 THEN 1 ELSE 0 END) AS excellent,
      SUM(CASE WHEN PrecisionRatio >= 10000  AND PrecisionRatio <  50000    THEN 1 ELSE 0 END) AS good,
      SUM(CASE WHEN PrecisionRatio >=  5000  AND PrecisionRatio <  10000    THEN 1 ELSE 0 END) AS fair,
      SUM(CASE WHEN PrecisionRatio >       0 AND PrecisionRatio <   5000    THEN 1 ELSE 0 END) AS poor
    FROM DeedLogs WHERE BatchId = ? AND Status = 'PASS'
  `).get(batchId);

  return {
    batchId,
    counts: {
      total:    (counts ? counts.total : 0)    || 0,
      passed:   (counts ? counts.passed : 0)   || 0,
      failed:   (counts ? counts.failed : 0)   || 0,
      errors:   (counts ? counts.errors : 0)   || 0,
      meanders: (counts ? counts.meanders : 0) || 0,
      skipped:  (counts ? counts.skipped : 0)  || 0,
    },
    passRate: (counts && counts.total > 0) ? (counts.passed / counts.total) : 0,
    precision: {
      avg:       (counts ? counts.avgPrecision : 0)  || 0,
      best:      (counts ? counts.bestPrecision : 0) || 0,
      excellent: (precisionBuckets ? precisionBuckets.excellent : 0) || 0,
      good:      (precisionBuckets ? precisionBuckets.good : 0)      || 0,
      fair:      (precisionBuckets ? precisionBuckets.fair : 0)      || 0,
      poor:      (precisionBuckets ? precisionBuckets.poor : 0)      || 0,
    },
    closure: {
      avgLinearErr: (counts ? counts.avgLinearErr : 0)  || 0,
      maxLinearErr: (counts ? counts.maxLinearErr : 0)  || 0,
    },
    avgTrustScore: (counts ? counts.avgTrustScore : null) || null,
    stages,
    failedFiles,
  };
}

/**
 * Recent batch runs enriched with inline stats.
 * Uses a single aggregate SQL query per batch (no N+1).
 */
export function getRecentBatchesWithStats(limit = 30) {
  const batches = db.prepare('SELECT * FROM BatchRuns ORDER BY Timestamp DESC LIMIT ?').all(limit);
  if (batches.length === 0) return [];

  // Single query: aggregate all batch stats for the fetched batch IDs
  const placeholders = batches.map(() => '?').join(',');
  const batchIds = batches.map(b => b.BatchId);

  const rows = db.prepare(`
    SELECT
      BatchId,
      COUNT(*) AS total,
      SUM(CASE WHEN Status = 'PASS'    THEN 1 ELSE 0 END) AS passed,
      SUM(CASE WHEN Status = 'FAIL'    THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN Status = 'ERROR'   THEN 1 ELSE 0 END) AS errors,
      SUM(CASE WHEN Status = 'MEANDER' THEN 1 ELSE 0 END) AS meanders,
      SUM(CASE WHEN Status = 'SKIP'    THEN 1 ELSE 0 END) AS skipped,
      AVG(LinearError) AS avgLinearErr,
      MAX(LinearError) AS maxLinearErr,
      AVG(PrecisionRatio) AS avgPrecision,
      MAX(PrecisionRatio) AS bestPrecision
    FROM DeedLogs
    WHERE BatchId IN (${placeholders})
    GROUP BY BatchId
  `).all(...batchIds);

  const statsByBatch = Object.fromEntries(rows.map(r => [r.BatchId, r]));

  return batches.map(b => {
    const s = statsByBatch[b.BatchId] || {};
    return {
      batchId:    b.BatchId,
      timestamp:  b.Timestamp,
      totalFiles: b.TotalFiles,
      passRate:   b.PassRate,
      stats: {
        batchId: b.BatchId,
        counts: {
          total:    s.total    || 0,
          passed:   s.passed   || 0,
          failed:   s.failed   || 0,
          errors:   s.errors   || 0,
          meanders: s.meanders || 0,
          skipped:  s.skipped  || 0,
        },
        passRate: s.total > 0 ? (s.passed / s.total) : 0,
        closure: { avgLinearErr: s.avgLinearErr || 0, maxLinearErr: s.maxLinearErr || 0 },
        precision: { avg: s.avgPrecision || 0, best: s.bestPrecision || 0 },
      },
    };
  });
}


function now() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }

function mapDeedLog(r) {
  return {
    id: r.Id, batchId: r.BatchId, fileName: r.FileName, parcelName: r.ParcelName,
    geoCallCount: r.GeoCallCount, linearError: r.LinearError, precisionRatio: r.PrecisionRatio,
    status: r.Status, repairStageUsed: r.RepairStageUsed, timestamp: r.Timestamp,
    extractionJson: r.ExtractionJson, traverseJson: r.TraverseJson,
    agentTurnsJson: r.AgentTurnsJson, trustScore: r.TrustScore,
    solutionStepsJson: (r.SolutionStepsJson !== undefined && r.SolutionStepsJson !== null ? r.SolutionStepsJson : null),
    referencePointName: r.ReferencePointName,
    referencePointNorthing: r.ReferencePointNorthing,
    referencePointEasting: r.ReferencePointEasting,
    pobNorthing: r.PobNorthing,
    pobEasting: r.PobEasting,
  };
}

/**
 * Retrieve the parsed solution steps for a specific file.
 * Returns null if not stored.
 */
export function getSolutionSteps(fileName) {
  const row = db.prepare(
    `SELECT SolutionStepsJson, RepairStageUsed, Status, Timestamp
     FROM DeedLogs WHERE FileName = ? AND SolutionStepsJson IS NOT NULL
     ORDER BY Timestamp DESC LIMIT 1`
  ).get(fileName);
  if (!row) return null;
  try {
    return {
      fileName,
      repairStageUsed: row.RepairStageUsed,
      status: row.Status,
      timestamp: row.Timestamp,
      steps: JSON.parse(row.SolutionStepsJson),
    };
  } catch { return null; }
}

// ─── Cryptography & Auth Helpers ─────────────────────────────────────────────

// NIST SP 800-132 recommends ≥ 210,000 iterations for PBKDF2-SHA-512.
// We use 310,000 to stay comfortably above the 2025 guideline.
const PBKDF2_ITERATIONS = 310_000;
const PBKDF2_LEGACY_ITERATIONS = 1_000;

/**
 * Synchronous hash — only used during user creation (once per registration).
 * The sync variant is intentional here; creation is rare and isolated.
 */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

/**
 * Verify a password and transparently upgrade legacy (1k-iteration) hashes.
 * Returns { valid: boolean, needsRehash: boolean, newHash?: string }.
 */
export function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return { valid: false, needsRehash: false };
  const [salt, originalHash] = storedHash.split(':');
  const tryVerify = (iterations) =>
    crypto.pbkdf2Sync(password, salt, iterations, 64, 'sha512').toString('hex') === originalHash;

  if (tryVerify(PBKDF2_ITERATIONS)) {
    return { valid: true, needsRehash: false };
  }
  if (tryVerify(PBKDF2_LEGACY_ITERATIONS)) {
    // Legacy account — re-hash with current iterations transparently
    console.warn('[Auth] Upgrading legacy 1k-iteration password hash to current strength.');
    return { valid: true, needsRehash: true, newHash: hashPassword(password) };
  }
  return { valid: false, needsRehash: false };
}

export function createUser(username, password, role = null, plan = 'free') {
  // Check if duplicate user exists
  const existing = db.prepare('SELECT Id FROM Users WHERE Username = ?').get(username);
  if (existing) {
    throw new Error('Username already exists');
  }

  // First ever user auto-becomes admin (unless ADMIN_EMAIL is set and matches)
  const adminEmail = process.env.ADMIN_EMAIL?.toLowerCase();
  const totalUsers = db.prepare('SELECT COUNT(*) as c FROM Users').get().c;
  let effectiveRole = role;
  if (!effectiveRole) {
    if (totalUsers === 0) {
      effectiveRole = 'admin';
    } else if (adminEmail && username.toLowerCase() === adminEmail) {
      effectiveRole = 'admin';
    } else {
      effectiveRole = 'user';
    }
  }

  const passwordHash = hashPassword(password);
  const result = db.prepare('INSERT INTO Users (Username, PasswordHash, Role, Plan, Timestamp) VALUES (?, ?, ?, ?, ?)')
    .run(username, passwordHash, effectiveRole, plan, now());
  
  return {
    id: result.lastInsertRowid,
    username,
    role: effectiveRole,
    plan,
  };
}

export function verifyUser(username, password) {
  const row = db.prepare('SELECT * FROM Users WHERE Username = ?').get(username);
  if (!row) return null;
  const { valid, needsRehash, newHash } = verifyPassword(password, row.PasswordHash);
  if (!valid) return null;
  // Transparently re-hash legacy accounts to current PBKDF2 iteration count
  if (needsRehash && newHash) {
    db.prepare('UPDATE Users SET PasswordHash = ? WHERE Id = ?').run(newHash, row.Id);
  }
  touchLastLogin(row.Id);
  return { id: row.Id, username: row.Username, role: row.Role, plan: row.Plan || 'free' };
}

export function createSession(userId, { ipAddress = null, userAgent = null } = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare('INSERT INTO Sessions (Token, UserId, ExpiresAt, IpAddress, UserAgent, CreatedAt) VALUES (?, ?, ?, ?, ?, ?)')
    .run(token, userId, expiresAt, ipAddress, userAgent, now());
  return token;
}

export function getSession(token) {
  // Fast-reject malformed tokens (expected: 64-char hex from randomBytes(32))
  if (!token || typeof token !== 'string' || token.length !== 64 || !/^[0-9a-f]+$/i.test(token)) {
    return null;
  }

  const row = db.prepare(`
    SELECT s.Token, s.ExpiresAt, u.Id as UserId, u.Username, u.Role, u.Plan
    FROM Sessions s
    INNER JOIN Users u ON s.UserId = u.Id
    WHERE s.Token = ?
  `).get(token);

  if (!row) return null;

  // Timing-safe token comparison (prevents timing-oracle attacks)
  try {
    const valid = crypto.timingSafeEqual(
      Buffer.from(token.toLowerCase(), 'hex'),
      Buffer.from(row.Token.toLowerCase(), 'hex')
    );
    if (!valid) return null;
  } catch {
    return null;
  }

  // Check expiration
  const nowStr = now();
  if (row.ExpiresAt < nowStr) {
    db.prepare('DELETE FROM Sessions WHERE Token = ?').run(token);
    return null;
  }

  return { userId: row.UserId, username: row.Username, role: row.Role, plan: row.Plan || 'free' };
}

export function deleteSession(token) {
  db.prepare('DELETE FROM Sessions WHERE Token = ?').run(token);
}

/**
 * Delete all sessions whose ExpiresAt has already passed.
 * Call on startup and periodically to keep the table lean.
 * @returns {number} Number of rows deleted
 */
export function purgeExpiredSessions() {
  const deleted = db.prepare('DELETE FROM Sessions WHERE ExpiresAt < ?').run(now()).changes;
  if (deleted > 0) console.log(`✓ Purged ${deleted} expired session(s).`);
  return deleted;
}

export function findUserByUsername(username) {
  const row = db.prepare('SELECT Id as id, Username as username, Role as role, Plan as plan FROM Users WHERE Username = ?').get(username);
  return row ? { id: row.id, username: row.username, role: row.role, plan: row.plan || 'free' } : null;
}

// ── User management ───────────────────────────────────────────────────────────

export function getAllUsers() {
  return db.prepare(`
    SELECT u.Id as id, u.Username as username, u.Role as role, u.Plan as plan,
           u.Timestamp as createdAt, u.LastLogin as lastLogin, u.DisplayName as displayName,
           s.Status as subStatus, s.PeriodEnd as subPeriodEnd, s.StripeCustomerId as stripeCustomerId
    FROM Users u
    LEFT JOIN Subscriptions s ON s.UserId = u.Id
    ORDER BY u.Timestamp DESC
  `).all().map(r => ({
    id: r.id,
    username: r.username,
    role: r.role,
    plan: r.plan || 'free',
    createdAt: r.createdAt,
    lastLogin: r.lastLogin,
    displayName: r.displayName,
    subStatus: r.subStatus,
    subPeriodEnd: r.subPeriodEnd,
    stripeCustomerId: r.stripeCustomerId,
  }));
}

export function getUserById(userId) {
  const row = db.prepare(`
    SELECT u.Id as id, u.Username as username, u.Role as role, u.Plan as plan,
           u.Timestamp as createdAt, u.LastLogin as lastLogin, u.DisplayName as displayName,
           s.Status as subStatus, s.PeriodEnd as subPeriodEnd, s.StripeCustomerId as stripeCustomerId,
           s.StripeSubscriptionId as stripeSubscriptionId
    FROM Users u
    LEFT JOIN Subscriptions s ON s.UserId = u.Id
    WHERE u.Id = ?
  `).get(userId);
  if (!row) return null;
  return {
    id: row.id, username: row.username, role: row.role, plan: row.plan || 'free',
    createdAt: row.createdAt, lastLogin: row.lastLogin, displayName: row.displayName,
    subStatus: row.subStatus, subPeriodEnd: row.subPeriodEnd,
    stripeCustomerId: row.stripeCustomerId, stripeSubscriptionId: row.stripeSubscriptionId,
  };
}

export function updateUserRole(userId, role) {
  const allowed = ['user', 'pro', 'admin'];
  if (!allowed.includes(role)) throw new Error(`Invalid role: ${role}`);
  db.prepare('UPDATE Users SET Role = ? WHERE Id = ?').run(role, userId);
}

export function updateUserPlan(userId, plan) {
  const allowed = ['free', 'pro', 'enterprise'];
  if (!allowed.includes(plan)) throw new Error(`Invalid plan: ${plan}`);
  db.prepare('UPDATE Users SET Plan = ? WHERE Id = ?').run(plan, userId);
  // Also upsert subscription record
  upsertSubscription(userId, {
    plan,
    status: plan === 'free' ? 'inactive' : 'active',
    periodEnd: plan === 'free' ? null : new Date(Date.now() + 365 * 86400000).toISOString(),
  });
}

export function touchLastLogin(userId) {
  db.prepare('UPDATE Users SET LastLogin = ? WHERE Id = ?').run(now(), userId);
}

export function getUserCount() {
  return db.prepare('SELECT COUNT(*) as c FROM Users').get().c;
}

// ── Subscription management ───────────────────────────────────────────────────

export function upsertSubscription(userId, { plan, stripeCustomerId, stripeSubscriptionId, status, periodEnd } = {}) {
  db.prepare(`
    INSERT INTO Subscriptions (UserId, Plan, StripeCustomerId, StripeSubscriptionId, Status, PeriodEnd, UpdatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(UserId) DO UPDATE SET
      Plan = excluded.Plan,
      StripeCustomerId = COALESCE(excluded.StripeCustomerId, StripeCustomerId),
      StripeSubscriptionId = COALESCE(excluded.StripeSubscriptionId, StripeSubscriptionId),
      Status = excluded.Status,
      PeriodEnd = excluded.PeriodEnd,
      UpdatedAt = excluded.UpdatedAt
  `).run(userId, plan || 'free', stripeCustomerId || null, stripeSubscriptionId || null,
         status || 'inactive', periodEnd || null, now());
  // Keep Users.Plan in sync
  db.prepare('UPDATE Users SET Plan = ? WHERE Id = ?').run(plan || 'free', userId);
}

export function getSubscriptionByUser(userId) {
  return db.prepare('SELECT * FROM Subscriptions WHERE UserId = ?').get(userId) || null;
}

export function getSubscriptionByStripeCustomer(stripeCustomerId) {
  return db.prepare(`
    SELECT s.*, u.Username as username
    FROM Subscriptions s
    JOIN Users u ON u.Id = s.UserId
    WHERE s.StripeCustomerId = ?
  `).get(stripeCustomerId) || null;
}

export function getSubscriptionByStripeSubscription(stripeSubscriptionId) {
  return db.prepare(`
    SELECT s.*, u.Id as userId
    FROM Subscriptions s
    JOIN Users u ON u.Id = s.UserId
    WHERE s.StripeSubscriptionId = ?
  `).get(stripeSubscriptionId) || null;
}

// ── Admin order / subscription management ─────────────────────────────────────

/** Returns all subscriptions with user info, usage totals, and Stripe IDs.
 *  Used by the admin Orders panel. */
export function getAllSubscriptions() {
  return db.prepare(`
    SELECT
      u.Id          AS userId,
      u.Username    AS username,
      u.Username    AS email,
      u.Role        AS role,
      u.Timestamp   AS userCreatedAt,
      COALESCE(s.Plan,   u.Plan)   AS plan,
      COALESCE(s.Status,'inactive') AS status,
      s.StripeCustomerId        AS stripeCustomerId,
      s.StripeSubscriptionId    AS stripeSubscriptionId,
      s.PeriodEnd               AS periodEnd,
      s.UpdatedAt               AS updatedAt,
      COALESCE(ut.totalSolves, 0) AS totalSolves
    FROM Users u
    LEFT JOIN Subscriptions s ON s.UserId = u.Id
    LEFT JOIN (
      SELECT UserId, SUM(DeedSolves) AS totalSolves
      FROM UsageTracking
      GROUP BY UserId
    ) ut ON ut.UserId = u.Id
    ORDER BY COALESCE(s.UpdatedAt, u.Timestamp) DESC
  `).all();
}

/** Returns MRR stats for the revenue summary card. */
export function getRevenueStats() {
  const PLAN_PRICE = { free: 0, pro: 29, enterprise: 99 };
  const rows = db.prepare(`
    SELECT COALESCE(s.Plan, u.Plan, 'free') AS plan, COUNT(*) AS cnt
    FROM Users u
    LEFT JOIN Subscriptions s ON s.UserId = u.Id AND s.Status = 'active'
    GROUP BY plan
  `).all();

  let mrr = 0;
  const breakdown = {};
  rows.forEach(r => {
    const price = PLAN_PRICE[r.plan] || 0;
    mrr += price * r.cnt;
    breakdown[r.plan] = (breakdown[r.plan] || 0) + r.cnt;
  });
  return { mrr, breakdown, totalUsers: rows.reduce((a, r) => a + r.cnt, 0) };
}

/** Admin override: set a user's plan directly (no Stripe required). */
export function adminSetPlan(userId, plan, actorId) {
  upsertSubscription(userId, {
    plan,
    status: plan === 'free' ? 'inactive' : 'active',
    periodEnd: plan === 'free' ? null : undefined,
  });
  logAudit({
    actorId,
    userId,
    action: 'admin_set_plan',
    target: `userId=${userId}`,
    detail: { plan }
  });
}

/** Admin cancel: downgrade user to free and nullify Stripe fields. */
export function adminCancelSubscription(userId, actorId) {
  db.prepare(`
    UPDATE Subscriptions
    SET Plan='free', Status='cancelled', PeriodEnd=NULL, UpdatedAt=?
    WHERE UserId=?
  `).run(now(), userId);
  db.prepare('UPDATE Users SET Plan=? WHERE Id=?').run('free', userId);
  logAudit({
    actorId,
    userId,
    action: 'admin_cancel_subscription',
    target: `userId=${userId}`,
    detail: { message: 'cancelled by admin' }
  });
}

// ── Usage tracking ────────────────────────────────────────────────────────────


const FREE_DAILY_DEED_LIMIT = 5;

export function getDailyUsage(userId) {
  const date = now().slice(0, 10); // YYYY-MM-DD
  const row = db.prepare('SELECT DeedSolves FROM UsageTracking WHERE UserId = ? AND Date = ?').get(userId, date);
  return row ? row.DeedSolves : 0;
}

export function incrementDailyUsage(userId) {
  const date = now().slice(0, 10);
  db.prepare(`
    INSERT INTO UsageTracking (UserId, Date, DeedSolves) VALUES (?, ?, 1)
    ON CONFLICT(UserId, Date) DO UPDATE SET DeedSolves = DeedSolves + 1
  `).run(userId, date);
}

export function checkDailyLimit(userId, userPlan) {
  if (userPlan === 'pro' || userPlan === 'enterprise') return { allowed: true, used: null, limit: null };
  const used = getDailyUsage(userId);
  return { allowed: used < FREE_DAILY_DEED_LIMIT, used, limit: FREE_DAILY_DEED_LIMIT };
}

export { FREE_DAILY_DEED_LIMIT };


export function getDeedsByReferencePoint(refPointName) {
  return db.prepare(`
    SELECT * FROM DeedLogs
    WHERE ReferencePointName = ? AND Status IN ('PASS', 'MEANDER')
    ORDER BY Timestamp DESC
  `).all(refPointName).map(mapDeedLog);
}

export function getDistinctReferencePoints() {
  return db.prepare(`
    SELECT DISTINCT ReferencePointName
    FROM DeedLogs
    WHERE ReferencePointName IS NOT NULL AND ReferencePointName != ''
    ORDER BY ReferencePointName
  `).all().map(r => r.ReferencePointName);
}

export function getDbPath() {
  return dbPath;
}

export function switchDbPath(newPath) {
  if (!newPath) throw new Error('New database path cannot be empty.');
  const resolved = path.resolve(newPath);
  
  const parent = path.dirname(resolved);
  fs.mkdirSync(parent, { recursive: true });

  if (db) {
    db.close();
  }

  dbPath = resolved;
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  initializeDatabase();
  console.log(`✓ SQLite Database path successfully switched to: ${dbPath}`);
}

// ── User CRUD ────────────────────────────────────────────────────────────────

export function deleteUser(userId) {
  // Sessions cascade via FK ON DELETE CASCADE
  const result = db.prepare('DELETE FROM Users WHERE Id = ?').run(userId);
  return result.changes > 0;
}

export function updateProfile(userId, { displayName } = {}) {
  db.prepare('UPDATE Users SET DisplayName = ? WHERE Id = ?').run(displayName || null, userId);
}

export function updatePassword(userId, newPassword) {
  const hash = hashPassword(newPassword);
  db.prepare('UPDATE Users SET PasswordHash = ?, ForceResetPw = 0 WHERE Id = ?').run(hash, userId);
}

export function forceResetPassword(userId) {
  // Generate a random temporary password
  const tempPw = crypto.randomBytes(6).toString('hex'); // 12-char hex
  const hash = hashPassword(tempPw);
  db.prepare('UPDATE Users SET PasswordHash = ?, ForceResetPw = 1 WHERE Id = ?').run(hash, userId);
  // Revoke all active sessions so next login uses the temp password
  db.prepare('DELETE FROM Sessions WHERE UserId = ?').run(userId);
  return tempPw;
}

export function verifyPasswordOnly(userId, password) {
  const row = db.prepare('SELECT PasswordHash FROM Users WHERE Id = ?').get(userId);
  if (!row) return false;
  const { valid } = verifyPassword(password, row.PasswordHash);
  return valid;
}

export function checkForceReset(userId) {
  const row = db.prepare('SELECT ForceResetPw FROM Users WHERE Id = ?').get(userId);
  return row?.ForceResetPw === 1;
}

// ── Session management ────────────────────────────────────────────────────────

export function getUserSessions(userId) {
  return db.prepare(`
    SELECT Token, ExpiresAt, IpAddress, UserAgent, CreatedAt
    FROM Sessions
    WHERE UserId = ?
    ORDER BY CreatedAt DESC
  `).all(userId).map(s => ({
    token: s.Token.substring(0, 8) + '…', // masked for security
    tokenPrefix: s.Token.substring(0, 8),
    fullToken: s.Token,
    expiresAt: s.ExpiresAt,
    ipAddress: s.IpAddress,
    userAgent: s.UserAgent,
    createdAt: s.CreatedAt,
  }));
}

export function revokeSession(token) {
  db.prepare('DELETE FROM Sessions WHERE Token = ?').run(token);
}

export function revokeAllUserSessions(userId) {
  const result = db.prepare('DELETE FROM Sessions WHERE UserId = ?').run(userId);
  return result.changes;
}

export function revokeAllUserSessionsExcept(userId, keepToken) {
  const result = db.prepare('DELETE FROM Sessions WHERE UserId = ? AND Token != ?').run(userId, keepToken);
  return result.changes;
}

// ── Audit log ────────────────────────────────────────────────────────────────

export function logAudit({ userId = null, actorId = null, action, target = null, detail = null, ipAddress = null } = {}) {
  try {
    db.prepare(`
      INSERT INTO AuditLog (UserId, ActorId, Action, Target, Detail, IpAddress, Timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(userId, actorId, action, target, detail ? JSON.stringify(detail) : null, ipAddress, now());
  } catch (e) {
    // Audit log failures should never crash the app
    console.warn('[AuditLog] Write failed:', e.message);
  }
}

export function getAuditLog({ limit = 100, offset = 0, userId = null, action = null } = {}) {
  let sql = `
    SELECT a.Id, a.Action, a.Target, a.Detail, a.IpAddress, a.Timestamp,
           u.Username as username, actor.Username as actorUsername
    FROM AuditLog a
    LEFT JOIN Users u ON u.Id = a.UserId
    LEFT JOIN Users actor ON actor.Id = a.ActorId
  `;
  const params = [];
  const conditions = [];
  if (userId) { conditions.push('a.UserId = ?'); params.push(userId); }
  if (action) { conditions.push('a.Action = ?'); params.push(action); }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY a.Timestamp DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return db.prepare(sql).all(...params).map(r => ({
    id: r.Id,
    action: r.Action,
    target: r.Target,
    detail: r.Detail ? (() => { try { return JSON.parse(r.Detail); } catch { return r.Detail; } })() : null,
    ipAddress: r.IpAddress,
    timestamp: r.Timestamp,
    username: r.username,
    actorUsername: r.actorUsername,
  }));
}

// ── Invite tokens ─────────────────────────────────────────────────────────────

export function createInviteToken({ createdByUserId, email = null, note = null, expiresInHours = 72 } = {}) {
  const token = crypto.randomBytes(20).toString('hex'); // 40-char
  const expiresAt = new Date(Date.now() + expiresInHours * 3600000).toISOString();
  db.prepare(`
    INSERT INTO InviteTokens (Token, CreatedByUserId, Email, Note, ExpiresAt, CreatedAt)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(token, createdByUserId, email || null, note || null, expiresAt, now());
  return token;
}

export function getInviteToken(token) {
  const row = db.prepare(`
    SELECT it.*, u.Username as createdByUsername
    FROM InviteTokens it
    JOIN Users u ON u.Id = it.CreatedByUserId
    WHERE it.Token = ?
  `).get(token);
  if (!row) return null;
  return {
    token: row.Token,
    email: row.Email,
    note: row.Note,
    usedByUserId: row.UsedByUserId,
    usedAt: row.UsedAt,
    expiresAt: row.ExpiresAt,
    createdAt: row.CreatedAt,
    createdByUsername: row.createdByUsername,
    expired: row.ExpiresAt < now(),
    used: !!row.UsedByUserId,
  };
}

export function redeemInviteToken(token, newUserId) {
  const row = db.prepare('SELECT * FROM InviteTokens WHERE Token = ?').get(token);
  if (!row) return { valid: false, reason: 'Token not found' };
  if (row.UsedByUserId) return { valid: false, reason: 'Token already used' };
  if (row.ExpiresAt < now()) return { valid: false, reason: 'Token expired' };
  db.prepare('UPDATE InviteTokens SET UsedByUserId = ?, UsedAt = ? WHERE Token = ?')
    .run(newUserId, now(), token);
  return { valid: true, email: row.Email };
}

export function listInvites(createdByUserId = null) {
  let sql = `
    SELECT it.Token, it.Email, it.Note, it.ExpiresAt, it.CreatedAt,
           it.UsedAt, it.UsedByUserId,
           creator.Username as createdByUsername,
           used_user.Username as usedByUsername
    FROM InviteTokens it
    JOIN Users creator ON creator.Id = it.CreatedByUserId
    LEFT JOIN Users used_user ON used_user.Id = it.UsedByUserId
  `;
  const params = [];
  if (createdByUserId) { sql += ' WHERE it.CreatedByUserId = ?'; params.push(createdByUserId); }
  sql += ' ORDER BY it.CreatedAt DESC';
  return db.prepare(sql).all(...params).map(r => ({
    token: r.Token,
    email: r.Email,
    note: r.Note,
    expiresAt: r.ExpiresAt,
    createdAt: r.CreatedAt,
    usedAt: r.UsedAt,
    usedByUsername: r.usedByUsername,
    createdByUsername: r.createdByUsername,
    expired: r.ExpiresAt < now(),
    used: !!r.UsedByUserId,
  }));
}

export function revokeInviteToken(token) {
  db.prepare('DELETE FROM InviteTokens WHERE Token = ?').run(token);
}

// ── Usage statistics per user (admin view) ────────────────────────────────────

export function getUserDailyStats(userId, days = 30) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  return db.prepare(`
    SELECT Date as date, DeedSolves as deedSolves
    FROM UsageTracking
    WHERE UserId = ? AND Date >= ?
    ORDER BY Date ASC
  `).all(userId, since);
}

export function getSystemStats() {
  const userCount = db.prepare('SELECT COUNT(*) as c FROM Users').get().c;
  const proCount = db.prepare("SELECT COUNT(*) as c FROM Users WHERE Plan != 'free'").get().c;
  const sessionCount = db.prepare('SELECT COUNT(*) as c FROM Sessions WHERE ExpiresAt > ?').get(now()).c;
  const todayDate = now().slice(0, 10);
  const todaySolves = db.prepare('SELECT COALESCE(SUM(DeedSolves),0) as s FROM UsageTracking WHERE Date = ?').get(todayDate).s;
  const totalSolves = db.prepare('SELECT COALESCE(SUM(DeedSolves),0) as s FROM UsageTracking').get().s;
  return { userCount, proCount, sessionCount, todaySolves, totalSolves };
}
