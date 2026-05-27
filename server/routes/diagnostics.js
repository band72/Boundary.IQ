// ─── Diagnostics Route ──────────────────────────────────────────────────────
import { Router } from 'express';
import * as db from '../services/diagnosticsDb.js';
import fs from 'fs';
import path from 'path';
const router = Router();

// GET /api/diagnostics/recent-batches  — last 30 runs with inline stats
router.get('/recent-batches', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 30, 100);
    res.json(db.getRecentBatchesWithStats(limit));
  } catch (ex) { res.status(400).json({ error: ex.message }); }
});

// GET /api/diagnostics/batch-stats/:batchId  — full stats for one run
router.get('/batch-stats/:batchId', (req, res) => {
  try { res.json(db.getBatchStats(req.params.batchId)); }
  catch (ex) { res.status(400).json({ error: ex.message }); }
});

router.get('/search', (req, res) => {
  try {
    const { query, status, maxError } = req.query;
    res.json(db.searchDeedLogs(query || null, status || null, maxError ? parseFloat(maxError) : null));
  } catch (ex) { res.status(400).json({ error: ex.message }); }
});

router.get('/heuristics', (req, res) => {
  try { res.json(db.getHeuristicTracking()); }
  catch (ex) { res.status(400).json({ error: ex.message }); }
});

router.get('/stats', (req, res) => {
  try { res.json(db.getDatabaseStats()); }
  catch (ex) { res.status(400).json({ error: ex.message }); }
});

// GET /api/diagnostics/failed-deeds?bucket=nearClosed&limit=200
router.get('/failed-deeds', (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit) || 200, 500);
    const bucket = req.query.bucket || null;
    res.json(db.getFailedDeedList(limit, bucket));
  } catch (ex) { res.status(400).json({ error: ex.message }); }
});

router.post('/purge', (req, res) => {
  const days = parseInt(req.query.days) || 90;
  if (days < 1) return res.status(400).json({ error: 'Retention days must be at least 1.' });
  try {
    const deleted = db.purgeOldLogs(days);
    res.json({ deleted, message: `Purged ${deleted} records older than ${days} days.`, stats: db.getDatabaseStats() });
  } catch (ex) { res.status(400).json({ error: ex.message }); }
});

router.post('/clear-failed', (req, res) => {
  try {
    const deleted = db.clearFailedCache();
    res.json({ deleted, message: `Cleared ${deleted} failed deed entries. They will be retried on next batch run.`, stats: db.getDatabaseStats() });
  } catch (ex) { res.status(400).json({ error: ex.message }); }
});

router.post('/save-correction', (req, res) => {
  try {
    const { fileName, parcelName, status, repairStageUsed, extractionJson, traverseJson } = req.body;
    if (!fileName) return res.status(400).json({ error: 'fileName is required.' });
    
    const id = db.saveCorrectedDeed(
      fileName, 
      parcelName || 'Manual Corrected', 
      status || 'PASS', 
      repairStageUsed || 'Stage 6: Manual Operator Corrected', 
      typeof extractionJson === 'object' ? JSON.stringify(extractionJson) : extractionJson, 
      typeof traverseJson === 'object' ? JSON.stringify(traverseJson) : traverseJson
    );
    
    res.json({ success: true, id, message: `Successfully saved manual corrections for ${fileName}.` });
  } catch (ex) { 
    res.status(400).json({ error: ex.message }); 
  }
});

// GET /api/diagnostics/solution-steps?file=filename.doc
// Returns the structured solution steps for a specific processed file.
router.get('/solution-steps', (req, res) => {
  try {
    const { file } = req.query;
    if (!file) return res.status(400).json({ error: 'file query parameter is required.' });
    const result = db.getSolutionSteps(file);
    if (!result) return res.status(404).json({ error: `No solution steps found for "${file}". Process the file first.` });
    res.json(result);
  } catch (ex) {
    res.status(500).json({ error: ex.message });
  }
});

