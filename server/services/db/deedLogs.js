/**
 * db/deedLogs.js — All DeedLog and BatchRun CRUD operations.
 */

import fs from 'fs';
import { getDb, now, getDbPath, mapDeedLog } from './core.js';

// ── Batch Runs ────────────────────────────────────────────────────────────────

export function saveBatchRun(batchId, totalFiles, passRate) {
  getDb().prepare('INSERT OR REPLACE INTO BatchRuns (BatchId, Timestamp, TotalFiles, PassRate) VALUES (?, ?, ?, ?)')
    .run(batchId, now(), totalFiles, passRate);
}

export function getRecentBatchRuns() {
  return getDb().prepare('SELECT * FROM BatchRuns ORDER BY Timestamp DESC LIMIT 20').all().map(r => ({
    batchId: r.BatchId, timestamp: r.Timestamp, totalFiles: r.TotalFiles, passRate: r.PassRate,
  }));
}

export function getBatchStats(batchId) {
  const db = getDb();
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
    SELECT RepairStageUsed AS stage, COUNT(*) AS count,
           SUM(CASE WHEN Status='PASS' THEN 1 ELSE 0 END) AS passed
    FROM DeedLogs WHERE BatchId = ?
    GROUP BY RepairStageUsed ORDER BY count DESC LIMIT 12
  `).all(batchId).map(r => ({ stage: r.stage || 'Unknown', count: r.count, passed: r.passed }));

  const failedFiles = db.prepare(`
    SELECT FileName, LinearError, RepairStageUsed
    FROM DeedLogs WHERE BatchId = ? AND Status IN ('FAIL','ERROR')
    ORDER BY LinearError DESC LIMIT 50
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
      total: counts?.total || 0, passed: counts?.passed || 0, failed: counts?.failed || 0,
      errors: counts?.errors || 0, meanders: counts?.meanders || 0, skipped: counts?.skipped || 0,
    },
    passRate: (counts?.total > 0) ? (counts.passed / counts.total) : 0,
    precision: {
      avg: counts?.avgPrecision || 0, best: counts?.bestPrecision || 0,
      excellent: precisionBuckets?.excellent || 0, good: precisionBuckets?.good || 0,
      fair: precisionBuckets?.fair || 0, poor: precisionBuckets?.poor || 0,
    },
    closure: { avgLinearErr: counts?.avgLinearErr || 0, maxLinearErr: counts?.maxLinearErr || 0 },
    avgTrustScore: counts?.avgTrustScore || null,
    stages,
    failedFiles,
  };
}

export function getRecentBatchesWithStats(limit = 30) {
  const db = getDb();
  const batches = db.prepare('SELECT * FROM BatchRuns ORDER BY Timestamp DESC LIMIT ?').all(limit);
  if (batches.length === 0) return [];

  const placeholders = batches.map(() => '?').join(',');
  const batchIds = batches.map(b => b.BatchId);

  const rows = db.prepare(`
    SELECT BatchId, COUNT(*) AS total,
      SUM(CASE WHEN Status = 'PASS'    THEN 1 ELSE 0 END) AS passed,
      SUM(CASE WHEN Status = 'FAIL'    THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN Status = 'ERROR'   THEN 1 ELSE 0 END) AS errors,
      SUM(CASE WHEN Status = 'MEANDER' THEN 1 ELSE 0 END) AS meanders,
      SUM(CASE WHEN Status = 'SKIP'    THEN 1 ELSE 0 END) AS skipped,
      AVG(LinearError) AS avgLinearErr, MAX(LinearError) AS maxLinearErr,
      AVG(PrecisionRatio) AS avgPrecision, MAX(PrecisionRatio) AS bestPrecision
    FROM DeedLogs WHERE BatchId IN (${placeholders})
    GROUP BY BatchId
  `).all(...batchIds);

  const statsByBatch = Object.fromEntries(rows.map(r => [r.BatchId, r]));
  return batches.map(b => {
    const s = statsByBatch[b.BatchId] || {};
    return {
      batchId: b.BatchId, timestamp: b.Timestamp, totalFiles: b.TotalFiles, passRate: b.PassRate,
      stats: {
        batchId: b.BatchId,
        counts: { total: s.total||0, passed: s.passed||0, failed: s.failed||0, errors: s.errors||0, meanders: s.meanders||0, skipped: s.skipped||0 },
        passRate: s.total > 0 ? (s.passed / s.total) : 0,
        closure: { avgLinearErr: s.avgLinearErr || 0, maxLinearErr: s.maxLinearErr || 0 },
        precision: { avg: s.avgPrecision || 0, best: s.bestPrecision || 0 },
      },
    };
  });
}

