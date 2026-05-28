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
  // Use same path as the C# version for backwards compatibility
  const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const folder = path.join(configDir, 'BoundaryQC');
  fs.mkdirSync(folder, { recursive: true });
  dbPath = path.join(folder, 'BoundaryQCDiagnostics.db');

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
      Timestamp TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS Sessions (
      Token TEXT PRIMARY KEY,
      UserId INTEGER NOT NULL,
      ExpiresAt TEXT NOT NULL,
      FOREIGN KEY (UserId) REFERENCES Users(Id) ON DELETE CASCADE
    );
  `);

  // Migrations (safe — silently ignored if columns already exist)
  try { db.exec('ALTER TABLE DeedLogs ADD COLUMN ExtractionJson TEXT'); } catch {}
  try { db.exec('ALTER TABLE DeedLogs ADD COLUMN TraverseJson TEXT'); } catch {}
  try { db.exec('ALTER TABLE DeedLogs ADD COLUMN AgentTurnsJson TEXT'); } catch {}
  try { db.exec('ALTER TABLE DeedLogs ADD COLUMN TrustScore REAL'); } catch {}
  try { db.exec('ALTER TABLE DeedLogs ADD COLUMN SolutionStepsJson TEXT'); } catch {}

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

export function saveDeedLog(batchId, fileName, parcelName, geoCallCount, linearError, precisionRatio, status, repairStageUsed, extractionJson = null, traverseJson = null, agentTurnsJson = null, trustScore = null, solutionStepsJson = null) {
  db.prepare(`INSERT INTO DeedLogs (BatchId, FileName, ParcelName, GeoCallCount, LinearError, PrecisionRatio, Status, RepairStageUsed, Timestamp, ExtractionJson, TraverseJson, AgentTurnsJson, TrustScore, SolutionStepsJson) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(batchId, fileName, parcelName, geoCallCount, linearError, precisionRatio, status, repairStageUsed, now(), extractionJson, traverseJson, agentTurnsJson, trustScore, solutionStepsJson);
}

export function saveCorrectedDeed(fileName, parcelName, status, repairStageUsed, extractionJson, traverseJson, agentTurnsJson = null, trustScore = null, solutionStepsJson = null) {
  const row = db.prepare("SELECT Id, BatchId FROM DeedLogs WHERE FileName = ? ORDER BY Timestamp DESC LIMIT 1").get(fileName);
  const batchId = row ? row.BatchId : 'CORRECTED';
  
  if (row) {
    db.prepare(`
      UPDATE DeedLogs 
      SET Status = ?, RepairStageUsed = ?, ExtractionJson = ?, TraverseJson = ?, AgentTurnsJson = ?, TrustScore = ?, SolutionStepsJson = ?, Timestamp = ?
      WHERE Id = ?
    `).run(status, repairStageUsed, extractionJson, traverseJson, agentTurnsJson, trustScore, solutionStepsJson, now(), row.Id);
    return row.Id;
  } else {
    const result = db.prepare(`
      INSERT INTO DeedLogs (BatchId, FileName, ParcelName, GeoCallCount, LinearError, PrecisionRatio, Status, RepairStageUsed, Timestamp, ExtractionJson, TraverseJson, AgentTurnsJson, TrustScore, SolutionStepsJson)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(batchId, fileName, parcelName || 'Manual Corrected', 0, 0, 0, status, repairStageUsed, now(), extractionJson, traverseJson, agentTurnsJson, trustScore, solutionStepsJson);
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

export function findSolvedCase(fileName) {
  // Find the most recent PASS entry with real extraction data.
  // Guards against stale cache from degenerate/zero-segment runs:
  //   1. Must have ExtractionJson with at least 1 course
  //   2. PrecisionRatio must be a genuine survey value (>= 500), not the 999999999
  //      sentinel that zero-segment traverses produce
  //   3. Must have TraverseJson (computed result)
  //   4. GeoCallCount > 0 (courses were actually extracted)
  const rows = db.prepare(
    `SELECT * FROM DeedLogs
     WHERE FileName = ? AND Status = 'PASS'
       AND TraverseJson IS NOT NULL
       AND ExtractionJson IS NOT NULL
       AND GeoCallCount > 0
       AND PrecisionRatio >= 500
       AND PrecisionRatio < 999999990
     ORDER BY Timestamp DESC LIMIT 5`
  ).all(fileName);

  // Pick the first row whose ExtractionJson actually contains courses
  for (const row of rows) {
    try {
      const ex = JSON.parse(row.ExtractionJson);
      const courses = ex.courses || ex.Courses || [];
      if (courses.length > 0) {
        console.log(`Cache hit for ${fileName}: ${courses.length} courses, ratio=${row.PrecisionRatio}`);
        return mapDeedLog(row);
      }
    } catch { /* invalid JSON — skip */ }
  }

  return null; // No valid cache entry found
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
           d.Timestamp, d.BatchId, d.GeoCallCount, d.TrustScore
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
 * Recent batch runs enriched with inline stats (no second query needed in UI).
 */
export function getRecentBatchesWithStats(limit = 30) {
  const batches = db.prepare('SELECT * FROM BatchRuns ORDER BY Timestamp DESC LIMIT ?').all(limit);
  return batches.map(b => {
    const stats = getBatchStats(b.BatchId);
    return {
      batchId:   b.BatchId,
      timestamp: b.Timestamp,
      totalFiles: b.TotalFiles,
      passRate:   b.PassRate,
      stats,
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

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, originalHash] = storedHash.split(':');
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return hash === originalHash;
}

export function createUser(username, password, role = 'user') {
  // Check if duplicate user exists
  const existing = db.prepare('SELECT Id FROM Users WHERE Username = ?').get(username);
  if (existing) {
    throw new Error('Username already exists');
  }
  const passwordHash = hashPassword(password);
  const result = db.prepare('INSERT INTO Users (Username, PasswordHash, Role, Timestamp) VALUES (?, ?, ?, ?)')
    .run(username, passwordHash, role, now());
  
  return {
    id: result.lastInsertRowid,
    username,
    role
  };
}

export function verifyUser(username, password) {
  const row = db.prepare('SELECT * FROM Users WHERE Username = ?').get(username);
  if (!row) return null;
  const isValid = verifyPassword(password, row.PasswordHash);
  if (!isValid) return null;
  return {
    id: row.Id,
    username: row.Username,
    role: row.Role
  };
}

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  // Expires in 7 days
  const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare('INSERT INTO Sessions (Token, UserId, ExpiresAt) VALUES (?, ?, ?)')
    .run(token, userId, expiresAt);
  return token;
}

export function getSession(token) {
  const row = db.prepare(`
    SELECT s.Token, s.ExpiresAt, u.Id as UserId, u.Username, u.Role
    FROM Sessions s
    INNER JOIN Users u ON s.UserId = u.Id
    WHERE s.Token = ?
  `).get(token);

  if (!row) return null;

  // Check expiration
  const nowStr = now();
  if (row.ExpiresAt < nowStr) {
    db.prepare('DELETE FROM Sessions WHERE Token = ?').run(token);
    return null;
  }

  return {
    userId: row.UserId,
    username: row.Username,
    role: row.Role
  };
}

export function deleteSession(token) {
  db.prepare('DELETE FROM Sessions WHERE Token = ?').run(token);
}

export function findUserByUsername(username) {
  const row = db.prepare('SELECT Id as id, Username as username, Role as role FROM Users WHERE Username = ?').get(username);
  return row ? { id: row.id, username: row.username, role: row.role } : null;
}

