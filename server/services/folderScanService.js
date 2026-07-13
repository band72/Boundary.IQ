import * as lockService from './lockService.js';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { resolvePathCaseInsensitive } from './pathUtils.js';
import * as db from './diagnosticsDb.js';
import * as output from './output.js';
import * as geminiVision from './geminiVision.js';

export function safeParseJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (err) {
    console.warn('Failed to parse JSON string:', value, err.message);
    return null;
  }
}

// Helper to resolve county and state for metadata/legalWriter with caching fallback
export function getCountyVal(ex, fallback) {
  if (ex?.county && ex.county !== 'Unknown') return ex.county;
  if (fallback) return fallback;
  const raw = ex?.rawText || ex?.originalLegalDesc || ex?.originalLegalDescription || '';
  if (raw) return geminiVision.inferCountyStateFromText(raw).county || 'Unknown';
  return 'Unknown';
}

export function getStateVal(ex, fallback) {
  if (ex?.state && ex.state !== 'Unknown') return ex.state;
  if (fallback) return fallback;
  const raw = ex?.rawText || ex?.originalLegalDesc || ex?.originalLegalDescription || '';
  if (raw) return geminiVision.inferCountyStateFromText(raw).state || 'Unknown';
  return 'Unknown';
}

// ── Allowed roots (path traversal protection) ────────────────────────────────
export function getAllowedRoots() {
  const envRoots = process.env.BOUNDARY_SCAN_ROOTS;
  if (envRoots) return envRoots.split(';').filter(Boolean).map(r => path.resolve(r.trim()));
  return [os.homedir()];
}

/**
 * Normalize a client-supplied path for server-side validation.
 */
export function validatePath(p) {
  if (!p) return null;
  if (p.includes('..')) return null;

  let normalized = p;

  // Strategy 1: explicit env-driven user map
  const userMapEnv = process.env.BOUNDARY_PATH_USER_MAP;
  if (userMapEnv) {
    for (const entry of userMapEnv.split(';').filter(Boolean)) {
      const eqIdx = entry.indexOf('=');
      if (eqIdx < 1) continue;
      const fromUser = entry.slice(0, eqIdx).trim();
      const toPath   = entry.slice(eqIdx + 1).trim();
      const fromPrefix = `/home/${fromUser}`;
      if (normalized.startsWith(fromPrefix)) {
        normalized = toPath + normalized.slice(fromPrefix.length);
        break;
      }
    }
  }

  // Strategy 2: remap any /home/<username> prefix to the current user's home directory.
  normalized = normalized.replace(/^\/home\/[^/]+/, os.homedir());

  // Normalize backslashes
  normalized = normalized.replace(/\\/g, '/');

  // Translate to actual location under the extracted training folder if the directly requested ones don't exist
  const resolvedCasePath = resolvePathCaseInsensitive(normalized);
  if (fs.existsSync(resolvedCasePath)) {
    normalized = resolvedCasePath;
  } else {
    const trainingPattern = /\/Downloads\/training-[^/]+\/training/i;
    if (trainingPattern.test(normalized)) {
      const candidate = resolvePathCaseInsensitive(normalized.replace(trainingPattern, '/Downloads/FILES/training'));
      if (fs.existsSync(candidate)) normalized = candidate;
    } else if (normalized.includes('/Downloads/TrainPDF')) {
      const candidate = resolvePathCaseInsensitive(normalized.replace('/Downloads/TrainPDF', '/Downloads/FILES/training/TrainPDF'));
      if (fs.existsSync(candidate)) normalized = candidate;
    } else if (normalized.includes('/Downloads/Legal Descriptions')) {
      const candidate = resolvePathCaseInsensitive(normalized.replace('/Downloads/Legal Descriptions', '/Downloads/FILES/training/Legal Descriptions'));
      if (fs.existsSync(candidate)) normalized = candidate;
    }

    // Fallback standard structure
    if (!fs.existsSync(normalized)) {
      if (normalized.includes('/Downloads/TrainPDF')) {
        const candidate = resolvePathCaseInsensitive(normalized.replace('/Downloads/TrainPDF', '/Downloads/training-20260530T124201Z-3-001/training/TrainPDF'));
        if (fs.existsSync(candidate)) normalized = candidate;
      } else if (normalized.includes('/Downloads/Legal Descriptions')) {
        const candidate = resolvePathCaseInsensitive(normalized.replace('/Downloads/Legal Descriptions', '/Downloads/training-20260530T124201Z-3-001/training/Legal Descriptions'));
        if (fs.existsSync(candidate)) normalized = candidate;
      }
    }
  }

  const resolved = path.resolve(normalized);
  const roots = getAllowedRoots();
  for (const root of roots) {
    if (resolved.startsWith(root)) return resolved;
  }
  return null;
}

