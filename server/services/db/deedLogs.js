/**
 * db/deedLogs.js — All DeedLog and BatchRun CRUD operations.
 */

import fs from 'fs';
import { query, now, getDbPath, mapDeedLog, getIsPostgres } from './core.js';
import { getStore } from './context.js';

// ── Batch Runs ────────────────────────────────────────────────────────────────

export async function saveBatchRun(batchId, totalFiles, passRate, userId) {
  const finalUserId = userId !== undefined ? userId : (getStore()?.userId || null);
  await query(`
    INSERT INTO BatchRuns (BatchId, Timestamp, TotalFiles, PassRate, UserId)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (BatchId) DO UPDATE SET
      Timestamp = EXCLUDED.Timestamp,
      TotalFiles = EXCLUDED.TotalFiles,
      PassRate = EXCLUDED.PassRate,
      UserId = EXCLUDED.UserId
  `, [batchId, now(), totalFiles, passRate, finalUserId]);
}

export async function getRecentBatchRuns() {
  const res = await query('SELECT * FROM BatchRuns ORDER BY Timestamp DESC LIMIT 20');
  return res.rows.map(r => ({
    batchId: r.BatchId, timestamp: r.Timestamp, totalFiles: r.TotalFiles, passRate: r.PassRate,
  }));
}

export async function getBatchStats(batchId) {
  const countsRes = await query(`
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
  `, [batchId]);
  const counts = countsRes.rows[0];

  const stagesRes = await query(`
    SELECT RepairStageUsed AS stage, COUNT(*) AS count,
           SUM(CASE WHEN Status='PASS' THEN 1 ELSE 0 END) AS passed
    FROM DeedLogs WHERE BatchId = ?
    GROUP BY RepairStageUsed ORDER BY count DESC LIMIT 12
  `, [batchId]);
  const stages = stagesRes.rows.map(r => ({ stage: r.stage || 'Unknown', count: parseInt(r.count || 0), passed: parseInt(r.passed || 0) }));

  const failedFilesRes = await query(`
    SELECT FileName, LinearError, RepairStageUsed
    FROM DeedLogs WHERE BatchId = ? AND Status IN ('FAIL','ERROR')
    ORDER BY LinearError DESC LIMIT 50
  `, [batchId]);
  const failedFiles = failedFilesRes.rows.map(r => ({ fileName: r.FileName, linearError: r.LinearError, stage: r.RepairStageUsed }));

  const precisionBucketsRes = await query(`
    SELECT
      SUM(CASE WHEN PrecisionRatio >= 50000  AND PrecisionRatio < 999999990 THEN 1 ELSE 0 END) AS excellent,
      SUM(CASE WHEN PrecisionRatio >= 10000  AND PrecisionRatio <  50000    THEN 1 ELSE 0 END) AS good,
      SUM(CASE WHEN PrecisionRatio >=  5000  AND PrecisionRatio <  10000    THEN 1 ELSE 0 END) AS fair,
      SUM(CASE WHEN PrecisionRatio >       0 AND PrecisionRatio <   5000    THEN 1 ELSE 0 END) AS poor
    FROM DeedLogs WHERE BatchId = ? AND Status = 'PASS'
  `, [batchId]);
  const precisionBuckets = precisionBucketsRes.rows[0];

  return {
    batchId,
    counts: {
      total: parseInt(counts?.total || 0), passed: parseInt(counts?.passed || 0), failed: parseInt(counts?.failed || 0),
      errors: parseInt(counts?.errors || 0), meanders: parseInt(counts?.meanders || 0), skipped: parseInt(counts?.skipped || 0),
    },
    passRate: (counts?.total > 0) ? (counts.passed / counts.total) : 0,
    precision: {
      avg: parseFloat(counts?.avgPrecision || 0), best: parseFloat(counts?.bestPrecision || 0),
      excellent: parseInt(precisionBuckets?.excellent || 0), good: parseInt(precisionBuckets?.good || 0),
      fair: parseInt(precisionBuckets?.fair || 0), poor: parseInt(precisionBuckets?.poor || 0),
    },
    closure: { avgLinearErr: parseFloat(counts?.avgLinearErr || 0), maxLinearErr: parseFloat(counts?.maxLinearErr || 0) },
    avgTrustScore: counts?.avgTrustScore !== null ? parseFloat(counts.avgTrustScore) : null,
    stages,
    failedFiles,
  };
}