// POST /api/diagnostics/purge-stale-cache

// Removes degenerate PASS cache entries (zero-segment, 999999999 precision ratio).
// Body: { fileName?: string }  — omit fileName to purge all stale entries globally.
router.post('/purge-stale-cache', (req, res) => {
  try {
    const { fileName } = req.body || {};
    const removed = db.purgeStaleCache(fileName || null);
    res.json({ success: true, removed, message: `Removed ${removed} stale cache entries${fileName ? ` for ${fileName}` : ' globally'}.` });
  } catch (ex) {
    res.status(500).json({ error: ex.message });
  }
});

// GET /api/diagnostics/deed-text?fileName=X&folder=/path/to/folder
// Reads the raw extracted text file from disk (_extracted/<basename>.txt).
// Falls back to the extraction message from the DB if the txt file is not found.
router.get("/deed-text", (req, res) => {
  try {
    const { fileName, folder } = req.query;
    if (!fileName) return res.status(400).json({ error: "fileName is required." });

    // Try disk first: look for _extracted/<basename>.txt in the given folder
    if (folder) {
      const base = path.parse(fileName).name;
      const txtPath = path.join(folder, "_extracted", base + ".txt");
      if (fs.existsSync(txtPath)) {
        const text = fs.readFileSync(txtPath, "utf-8");
        return res.json({ fileName, source: "disk", text });
      }
      // Also try converting docx/doc on the fly if txt not found
    }

    // Fall back to extraction data from DB
    const row = db.getDeedDetail(fileName);
    if (row?.extraction) {
      const ex = row.extraction;
      // Handle both PascalCase (C#) and camelCase fields
      let rawParsed = null;
      try { rawParsed = typeof ex.RawJson === 'string' ? JSON.parse(ex.RawJson) : (ex.RawJson || null); } catch {}
      const summary = ex.mentalMapSummary || ex.MentalMapSummary || rawParsed?.MentalMapSummary || '';
      const message  = ex.message || ex.Message || '';
      // Build a human-readable deed text block from extracted data
      const courses  = ex.courses || ex.Courses || rawParsed?.Segments || [];
      const lines = [];
      if (summary) lines.push('=== AI Mental Map Summary ===\n' + summary);
      if (message)  lines.push('=== Extraction Log ===\n' + message);
      if (courses.length > 0) {
        lines.push('=== Extracted Courses ===');
        courses.forEach((c, i) => {
          const type = c.type || c.Type || 'Line';
          const bearing = c.bearing || c.Bearing || c.chordBearing || c.ChordBearing || '—';
          const dist = c.distance ?? c.Distance ?? c.chordDistance ?? c.ChordDistance ?? null;
          lines.push(`  ${String(i+1).padStart(3)}. [${type}] ${bearing}${dist != null ? '  ' + Number(dist).toFixed(2) + ' ft' : ''}${(c.isUnknown || c.IsUnknown) ? '  ⚠ UNKNOWN' : ''}`);
        });
      }
      const text = lines.join('\n\n') || '(No raw text available — only extracted courses are stored)';
      return res.json({ fileName, source: "db", text });
    }

    res.json({ fileName, source: "none", text: "(No raw deed text found for this file)" });
  } catch (ex) { res.status(500).json({ error: ex.message }); }
});

// GET /api/diagnostics/deed-detail?fileName=X
// Returns the full DB row (including extractionJson & traverseJson) for the latest
// FAIL/ERROR record matching the given filename.
router.get("/deed-detail", (req, res) => {
  try {
    const { fileName } = req.query;
    if (!fileName) return res.status(400).json({ error: "fileName is required." });
    const row = db.getDeedDetail(fileName);
    if (!row) return res.status(404).json({ error: `No record found for "${fileName}".` });
    res.json(row);
  } catch (ex) { res.status(500).json({ error: ex.message }); }
});

export default router;


// Already exported above — just re-open the file to append before the export default