// ── Deed Logs ─────────────────────────────────────────────────────────────────

export function saveDeedLog(batchId, fileName, parcelName, geoCallCount, linearError, precisionRatio, status, repairStageUsed, extractionJson = null, traverseJson = null, agentTurnsJson = null, trustScore = null, solutionStepsJson = null, referencePointName = null, referencePointNorthing = null, referencePointEasting = null, pobNorthing = null, pobEasting = null, fileHash = null) {
  let finalRefPointName = referencePointName;
  if (!finalRefPointName && extractionJson) {
    try {
      const parsed = JSON.parse(extractionJson);
      finalRefPointName = parsed.ReferencePointName || parsed.referencePointName || null;
    } catch {}
  }

  getDb().prepare(`
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
  const db = getDb();
  let finalRefPointName = referencePointName;
  if (!finalRefPointName && extractionJson) {
    try {
      const parsed = JSON.parse(extractionJson);
      finalRefPointName = parsed.ReferencePointName || parsed.referencePointName || null;
    } catch {}
  }

  const row = db.prepare('SELECT Id, BatchId FROM DeedLogs WHERE FileName = ? ORDER BY Timestamp DESC LIMIT 1').get(fileName);
  const batchId = row ? row.BatchId : 'CORRECTED';

  // Ensure batchId exists in BatchRuns to satisfy the foreign key constraint
  const batchExists = db.prepare('SELECT 1 FROM BatchRuns WHERE BatchId = ?').get(batchId);
  if (!batchExists) {
    db.prepare('INSERT INTO BatchRuns (BatchId, Timestamp, TotalFiles, PassRate) VALUES (?, ?, 0, 0.0)').run(batchId, now());
  }

  if (row) {
    db.prepare(`
      UPDATE DeedLogs
      SET Status = ?, RepairStageUsed = ?, ExtractionJson = ?, TraverseJson = ?, AgentTurnsJson = ?,
          TrustScore = ?, SolutionStepsJson = ?, Timestamp = ?,
          ReferencePointName = ?, ReferencePointNorthing = ?, ReferencePointEasting = ?,
          PobNorthing = ?, PobEasting = ?, FileHash = ?
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
  return getDb().prepare(sql).all(...params).map(mapDeedLog);
}

export function findSolvedCase(fileName, fileHash = null) {
  const db = getDb();
  let rows = [];
  if (fileHash) {
    rows = db.prepare(`
      SELECT * FROM DeedLogs
      WHERE FileHash = ? AND Status IN ('PASS', 'MEANDER')
        AND TraverseJson IS NOT NULL AND ExtractionJson IS NOT NULL AND GeoCallCount > 0
      ORDER BY Timestamp DESC LIMIT 5
    `).all(fileHash);
    if (rows.length === 0) {
      rows = db.prepare(`
        SELECT * FROM DeedLogs
        WHERE FileName = ? AND (FileHash IS NULL OR FileHash = '') AND Status IN ('PASS', 'MEANDER')
          AND TraverseJson IS NOT NULL AND ExtractionJson IS NOT NULL AND GeoCallCount > 0
        ORDER BY Timestamp DESC LIMIT 5
      `).all(fileName);
    }
  } else {
    rows = db.prepare(`
      SELECT * FROM DeedLogs
      WHERE FileName = ? AND Status IN ('PASS', 'MEANDER')
        AND TraverseJson IS NOT NULL AND ExtractionJson IS NOT NULL AND GeoCallCount > 0
      ORDER BY Timestamp DESC LIMIT 5
    `).all(fileName);
  }

  for (const row of rows) {
    try {
      const ex = JSON.parse(row.ExtractionJson);
      const courses = ex.courses || ex.Courses || [];
      if (courses.length > 0) return mapDeedLog(row);
    } catch {}
  }
  return null;
}

export function findSkippedCase(fileName, fileHash = null) {
  const db = getDb();
  let rows = [];
  if (fileHash) {
    rows = db.prepare(`SELECT * FROM DeedLogs WHERE FileHash = ? AND Status = 'SKIPPED' ORDER BY Timestamp DESC LIMIT 1`).all(fileHash);
    if (rows.length === 0) {
      rows = db.prepare(`SELECT * FROM DeedLogs WHERE FileName = ? AND (FileHash IS NULL OR FileHash = '') AND Status = 'SKIPPED' ORDER BY Timestamp DESC LIMIT 1`).all(fileName);
    }
  } else {
    rows = db.prepare(`SELECT * FROM DeedLogs WHERE FileName = ? AND Status = 'SKIPPED' ORDER BY Timestamp DESC LIMIT 1`).all(fileName);
  }
  return rows.length > 0 ? mapDeedLog(rows[0]) : null;
}

export function purgeStaleCache(fileName = null) {
  const db = getDb();
  let result;
  if (fileName) {
    result = db.prepare(`
      DELETE FROM DeedLogs WHERE Status = 'PASS' AND FileName = ?
        AND (PrecisionRatio >= 999999990 OR GeoCallCount = 0 OR TraverseJson IS NULL)
    `).run(fileName);
  } else {
    result = db.prepare(`
      DELETE FROM DeedLogs WHERE Status = 'PASS'
        AND (PrecisionRatio >= 999999990 OR GeoCallCount = 0 OR TraverseJson IS NULL)
    `).run();
  }
  return result.changes;
}

export function purgeOldLogs(retentionDays) {
  const db = getDb();
  const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString().replace('T', ' ').slice(0, 19);
  let deleted = 0;
  deleted += db.prepare('DELETE FROM DeedLogs WHERE Timestamp < ?').run(cutoff).changes;
  deleted += db.prepare('DELETE FROM BatchRuns WHERE Timestamp < ?').run(cutoff).changes;
  db.exec('VACUUM');
  return deleted;
}

export function clearFailedCache() {
  const db = getDb();
  const deleted = db.prepare("DELETE FROM DeedLogs WHERE Status != 'PASS'").run().changes;
  db.exec('VACUUM');
  return deleted;
}

export function clearAllCache() {
  const db = getDb();
  let deleted = 0;
  deleted += db.prepare('DELETE FROM DeedLogs').run().changes;
  deleted += db.prepare('DELETE FROM BatchRuns').run().changes;
  db.exec('VACUUM');
  return deleted;
}

export function getFailedFileNames() {
  return getDb().prepare(`
    SELECT DISTINCT FileName FROM DeedLogs d
    WHERE Status IN ('ERROR', 'FAIL')
      AND NOT EXISTS (
        SELECT 1 FROM DeedLogs p
        WHERE p.FileName = d.FileName AND p.Status IN ('PASS', 'MEANDER') AND p.Timestamp >= d.Timestamp
      )
    ORDER BY FileName
  `).all().map(r => r.FileName);
}

export function getFailedDeedList(limit = 200, bucket = null) {
  const bucketWhere = {
    nearClosed:    'AND LinearError <= 1.0',
    minorError:    'AND LinearError > 1.0 AND LinearError <= 10.0',
    moderateError: 'AND LinearError > 10.0 AND LinearError <= 100.0',
    majorError:    'AND LinearError > 100.0',
  }[bucket] || '';

  const rows = getDb().prepare(`
    SELECT d.FileName, d.LinearError, d.PrecisionRatio, d.Status, d.RepairStageUsed,
           d.Timestamp, d.BatchId, d.GeoCallCount, d.TrustScore, d.ExtractionJson
    FROM DeedLogs d
    INNER JOIN (
      SELECT FileName, MAX(Timestamp) AS LatestFailTs
      FROM DeedLogs WHERE Status IN ('FAIL','ERROR') ${bucketWhere} GROUP BY FileName
    ) latest ON d.FileName = latest.FileName AND d.Timestamp = latest.LatestFailTs
    WHERE d.Status IN ('FAIL','ERROR')
      AND NOT EXISTS (
        SELECT 1 FROM DeedLogs p
        WHERE p.FileName = d.FileName AND p.Status IN ('PASS','MEANDER') AND p.Timestamp >= d.Timestamp
      )
    ORDER BY d.LinearError DESC, d.FileName LIMIT ?
  `).all(limit);

  return rows.map(r => ({
    fileName: r.FileName, linearError: r.LinearError, precisionRatio: r.PrecisionRatio,
    status: r.Status, repairStageUsed: r.RepairStageUsed, timestamp: r.Timestamp,
    batchId: r.BatchId, geoCallCount: r.GeoCallCount, trustScore: r.TrustScore, parcelName: r.ParcelName,
    extractionSummary: (() => {
      try { const ex = JSON.parse(r.ExtractionJson || 'null'); return ex ? (ex.mentalMapSummary || ex.message || null) : null; } catch { return null; }
    })(),
  }));
}

export function getDeedDetail(fileName) {
  const r = getDb().prepare(`
    SELECT * FROM DeedLogs WHERE FileName = ? AND Status IN ('FAIL','ERROR','MEANDER')
    ORDER BY Timestamp DESC LIMIT 1
  `).get(fileName);
  if (!r) return null;

  let extraction = null, traverse = null, agentTurns = null;
  try { extraction = JSON.parse(r.ExtractionJson); } catch {}
  try { traverse   = JSON.parse(r.TraverseJson);   } catch {}
  try { agentTurns = JSON.parse(r.AgentTurnsJson); } catch {}

  return {
    id: r.Id, fileName: r.FileName, parcelName: r.ParcelName, status: r.Status,
    linearError: r.LinearError, precisionRatio: r.PrecisionRatio, geoCallCount: r.GeoCallCount,
    repairStageUsed: r.RepairStageUsed, timestamp: r.Timestamp, batchId: r.BatchId,
    trustScore: r.TrustScore, extraction, traverse, agentTurns, fileHash: r.FileHash,
  };
}

export function getSolutionSteps(fileName) {
  const row = getDb().prepare(`
    SELECT SolutionStepsJson, RepairStageUsed, Status, Timestamp
    FROM DeedLogs WHERE FileName = ? AND SolutionStepsJson IS NOT NULL
    ORDER BY Timestamp DESC LIMIT 1
  `).get(fileName);
  if (!row) return null;
  try {
    return { fileName, repairStageUsed: row.RepairStageUsed, status: row.Status, timestamp: row.Timestamp, steps: JSON.parse(row.SolutionStepsJson) };
  } catch { return null; }
}

export function getDatabaseStats() {
  const db = getDb();
  const dbPath = getDbPath();
  let fileSizeBytes = 0;
  try { fileSizeBytes = fs.statSync(dbPath).size; } catch {}

  const deedLogCount = db.prepare('SELECT COUNT(*) as c FROM DeedLogs').get().c;
  const currentStatusCounts = db.prepare(`
    SELECT Status, COUNT(*) as cnt FROM (
      SELECT FileName, Status FROM DeedLogs d
      WHERE Timestamp = (SELECT MAX(Timestamp) FROM DeedLogs WHERE FileName = d.FileName)
      GROUP BY FileName
    ) GROUP BY Status
  `).all();
  const _sm = Object.fromEntries(currentStatusCounts.map(r => [r.Status, r.cnt]));
  const batchRunCount = db.prepare('SELECT COUNT(*) as c FROM BatchRuns').get().c;
  const heuristicCount = db.prepare('SELECT COUNT(*) as c FROM HeuristicTracking').get().c;
  const range = db.prepare('SELECT MIN(Timestamp) as oldest, MAX(Timestamp) as newest FROM DeedLogs').get();

  const classifications = db.prepare(`
    SELECT
      CASE WHEN ExtractionJson IS NOT NULL AND json_valid(ExtractionJson) THEN json_extract(ExtractionJson, '$.Classification')
           WHEN ParcelName LIKE '[%]%' THEN substr(ParcelName, 2, instr(ParcelName, ']') - 2)
           ELSE 'UNKNOWN' END as class,
      COUNT(*) as count,
      SUM(CASE WHEN Status = 'PASS' THEN 1 ELSE 0 END) as passed,
      SUM(CASE WHEN Status = 'FAIL' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN Status = 'MEANDER' THEN 1 ELSE 0 END) as meanders,
      SUM(CASE WHEN Status = 'ERROR' THEN 1 ELSE 0 END) as errors
    FROM DeedLogs GROUP BY class ORDER BY count DESC
  `).all().map(c => ({ class: c.class || 'UNKNOWN', count: c.count, passed: c.passed, failed: c.failed, meanders: c.meanders, errors: c.errors }));

  const repairStages = db.prepare(`
    SELECT RepairStageUsed as stage, COUNT(*) as count, SUM(CASE WHEN Status = 'PASS' THEN 1 ELSE 0 END) as passed
    FROM DeedLogs WHERE stage IS NOT NULL AND stage != '' GROUP BY stage ORDER BY count DESC
  `).all().map(s => ({ stage: s.stage || 'Unknown', count: s.count, passed: s.passed }));

  const errors = db.prepare(`
    SELECT
      SUM(CASE WHEN LinearError <= 1.0 THEN 1 ELSE 0 END) as nearClosed,
      SUM(CASE WHEN LinearError > 1.0 AND LinearError <= 10.0 THEN 1 ELSE 0 END) as minorError,
      SUM(CASE WHEN LinearError > 10.0 AND LinearError <= 100.0 THEN 1 ELSE 0 END) as moderateError,
      SUM(CASE WHEN LinearError > 100.0 THEN 1 ELSE 0 END) as majorError
    FROM DeedLogs d WHERE Status = 'FAIL'
      AND NOT EXISTS (SELECT 1 FROM DeedLogs p WHERE p.FileName = d.FileName AND p.Status IN ('PASS','MEANDER') AND p.Timestamp >= d.Timestamp)
  `).get();

  return {
    dbPath, fileSizeMb: Math.round(fileSizeBytes / 1048576 * 100) / 100, fileSizeBytes,
    deedLogCount, passCount: _sm['PASS']||0, failCount: _sm['FAIL']||0,
    meanderCount: _sm['MEANDER']||0, errorCount: _sm['ERROR']||0,
    batchRunCount, heuristicCount,
    oldestTimestamp: range?.oldest || null, newestTimestamp: range?.newest || null,
    classifications, repairStages,
    errorDistribution: { nearClosed: errors?.nearClosed||0, minorError: errors?.minorError||0, moderateError: errors?.moderateError||0, majorError: errors?.majorError||0 },
  };
}

export function getHeuristicTracking() {
  return getDb().prepare('SELECT * FROM HeuristicTracking ORDER BY SuccessCount DESC').all().map(r => ({
    id: r.Id, problemName: r.ProblemName, solutionApplied: r.SolutionApplied, successCount: r.SuccessCount,
  }));
}

export function incrementHeuristic(problemName, solutionApplied) {
  const db = getDb();
  const row = db.prepare('SELECT Id FROM HeuristicTracking WHERE ProblemName = ? AND SolutionApplied = ?').get(problemName, solutionApplied);
  if (row) {
    db.prepare('UPDATE HeuristicTracking SET SuccessCount = SuccessCount + 1 WHERE Id = ?').run(row.Id);
  } else {
    db.prepare('INSERT INTO HeuristicTracking (ProblemName, SolutionApplied, SuccessCount) VALUES (?, ?, 1)').run(problemName, solutionApplied);
  }
}

export function getDeedsByReferencePoint(refPointName) {
  return getDb().prepare(`
    SELECT * FROM DeedLogs WHERE ReferencePointName = ? AND Status IN ('PASS', 'MEANDER') ORDER BY Timestamp DESC
  `).all(refPointName).map(mapDeedLog);
}

export function getDistinctReferencePoints() {
  return getDb().prepare(`
    SELECT DISTINCT ReferencePointName FROM DeedLogs
    WHERE ReferencePointName IS NOT NULL AND ReferencePointName != ''
    ORDER BY ReferencePointName
  `).all().map(r => r.ReferencePointName);
}