export async function getRecentBatchesWithStats(limit = 30, userId = null) {
  let queryStr = 'SELECT * FROM BatchRuns';
  const params = [];
  if (userId) {
    queryStr += ' WHERE UserId = ?';
    params.push(userId);
  }
  queryStr += ' ORDER BY Timestamp DESC LIMIT ?';
  params.push(limit);

  const res = await query(queryStr, params);
  const batches = res.rows;
  if (batches.length === 0) return [];

  // Batch all stats queries using IN(...) to avoid N+1 round trips
  const batchIds = batches.map(b => b.BatchId);
  const placeholders = batchIds.map(() => '?').join(',');

  const [countsRes, stagesRes, failedRes, precisionRes] = await Promise.all([
    query(`
      SELECT BatchId,
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
        AVG(CASE WHEN Status='FAIL' THEN LinearError  ELSE NULL END) AS avgLinearErr,
        MAX(CASE WHEN Status='FAIL' THEN LinearError  ELSE NULL END) AS maxLinearErr,
        AVG(CASE WHEN Status='PASS' THEN TrustScore   ELSE NULL END) AS avgTrustScore
      FROM DeedLogs WHERE BatchId IN (${placeholders})
      GROUP BY BatchId
    `, batchIds),
    query(`
      SELECT BatchId, RepairStageUsed AS stage, COUNT(*) AS count,
             SUM(CASE WHEN Status='PASS' THEN 1 ELSE 0 END) AS passed
      FROM DeedLogs WHERE BatchId IN (${placeholders})
      GROUP BY BatchId, RepairStageUsed ORDER BY count DESC
    `, batchIds),
    query(`
      SELECT BatchId, FileName, LinearError, RepairStageUsed
      FROM DeedLogs WHERE BatchId IN (${placeholders}) AND Status IN ('FAIL','ERROR')
      ORDER BY LinearError DESC
    `, batchIds),
    query(`
      SELECT BatchId,
        SUM(CASE WHEN PrecisionRatio >= 50000  AND PrecisionRatio < 999999990 THEN 1 ELSE 0 END) AS excellent,
        SUM(CASE WHEN PrecisionRatio >= 10000  AND PrecisionRatio < 50000     THEN 1 ELSE 0 END) AS good,
        SUM(CASE WHEN PrecisionRatio >=  5000  AND PrecisionRatio < 10000     THEN 1 ELSE 0 END) AS fair,
        SUM(CASE WHEN PrecisionRatio >       0 AND PrecisionRatio < 5000      THEN 1 ELSE 0 END) AS poor
      FROM DeedLogs WHERE BatchId IN (${placeholders}) AND Status = 'PASS'
      GROUP BY BatchId
    `, batchIds),
  ]);

  // Index results by BatchId for O(1) lookup
  const countsMap    = Object.fromEntries(countsRes.rows.map(r => [r.BatchId, r]));
  const precisionMap = Object.fromEntries(precisionRes.rows.map(r => [r.BatchId, r]));
  const stagesMap    = {};
  const failedMap    = {};
  for (const r of stagesRes.rows) {
    if (!stagesMap[r.BatchId]) stagesMap[r.BatchId] = [];
    if (stagesMap[r.BatchId].length < 12) {
      stagesMap[r.BatchId].push({ stage: r.stage || 'Unknown', count: parseInt(r.count || 0), passed: parseInt(r.passed || 0) });
    }
  }
  for (const r of failedRes.rows) {
    if (!failedMap[r.BatchId]) failedMap[r.BatchId] = [];
    if (failedMap[r.BatchId].length < 50) {
      failedMap[r.BatchId].push({ fileName: r.FileName, linearError: r.LinearError, stage: r.RepairStageUsed });
    }
  }

  return batches.map(b => {
    const counts = countsMap[b.BatchId] || {};
    const prec   = precisionMap[b.BatchId] || {};
    return {
      batchId:    b.BatchId,
      timestamp:  b.Timestamp,
      totalFiles: b.TotalFiles,
      passRate:   b.PassRate,
      stats: {
        batchId: b.BatchId,
        counts: {
          total:    parseInt(counts.total    || 0),
          passed:   parseInt(counts.passed   || 0),
          failed:   parseInt(counts.failed   || 0),
          errors:   parseInt(counts.errors   || 0),
          meanders: parseInt(counts.meanders || 0),
          skipped:  parseInt(counts.skipped  || 0),
        },
        passRate: counts.total > 0 ? (counts.passed / counts.total) : 0,
        precision: {
          avg:       parseFloat(counts.avgPrecision || 0),
          best:      parseFloat(counts.bestPrecision || 0),
          excellent: parseInt(prec.excellent || 0),
          good:      parseInt(prec.good      || 0),
          fair:      parseInt(prec.fair      || 0),
          poor:      parseInt(prec.poor      || 0),
        },
        closure:       { avgLinearErr: parseFloat(counts.avgLinearErr || 0), maxLinearErr: parseFloat(counts.maxLinearErr || 0) },
        avgTrustScore: counts.avgTrustScore != null ? parseFloat(counts.avgTrustScore) : null,
        stages:      stagesMap[b.BatchId] || [],
        failedFiles: failedMap[b.BatchId] || [],
      },
    };
  });
}