/**
 * Rec 4 helper — Detect multi-part deed file families.
 */
export function getPartFamily(fileName) {
  const stem = path.parse(fileName).name;
  const m = stem.match(/^(.+?)[-_ ]?([A-D]|[2-4])$/i);
  if (!m) return null;
  const base = m[1];
  const part = m[2].toUpperCase();
  // partOrder mapping
  const orderMap = { A: 1, '2': 2, B: 2, '3': 3, C: 3, '4': 4, D: 4 };
  return { base, part, partOrder: orderMap[part] ?? 1 };
}

// ── Global processing lock ─────────────────────────────────────────────────
export function acquireLock(type, path) {
  return lockService.acquire(type, path);
}

export function releaseLock() {
  lockService.release();
}

// Wrapper helper to inject Point of Reference parameters automatically into saveDeedLog
export async function saveDeedLogWrapper(req, batchId, fileName, parcelName, geoCallCount, linearError, precisionRatio, status, repairStageUsed, extractionJson = null, traverseJson = null, agentTurnsJson = null, trustScore = null, solutionStepsJson = null, fileHash = null) {
  const refName = req.query.refName || null;
  const refN = req.query.refN != null ? parseFloat(req.query.refN) : null;
  const refE = req.query.refE != null ? parseFloat(req.query.refE) : null;
  const pobN = parseFloat(req.query.pobN) || 5000;
  const pobE = parseFloat(req.query.pobE) || 5000;

  await db.saveDeedLog(
    batchId, fileName, parcelName, geoCallCount, linearError, precisionRatio, status, repairStageUsed,
    extractionJson, traverseJson, agentTurnsJson, trustScore, solutionStepsJson,
    refName, refN, refE, pobN, pobE, fileHash
  );
}

// Helper to determine whether to create a new output folder or reuse an existing one passed in query params
export function getOrCreateOutputFolder(req, validPath) {
  if (req.query.outputPath) {
    const p = path.resolve(req.query.outputPath);
    const safeOutput = validatePath(p);
    if (!safeOutput) {
      return null;
    }
    if (!fs.existsSync(safeOutput)) {
      fs.mkdirSync(safeOutput, { recursive: true });
    }
    return safeOutput;
  }
  return output.createOutputFolder(validPath);
}

// Consolidate reference point and commencement segments for all deeds in the project directory
export async function updateProjectReferences(folderPath, newResults) {
  const filePath = path.join(folderPath, 'project_references.json');
  let data = {
    projectPath: folderPath,
    lastUpdated: new Date().toISOString(),
    references: []
  };

  if (fs.existsSync(filePath)) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      if (content.trim()) {
        data = JSON.parse(content);
        data.lastUpdated = new Date().toISOString();
        if (!Array.isArray(data.references)) {
          data.references = [];
        }
      }
    } catch (err) {
      console.warn(`Failed to read/parse project_references.json at ${filePath}:`, err.message);
    }
  }

  for (const r of newResults) {
    if (!r) continue;

    const extractRefInfo = (fileName, extObj) => {
      const refName = extObj?.ReferencePointName || extObj?.referencePointName || null;
      const commSegs = extObj?.CommencementSegments || extObj?.commencementSegments || [];
      if (refName || (commSegs && commSegs.length > 0)) {
        data.references = data.references.filter(entry => entry.fileName !== fileName);
        data.references.push({
          fileName,
          referencePointName: refName,
          commencementSegments: commSegs
        });
      }
    };

    if (r.isMultiParcel && r.parcels) {
      for (const pr of r.parcels) {
        const ext = pr.extraction;
        const refName = ext?.ReferencePointName || ext?.referencePointName || null;
        const commSegs = ext?.CommencementSegments || ext?.commencementSegments || [];
        if (refName || (commSegs && commSegs.length > 0)) {
          data.references = data.references.filter(entry => entry.fileName !== pr.fileName);
          data.references.push({
            fileName: pr.fileName,
            referencePointName: refName,
            commencementSegments: commSegs
          });
        }
      }
    } else {
      extractRefInfo(r.fileName, r.extraction);
    }
  }

  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    console.log(`Saved consolidated project references to ${filePath}`);
  } catch (err) {
    console.warn(`Failed to write project_references.json at ${filePath}:`, err.message);
  }
}