// ── Deed Logs ─────────────────────────────────────────────────────────────────

export async function saveDeedLog(batchId, fileName, parcelName, geoCallCount, linearError, precisionRatio, status, repairStageUsed, extractionJson = null, traverseJson = null, agentTurnsJson = null, trustScore = null, solutionStepsJson = null, referencePointName = null, referencePointNorthing = null, referencePointEasting = null, pobNorthing = null, pobEasting = null, fileHash = null) {
  // Ensure batchId exists in BatchRuns to satisfy the foreign key constraint
  const batchExistsRes = await query('SELECT 1 FROM BatchRuns WHERE BatchId = ?', [batchId]);
  if (!batchExistsRes.rows[0]) {
    await query('INSERT INTO BatchRuns (BatchId, Timestamp, TotalFiles, PassRate) VALUES (?, ?, 0, 0.0)', [batchId, now()]);
  }

  let finalRefPointName = referencePointName;
  if (!finalRefPointName && extractionJson) {
    try {
      const parsed = typeof extractionJson === 'string' ? JSON.parse(extractionJson) : extractionJson;
      finalRefPointName = parsed.ReferencePointName || parsed.referencePointName || null;
    } catch {}
  }

  await query(`
    INSERT INTO DeedLogs (
      BatchId, FileName, ParcelName, GeoCallCount, LinearError, PrecisionRatio, Status, RepairStageUsed, Timestamp,
      ExtractionJson, TraverseJson, AgentTurnsJson, TrustScore, SolutionStepsJson,
      ReferencePointName, ReferencePointNorthing, ReferencePointEasting, PobNorthing, PobEasting, FileHash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    batchId, fileName, parcelName, geoCallCount, linearError, precisionRatio, status, repairStageUsed, now(),
    typeof extractionJson === 'object' && extractionJson !== null ? JSON.stringify(extractionJson) : extractionJson,
    typeof traverseJson === 'object' && traverseJson !== null ? JSON.stringify(traverseJson) : traverseJson,
    typeof agentTurnsJson === 'object' && agentTurnsJson !== null ? JSON.stringify(agentTurnsJson) : agentTurnsJson,
    trustScore,
    typeof solutionStepsJson === 'object' && solutionStepsJson !== null ? JSON.stringify(solutionStepsJson) : solutionStepsJson,
    finalRefPointName, referencePointNorthing, referencePointEasting, pobNorthing, pobEasting, fileHash
  ]);
}

export async function saveCorrectedDeed(fileName, parcelName, status, repairStageUsed, extractionJson, traverseJson, agentTurnsJson = null, trustScore = null, solutionStepsJson = null, referencePointName = null, referencePointNorthing = null, referencePointEasting = null, pobNorthing = null, pobEasting = null, fileHash = null) {
  let finalRefPointName = referencePointName;
  if (!finalRefPointName && extractionJson) {
    try {
      const parsed = typeof extractionJson === 'string' ? JSON.parse(extractionJson) : extractionJson;
      finalRefPointName = parsed.ReferencePointName || parsed.referencePointName || null;
    } catch {}
  }

  const rowRes = await query('SELECT Id, BatchId FROM DeedLogs WHERE LOWER(FileName) = LOWER(?) ORDER BY Timestamp DESC LIMIT 1', [fileName]);
  const row = rowRes.rows[0];
  const batchId = row ? row.BatchId : 'CORRECTED';

  // Ensure batchId exists in BatchRuns to satisfy the foreign key constraint
  const batchExistsRes = await query('SELECT 1 FROM BatchRuns WHERE BatchId = ?', [batchId]);
  if (!batchExistsRes.rows[0]) {
    await query('INSERT INTO BatchRuns (BatchId, Timestamp, TotalFiles, PassRate) VALUES (?, ?, 0, 0.0)', [batchId, now()]);
  }

  const extStr = typeof extractionJson === 'object' && extractionJson !== null ? JSON.stringify(extractionJson) : extractionJson;
  const travStr = typeof traverseJson === 'object' && traverseJson !== null ? JSON.stringify(traverseJson) : traverseJson;
  const turnsStr = typeof agentTurnsJson === 'object' && agentTurnsJson !== null ? JSON.stringify(agentTurnsJson) : agentTurnsJson;
  const stepsStr = typeof solutionStepsJson === 'object' && solutionStepsJson !== null ? JSON.stringify(solutionStepsJson) : solutionStepsJson;

  if (row) {
    await query(`
      UPDATE DeedLogs
      SET Status = ?, RepairStageUsed = ?, ExtractionJson = ?, TraverseJson = ?, AgentTurnsJson = ?,
          TrustScore = ?, SolutionStepsJson = ?, Timestamp = ?,
          ReferencePointName = ?, ReferencePointNorthing = ?, ReferencePointEasting = ?,
          PobNorthing = ?, PobEasting = ?, FileHash = ?
      WHERE Id = ?
    `, [
      status, repairStageUsed, extStr, travStr, turnsStr, trustScore, stepsStr, now(),
      finalRefPointName, referencePointNorthing, referencePointEasting, pobNorthing, pobEasting, fileHash, row.Id
    ]);
    return row.Id;
  } else {
    const result = await query(`
      INSERT INTO DeedLogs (
        BatchId, FileName, ParcelName, GeoCallCount, LinearError, PrecisionRatio, Status, RepairStageUsed, Timestamp,
        ExtractionJson, TraverseJson, AgentTurnsJson, TrustScore, SolutionStepsJson,
        ReferencePointName, ReferencePointNorthing, ReferencePointEasting, PobNorthing, PobEasting, FileHash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING Id
    `, [
      batchId, fileName, parcelName || 'Manual Corrected', 0, 0, 0, status, repairStageUsed, now(),
      extStr, travStr, turnsStr, trustScore, stepsStr,
      finalRefPointName, referencePointNorthing, referencePointEasting, pobNorthing, pobEasting, fileHash
    ]);
    return result.rows[0]?.Id || result.rows[0]?.id;
  }
}

export async function searchDeedLogs(queryStr, status, maxError, userId = null) {
  let sql = 'SELECT d.* FROM DeedLogs d';
  if (userId) {
    sql += ' JOIN BatchRuns b ON d.BatchId = b.BatchId';
  }
  sql += ' WHERE 1=1';
  const params = [];
  if (userId) {
    sql += ' AND b.UserId = ?';
    params.push(userId);
  }
  if (queryStr) {
    sql += ' AND (d.FileName LIKE ? OR d.ParcelName LIKE ?)';
    params.push(`%${queryStr}%`, `%${queryStr}%`);
  }
  if (status) {
    sql += ' AND LOWER(d.Status) = LOWER(?)';
    params.push(status);
  }
  if (maxError != null) {
    sql += ' AND d.LinearError <= ?';
    params.push(maxError);
  }
  sql += ' ORDER BY d.Timestamp DESC LIMIT 100';

  const res = await query(sql, params);
  return res.rows.map(mapDeedLog);
}

export async function findSolvedCase(fileName, fileHash = null) {
  let rows = [];
  if (fileHash) {
    const resHash = await query(`
      SELECT * FROM DeedLogs
      WHERE FileHash = ? AND Status IN ('PASS', 'MEANDER')
        AND TraverseJson IS NOT NULL AND ExtractionJson IS NOT NULL AND GeoCallCount > 0
      ORDER BY Timestamp DESC LIMIT 5
    `, [fileHash]);
    rows = resHash.rows;

    if (rows.length === 0) {
      const resFile = await query(`
        SELECT * FROM DeedLogs
        WHERE LOWER(FileName) = LOWER(?) AND (FileHash IS NULL OR FileHash = '') AND Status IN ('PASS', 'MEANDER')
          AND TraverseJson IS NOT NULL AND ExtractionJson IS NOT NULL AND GeoCallCount > 0
        ORDER BY Timestamp DESC LIMIT 5
      `, [fileName]);
      rows = resFile.rows;
    }
  } else {
    const resFileOnly = await query(`
      SELECT * FROM DeedLogs
      WHERE LOWER(FileName) = LOWER(?) AND Status IN ('PASS', 'MEANDER')
        AND TraverseJson IS NOT NULL AND ExtractionJson IS NOT NULL AND GeoCallCount > 0
      ORDER BY Timestamp DESC LIMIT 5
    `, [fileName]);
    rows = resFileOnly.rows;
  }

  for (const row of rows) {
    try {
      const ex = typeof row.ExtractionJson === 'string' ? JSON.parse(row.ExtractionJson) : row.ExtractionJson;
      const courses = ex.courses || ex.Courses || [];
      if (courses.length > 0) return mapDeedLog(row);
    } catch {}
  }
  return null;
}

export async function findSkippedCase(fileName, fileHash = null) {
  let rows = [];
  if (fileHash) {
    const resHash = await query(`SELECT * FROM DeedLogs WHERE FileHash = ? AND Status = 'SKIPPED' ORDER BY Timestamp DESC LIMIT 1`, [fileHash]);
    rows = resHash.rows;
    if (rows.length === 0) {
      const resFile = await query(`SELECT * FROM DeedLogs WHERE LOWER(FileName) = LOWER(?) AND (FileHash IS NULL OR FileHash = '') AND Status = 'SKIPPED' ORDER BY Timestamp DESC LIMIT 1`, [fileName]);
      rows = resFile.rows;
    }
  } else {
    const resFileOnly = await query(`SELECT * FROM DeedLogs WHERE LOWER(FileName) = LOWER(?) AND Status = 'SKIPPED' ORDER BY Timestamp DESC LIMIT 1`, [fileName]);
    rows = resFileOnly.rows;
  }
  return rows.length > 0 ? mapDeedLog(rows[0]) : null;
}

export async function purgeStaleCache(fileName = null) {
  let result;
  if (fileName) {
    result = await query(`
      DELETE FROM DeedLogs WHERE Status = 'PASS' AND LOWER(FileName) = LOWER(?)
        AND (PrecisionRatio >= 999999990 OR GeoCallCount = 0 OR TraverseJson IS NULL)
    `, [fileName]);
  } else {
    result = await query(`
      DELETE FROM DeedLogs WHERE Status = 'PASS'
        AND (PrecisionRatio >= 999999990 OR GeoCallCount = 0 OR TraverseJson IS NULL)
    `);
  }
  return result.changes;
}

export async function purgeOldLogs(retentionDays) {
  const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString().replace('T', ' ').slice(0, 19);
  let deleted = 0;
  const delLogs = await query('DELETE FROM DeedLogs WHERE Timestamp < ?', [cutoff]);
  deleted += delLogs.changes;
  const delBatches = await query('DELETE FROM BatchRuns WHERE Timestamp < ?', [cutoff]);
  deleted += delBatches.changes;
  if (!getIsPostgres()) {
    // Defer VACUUM so it does not block the HTTP response
    setImmediate(async () => {
      const db = await import('./core.js').then(m => m.getDb());
      try { db.exec('VACUUM'); } catch {}
    });
  }
  return deleted;
}

export async function clearFailedCache() {
  const del = await query("DELETE FROM DeedLogs WHERE Status != 'PASS'");
  if (!getIsPostgres()) {
    setImmediate(async () => {
      const db = await import('./core.js').then(m => m.getDb());
      try { db.exec('VACUUM'); } catch {}
    });
  }
  return del.changes;
}

export async function clearAllCache() {
  let deleted = 0;
  const delLogs = await query('DELETE FROM DeedLogs');
  deleted += delLogs.changes;
  const delBatches = await query('DELETE FROM BatchRuns');
  deleted += delBatches.changes;
  if (!getIsPostgres()) {
    setImmediate(async () => {
      const db = await import('./core.js').then(m => m.getDb());
      try { db.exec('VACUUM'); } catch {}
    });
  }
  return deleted;
}

export async function getFailedFileNames() {
  const res = await query(`
    SELECT DISTINCT FileName FROM DeedLogs d
    WHERE Status IN ('ERROR', 'FAIL')
      AND NOT EXISTS (
        SELECT 1 FROM DeedLogs p
        WHERE p.FileName = d.FileName AND p.Status IN ('PASS', 'MEANDER') AND p.Timestamp >= d.Timestamp
      )
    ORDER BY FileName
  `);
  return res.rows.map(r => r.FileName);
}

export async function getFailedDeedList(limit = 200, bucket = null) {
  const bucketWhere = {
    nearClosed:    'AND LinearError <= 1.0',
    minorError:    'AND d.LinearError > 1.0 AND d.LinearError <= 10.0',
    moderateError: 'AND d.LinearError > 10.0 AND d.LinearError <= 100.0',
    majorError:    'AND d.LinearError > 100.0',
  }[bucket] || '';

  const res = await query(`
    SELECT d.FileName, d.LinearError, d.PrecisionRatio, d.Status, d.RepairStageUsed,
           d.Timestamp, d.BatchId, d.GeoCallCount, d.TrustScore, d.ExtractionJson, d.ParcelName
    FROM DeedLogs d
    INNER JOIN (
      SELECT FileName, MAX(Timestamp) AS LatestFailTs
      FROM DeedLogs WHERE Status IN ('FAIL','ERROR') GROUP BY FileName
    ) latest ON d.FileName = latest.FileName AND d.Timestamp = latest.LatestFailTs
    WHERE d.Status IN ('FAIL','ERROR') ${bucketWhere}
      AND NOT EXISTS (
        SELECT 1 FROM DeedLogs p
        WHERE p.FileName = d.FileName AND p.Status IN ('PASS','MEANDER') AND p.Timestamp >= d.Timestamp
      )
    ORDER BY d.LinearError DESC, d.FileName LIMIT ?
  `, [limit]);

  return res.rows.map(r => ({
    fileName: r.FileName, linearError: r.LinearError, precisionRatio: r.PrecisionRatio,
    status: r.Status, repairStageUsed: r.RepairStageUsed, timestamp: r.Timestamp,
    batchId: r.BatchId, geoCallCount: r.GeoCallCount, trustScore: r.TrustScore, parcelName: r.ParcelName,
    extractionSummary: (() => {
      try {
        const ex = typeof r.ExtractionJson === 'string' ? JSON.parse(r.ExtractionJson || 'null') : r.ExtractionJson;
        return ex ? (ex.mentalMapSummary || ex.message || null) : null;
      } catch {
        return null;
      }
    })(),
  }));
}

export async function getDeedDetail(fileName) {
  const res = await query(`
    SELECT * FROM DeedLogs WHERE LOWER(FileName) = LOWER(?) AND Status IN ('FAIL','ERROR','MEANDER')
    ORDER BY Timestamp DESC LIMIT 1
  `, [fileName]);
  const r = res.rows[0];
  if (!r) return null;

  let extraction = null, traverse = null, agentTurns = null;
  try { extraction = typeof r.ExtractionJson === 'string' ? JSON.parse(r.ExtractionJson) : r.ExtractionJson; } catch {}
  try { traverse   = typeof r.TraverseJson === 'string' ? JSON.parse(r.TraverseJson) : r.TraverseJson;     } catch {}
  try { agentTurns = typeof r.AgentTurnsJson === 'string' ? JSON.parse(r.AgentTurnsJson) : r.AgentTurnsJson; } catch {}

  return {
    id: r.Id, fileName: r.FileName, parcelName: r.ParcelName, status: r.Status,
    linearError: r.LinearError, precisionRatio: r.PrecisionRatio, geoCallCount: r.GeoCallCount,
    repairStageUsed: r.RepairStageUsed, timestamp: r.Timestamp, batchId: r.BatchId,
    trustScore: r.TrustScore, extraction, traverse, agentTurns, fileHash: r.FileHash,
  };
}

export async function getSolutionSteps(fileName) {
  const res = await query(`
    SELECT SolutionStepsJson, RepairStageUsed, Status, Timestamp
    FROM DeedLogs WHERE LOWER(FileName) = LOWER(?) AND SolutionStepsJson IS NOT NULL
    ORDER BY Timestamp DESC LIMIT 1
  `, [fileName]);
  const row = res.rows[0];
  if (!row) return null;
  try {
    const steps = typeof row.SolutionStepsJson === 'string' ? JSON.parse(row.SolutionStepsJson) : row.SolutionStepsJson;
    return { fileName, repairStageUsed: row.RepairStageUsed, status: row.Status, timestamp: row.Timestamp, steps };
  } catch {
    return null;
  }
}

export async function getDatabaseStats(userId = null) {
  const dbPath = getDbPath();
  let fileSizeBytes = 0;
  if (!getIsPostgres()) {
    try { fileSizeBytes = fs.statSync(dbPath).size; } catch {}
  }

  // Run independent queries in parallel to halve response time
  const [
    countResult,
    runCountResult,
    rangeResult,
    heuristicResult,
    classificationsResult,
    repairStagesResult,
    currentStatusResult,
    errorsResult,
  ] = await Promise.all([
    userId
      ? query('SELECT COUNT(*) as c FROM DeedLogs d JOIN BatchRuns b ON d.BatchId = b.BatchId WHERE b.UserId = ?', [userId])
      : query('SELECT COUNT(*) as c FROM DeedLogs'),
    userId
      ? query('SELECT COUNT(*) as c FROM BatchRuns WHERE UserId = ?', [userId])
      : query('SELECT COUNT(*) as c FROM BatchRuns'),
    userId
      ? query('SELECT MIN(d.Timestamp) as oldest, MAX(d.Timestamp) as newest FROM DeedLogs d JOIN BatchRuns b ON d.BatchId = b.BatchId WHERE b.UserId = ?', [userId])
      : query('SELECT MIN(Timestamp) as oldest, MAX(Timestamp) as newest FROM DeedLogs'),
    query('SELECT COUNT(*) as c FROM HeuristicTracking'),
    getIsPostgres()
      ? query(`
          SELECT
            CASE WHEN d.ExtractionJson IS NOT NULL THEN d.ExtractionJson->>'Classification'
                 WHEN d.ParcelName LIKE '[%]%' THEN substring(d.ParcelName from 2 for position(']' in d.ParcelName) - 2)
                 ELSE 'UNKNOWN' END as class,
            COUNT(*) as count,
            SUM(CASE WHEN d.Status = 'PASS' THEN 1 ELSE 0 END) as passed,
            SUM(CASE WHEN d.Status = 'FAIL' THEN 1 ELSE 0 END) as failed,
            SUM(CASE WHEN d.Status = 'MEANDER' THEN 1 ELSE 0 END) as meanders,
            SUM(CASE WHEN d.Status = 'ERROR' THEN 1 ELSE 0 END) as errors
          FROM DeedLogs d
          ${userId ? 'JOIN BatchRuns b ON d.BatchId = b.BatchId WHERE b.UserId = ?' : ''}
          GROUP BY class ORDER BY count DESC
        `, userId ? [userId] : [])
      : query(`
          SELECT
            CASE WHEN d.ExtractionJson IS NOT NULL AND json_valid(d.ExtractionJson) THEN json_extract(d.ExtractionJson, '$.Classification')
                 WHEN d.ParcelName LIKE '[%]%' THEN substr(d.ParcelName, 2, instr(d.ParcelName, ']') - 2)
                 ELSE 'UNKNOWN' END as class,
            COUNT(*) as count,
            SUM(CASE WHEN d.Status = 'PASS' THEN 1 ELSE 0 END) as passed,
            SUM(CASE WHEN d.Status = 'FAIL' THEN 1 ELSE 0 END) as failed,
            SUM(CASE WHEN d.Status = 'MEANDER' THEN 1 ELSE 0 END) as meanders,
            SUM(CASE WHEN d.Status = 'ERROR' THEN 1 ELSE 0 END) as errors
          FROM DeedLogs d
          ${userId ? 'JOIN BatchRuns b ON d.BatchId = b.BatchId WHERE b.UserId = ?' : ''}
          GROUP BY class ORDER BY count DESC
        `, userId ? [userId] : []),
    userId
      ? query(`
          SELECT d.RepairStageUsed as stage, COUNT(*) as count, SUM(CASE WHEN d.Status = 'PASS' THEN 1 ELSE 0 END) as passed
          FROM DeedLogs d
          JOIN BatchRuns b ON d.BatchId = b.BatchId
          WHERE b.UserId = ? AND d.RepairStageUsed IS NOT NULL AND d.RepairStageUsed != '' GROUP BY d.RepairStageUsed ORDER BY count DESC
        `, [userId])
      : query(`
          SELECT RepairStageUsed as stage, COUNT(*) as count, SUM(CASE WHEN Status = 'PASS' THEN 1 ELSE 0 END) as passed
          FROM DeedLogs WHERE RepairStageUsed IS NOT NULL AND RepairStageUsed != '' GROUP BY RepairStageUsed ORDER BY count DESC
        `),
    userId
      ? query(`
          SELECT Status, COUNT(*) as cnt FROM (
            SELECT FileName, Status FROM DeedLogs d
            JOIN BatchRuns b ON d.BatchId = b.BatchId
            WHERE b.UserId = ? AND d.Timestamp = (SELECT MAX(Timestamp) FROM DeedLogs WHERE FileName = d.FileName)
            GROUP BY FileName, Status
          ) g GROUP BY Status
        `, [userId])
      : query(`
          SELECT Status, COUNT(*) as cnt FROM (
            SELECT FileName, Status FROM DeedLogs d
            WHERE Timestamp = (SELECT MAX(Timestamp) FROM DeedLogs WHERE FileName = d.FileName)
            GROUP BY FileName, Status
          ) g GROUP BY Status
        `),
    userId
      ? query(`
          SELECT
            SUM(CASE WHEN d.LinearError <= 1.0 THEN 1 ELSE 0 END) as nearClosed,
            SUM(CASE WHEN d.LinearError > 1.0 AND d.LinearError <= 10.0 THEN 1 ELSE 0 END) as minorError,
            SUM(CASE WHEN d.LinearError > 10.0 AND d.LinearError <= 100.0 THEN 1 ELSE 0 END) as moderateError,
            SUM(CASE WHEN d.LinearError > 100.0 THEN 1 ELSE 0 END) as majorError
          FROM DeedLogs d
          JOIN BatchRuns b ON d.BatchId = b.BatchId
          WHERE b.UserId = ? AND d.Status = 'FAIL'
            AND NOT EXISTS (SELECT 1 FROM DeedLogs p WHERE p.FileName = d.FileName AND p.Status IN ('PASS','MEANDER') AND p.Timestamp >= d.Timestamp)
        `, [userId])
      : query(`
          SELECT
            SUM(CASE WHEN LinearError <= 1.0 THEN 1 ELSE 0 END) as nearClosed,
            SUM(CASE WHEN LinearError > 1.0 AND LinearError <= 10.0 THEN 1 ELSE 0 END) as minorError,
            SUM(CASE WHEN LinearError > 10.0 AND LinearError <= 100.0 THEN 1 ELSE 0 END) as moderateError,
            SUM(CASE WHEN LinearError > 100.0 THEN 1 ELSE 0 END) as majorError
          FROM DeedLogs d WHERE Status = 'FAIL'
            AND NOT EXISTS (SELECT 1 FROM DeedLogs p WHERE p.FileName = d.FileName AND p.Status IN ('PASS','MEANDER') AND p.Timestamp >= d.Timestamp)
        `),
  ]);

  const deedLogCount  = parseInt(countResult.rows[0].c || 0);
  const batchRunCount = parseInt(runCountResult.rows[0].c || 0);
  const range         = rangeResult.rows[0];
  const heuristicCount = parseInt(heuristicResult.rows[0].c || 0);

  const currentStatusCounts = currentStatusResult.rows;
  const _sm = Object.fromEntries(currentStatusCounts.map(r => [r.Status, parseInt(r.cnt || 0)]));

  const classificationList = classificationsResult.rows.map(c => ({ class: c.class || 'UNKNOWN', count: parseInt(c.count || 0), passed: parseInt(c.passed || 0), failed: parseInt(c.failed || 0), meanders: parseInt(c.meanders || 0), errors: parseInt(c.errors || 0) }));
  const repairStageList    = repairStagesResult.rows.map(s => ({ stage: s.stage || 'Unknown', count: parseInt(s.count || 0), passed: parseInt(s.passed || 0) }));
  const errors             = errorsResult.rows[0];

  return {
    dbPath: getIsPostgres() ? 'postgresql://' : dbPath,
    fileSizeMb: Math.round(fileSizeBytes / 1048576 * 100) / 100,
    fileSizeBytes,
    deedLogCount,
    passCount: _sm['PASS'] || 0,
    failCount: _sm['FAIL'] || 0,
    meanderCount: _sm['MEANDER'] || 0,
    errorCount: _sm['ERROR'] || 0,
    batchRunCount,
    heuristicCount,
    oldestTimestamp: range?.oldest || null,
    newestTimestamp: range?.newest || null,
    classifications: classificationList,
    repairStages: repairStageList,
    errorDistribution: {
      nearClosed: parseInt(errors?.nearClosed || 0),
      minorError: parseInt(errors?.minorError || 0),
      moderateError: parseInt(errors?.moderateError || 0),
      majorError: parseInt(errors?.majorError || 0),
    },
  };
}

export async function getHeuristicTracking() {
  const res = await query('SELECT * FROM HeuristicTracking ORDER BY SuccessCount DESC');
  return res.rows.map(r => ({
    id: r.Id, problemName: r.ProblemName, solutionApplied: r.SolutionApplied, successCount: parseInt(r.SuccessCount || 0),
  }));
}

export async function incrementHeuristic(problemName, solutionApplied) {
  const rowRes = await query('SELECT Id FROM HeuristicTracking WHERE ProblemName = ? AND SolutionApplied = ?', [problemName, solutionApplied]);
  const row = rowRes.rows[0];
  if (row) {
    await query('UPDATE HeuristicTracking SET SuccessCount = SuccessCount + 1 WHERE Id = ?', [row.Id]);
  } else {
    await query('INSERT INTO HeuristicTracking (ProblemName, SolutionApplied, SuccessCount) VALUES (?, ?, 1)', [problemName, solutionApplied]);
  }
}

export async function getDeedsByReferencePoint(refPointName) {
  const res = await query(`
    SELECT * FROM DeedLogs WHERE LOWER(ReferencePointName) = LOWER(?) AND Status IN ('PASS', 'MEANDER') ORDER BY Timestamp DESC
  `, [refPointName]);
  return res.rows.map(mapDeedLog);
}

export async function getDistinctReferencePoints() {
  const res = await query(`
    SELECT DISTINCT ReferencePointName FROM DeedLogs
    WHERE ReferencePointName IS NOT NULL AND ReferencePointName != ''
    ORDER BY ReferencePointName
  `);
  return res.rows.map(r => r.ReferencePointName);
}
