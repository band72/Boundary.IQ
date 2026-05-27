// ─── Deed Text Solver Service ─────────────────────────────────────────────────
// Solves incomplete or broken deed descriptions using local LLMs + deterministic COGO.
//
// Architecture principle: LLM does ONLY NLP extraction (bearing/distance text → JSON).
// ALL geometric math, error diagnosis, and closure repair is handled by Node.js COGO
// engine — never trusted to the LLM. This makes the system work reliably on 7B models.

import { fetch, Agent } from 'undici';
import * as traverseSvc from './traverse.js';
import * as bp from './bearingParser.js';

const OLLAMA_BASE = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';

const ollamaAgent = new Agent({
  connectTimeout: 1800000,
  headersTimeout: 1800000,
  bodyTimeout:    1800000,
});

// ── Prompt builder ────────────────────────────────────────────────────────────
// Key design: the LLM prompt is intentionally tiny and mechanical.
// No math, no reasoning — just text → structured JSON.
// The COGO engine handles everything else.

function buildExtractionPrompt(deedText) {
  return `You are a legal description parser. Extract boundary courses from the deed text below.

RULES:
1. Find every "THENCE" clause and extract its bearing and distance.
2. For each course, output exactly: Type, Bearing, Distance.
3. If a bearing is missing, blank, or unclear (like "N/West" or "??"), set Bearing to null and IsUnknown to true.
4. If a distance is 0.00, missing, or unclear, set Distance to null and IsUnknown to true.
5. Do NOT compute, correct, or modify any values. Extract ONLY what is written.
6. Bearings format: "N45°22'10\\"E" — keep the exact degree/minute/second format from the text.
7. Distances are decimal feet (or meters if stated).
8. Output ONLY a JSON object. No explanation, no markdown.

OUTPUT FORMAT:
{
  "POB": { "Northing": 5000.00, "Easting": 5000.00 },
  "Units": "Feet",
  "Segments": [
    { "Type": "Line", "Bearing": "N45°22'10\\"E", "Distance": 150.25, "IsUnknown": false },
    { "Type": "Line", "Bearing": null, "Distance": null, "IsUnknown": true }
  ]
}

DEED TEXT:
${deedText}`;
}

// ── Ollama text-only call ─────────────────────────────────────────────────────
async function callOllama(model, prompt) {
  const payload = {
    model,
    prompt,
    stream: false,
    options: { temperature: 0.0, num_predict: 4096 },
    format: 'json',
  };

  const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(300000), // 5 min max for local text inference
    dispatcher: ollamaAgent,
  });

  if (!res.ok) {
    const errText = await res.text();
    if (res.status === 404) throw new Error(`Model "${model}" not found. Run: ollama pull ${model}`);
    throw new Error(`Ollama returned ${res.status}: ${errText.substring(0, 200)}`);
  }

  const data = await res.json();
  return data.response || '';
}

// ── JSON parser — robust to common local LLM formatting issues ────────────────
function parseExtractionJson(raw) {
  let text = raw.trim();

  // Strip markdown fences if model added them despite format:'json'
  text = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

  // Some models wrap in extra text before/after the JSON object
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1) {
    text = text.slice(firstBrace, lastBrace + 1);
  }

  let root;
  try {
    root = JSON.parse(text);
  } catch {
    // Try to fix common issues: trailing commas, unquoted nulls
    const fixed = text
      .replace(/,\s*([}\]])/g, '$1')   // trailing commas
      .replace(/:\s*undefined/g, ': null'); // undefined → null
    root = JSON.parse(fixed);
  }

  // Normalize casing variations (some models use lowercase keys)
  const segments = root.Segments || root.segments || root.courses || root.Courses || [];
  const pobRaw = root.POB || root.pob || root.PointOfBeginning || {};
  const pob = {
    northing: parseFloat(pobRaw.Northing ?? pobRaw.northing ?? 5000),
    easting:  parseFloat(pobRaw.Easting  ?? pobRaw.easting  ?? 5000),
  };
  if (isNaN(pob.northing)) pob.northing = 5000;
  if (isNaN(pob.easting))  pob.easting  = 5000;

  const units = root.Units || root.units || 'Feet';

  const courses = segments.map(s => {
    const type = (s.Type || s.type || 'Line');
    const isUnknown = !!(s.IsUnknown ?? s.isUnknown ?? false);
    const bearing = s.Bearing ?? s.bearing ?? null;
    const distance = s.Distance ?? s.distance ?? null;
    return {
      type,
      bearing: bearing || null,
      distance: (distance != null && !isNaN(parseFloat(distance))) ? parseFloat(distance) : null,
      isUnknown: isUnknown || !bearing || distance == null || parseFloat(distance) === 0,
      // Curves
      chordBearing: s.ChordBearing ?? s.chordBearing ?? null,
      chordDistance: s.ChordDistance ?? s.chordDistance ?? null,
      radius: s.Radius ?? s.radius ?? null,
      delta: s.Delta ?? s.delta ?? null,
      arcLength: s.ArcLength ?? s.arcLength ?? null,
      curveDirection: s.Direction ?? s.CurveDirection ?? s.curveDirection ?? null,
    };
  });

  return { courses, pob, units };
}

// ── Deterministic COGO repair ─────────────────────────────────────────────────
// All error detection and fixing is done here in pure math — NOT by the LLM.

function tryCompute(courses, pob, units, isOpenEnded = false) {
  try {
    const result = traverseSvc.compute({ pointOfBeginning: pob, courses, units, isOpenEnded });
    return { result, error: null };
  } catch (ex) {
    return { result: null, error: ex.message };
  }
}

function isPassing(r) {
  if (!r) return false;
  const le = r.closure.linearError;
  if (le < 0.30) return true;
  const parts = r.closure.precisionRatio.split(':');
  if (parts.length > 1) {
    const v = parseFloat(parts[1].replace(/,/g, '').replace('∞', '999999999'));
    if (v >= 10000) return true;
  }
  return false;
}

function flipQuadrant(bearing) {
  if (!bearing) return bearing;
  return bearing
    .replace(/^N/i, '__NS__').replace(/^S/i, 'N').replace(/^__NS__/, 'S')
    .replace(/E$/i, '__EW__').replace(/W$/i, 'E').replace(/__EW__$/, 'W');
}
function flipEW(bearing) {
  if (!bearing) return bearing;
  return bearing.replace(/E$/i, '__EW__').replace(/W$/i, 'E').replace(/__EW__$/, 'W');
}
function flipNS(bearing) {
  if (!bearing) return bearing;
  return bearing.replace(/^N/i, '__NS__').replace(/^S/i, 'N').replace(/^__NS__/, 'S');
}


function repairCourses(courses, pob, units) {
  const steps = [];

  // ── Step 1: Detect and flag anomalies ────────────────────────────────────
  const anomalies = [];
  for (let i = 0; i < courses.length; i++) {
    const c = courses[i];
    if (c.isUnknown || !c.bearing || c.distance == null || c.distance === 0) {
      anomalies.push({ type: 'UNKNOWN_COURSE', idx: i });
    }
  }

  // Detect backtracking (exact reverse consecutive courses)
  for (let i = 0; i < courses.length; i++) {
    const c1 = courses[i];
    const c2 = courses[(i + 1) % courses.length];
    if (!c1.bearing || !c2.bearing) continue;
    try {
      const az1 = bp.parse(c1.bearing).azimuthDeg;
      const az2 = bp.parse(c2.bearing).azimuthDeg;
      const diff = Math.abs(az1 - az2);
      if (Math.abs(diff - 180) < 0.5) {
        anomalies.push({ type: 'BACKTRACK', idx: i, idxNext: (i + 1) % courses.length });
      }
    } catch {}
  }

  // ── Step 2: Pure gap solver (no backtrack) ───────────────────────────────
  const withGapSolved = traverseSvc.autoFixUnknownRuns(courses, pob);
  const { result: r0 } = tryCompute(withGapSolved, pob, units);
  const r0Bowtie = r0 && (r0.areaAcres == null || r0.areaAcres < 0.0001);
  if (r0 && isPassing(r0) && !r0Bowtie) {
    const solvedIndices = courses.reduce((acc, c, i) => {
      if (c.isUnknown || !c.bearing || c.distance == null || c.distance === 0) acc.push(i);
      return acc;
    }, []);
    steps.push({ hypothesis: 'INVERSE_GAP_SOLVER', solvedIndices });
    return { courses: withGapSolved, result: r0, steps };
  }

  // ── Steps 3 & 4: Bearing flip + re-solve unknowns ────────────────────────
  // Only flip non-unknown (known) courses. Unknown courses get re-solved by
  // inverse after each flip. Reject results where inverse course is > 25% longer
  // than the longest known course (rules out diagonal bowtie closers).
  const knownDistances = courses.filter(c => c.distance && !c.isUnknown).map(c => c.distance);
  const maxKnown = knownDistances.length ? Math.max(...knownDistances) : 999999;

  function isSensible(testSolved) {
    return testSolved.every(c => !c.distance || c.distance <= maxKnown * 1.25);
  }

  // Step 3: Single flip — try EW-only, NS-only, and full quadrant per course
  const flipVariants = [
    { fn: flipEW,       label: 'EW_FLIP' },
    { fn: flipNS,       label: 'NS_FLIP' },
    { fn: flipQuadrant, label: 'QUADRANT_FLIP' },
  ];
  for (const { fn: flipFn, label } of flipVariants) {
    for (let i = 0; i < courses.length; i++) {
      const c = courses[i];
      if (!c.bearing || c.isUnknown) continue;
      const flipped = flipFn(c.bearing);
      if (flipped === c.bearing) continue;
      const test = courses.map((x, j) =>
        j === i ? { ...x, bearing: flipped } : { ...x }
      );
      const testSolved = traverseSvc.autoFixUnknownRuns(test, pob);
      const { result: r1 } = tryCompute(testSolved, pob, units);
      const r1Bowtie = r1 && (r1.areaAcres == null || r1.areaAcres < 0.0001);
      if (r1 && isPassing(r1) && !r1Bowtie && isSensible(testSolved)) {
        steps.push({ hypothesis: `SINGLE_${label}`, courseIndex: i, originalBearing: c.bearing, correctedBearing: flipped });
        return { courses: testSolved, result: r1, steps };
      }
    }
  }

  // Step 4: Double flip
  for (let i = 0; i < courses.length; i++) {
    for (let j = i + 1; j < courses.length; j++) {
      const ci = courses[i], cj = courses[j];
      if (!ci.bearing || ci.isUnknown || !cj.bearing || cj.isUnknown) continue;
      const test = courses.map((x, k) => {
        if (k === i || k === j) return { ...x, bearing: flipQuadrant(x.bearing) };
        return { ...x };
      });
      const testSolved = traverseSvc.autoFixUnknownRuns(test, pob);
      const { result: r2 } = tryCompute(testSolved, pob, units);
      const r2Bowtie = r2 && (r2.areaAcres == null || r2.areaAcres < 0.0001);
      if (r2 && isPassing(r2) && !r2Bowtie && isSensible(testSolved)) {
        steps.push({ hypothesis: 'DOUBLE_QUADRANT_FLIP', courseIndices: [i, j] });
        return { courses: testSolved, result: r2, steps };
      }
    }
  }

  // ── Step 5: Return best-effort even if not closed ─────────────────────────
  const { result: rFinal } = tryCompute(withGapSolved, pob, units);
  steps.push({ hypothesis: 'UNCLOSED', note: 'No repair hypothesis achieved passing closure.' });
  return { courses: withGapSolved, result: rFinal, steps };
}

// ── Legal description writer ──────────────────────────────────────────────────
function writeLegalDescription(originalCourses, repairedCourses, result, pob, units, steps) {
  const stepMap = {};
  for (const s of steps) {
    if (s.courseIndex != null) stepMap[s.courseIndex] = s;
    if (s.courseIndices) s.courseIndices.forEach(i => stepMap[i] = s);
    if (s.solvedIndices) s.solvedIndices.forEach(i => stepMap[i] = s);
  }

  const lines = [];
  lines.push(`BEGINNING at a point, the Point of Beginning (POB), having coordinates of`);
  lines.push(`Northing ${pob.northing.toFixed(2)}, Easting ${pob.easting.toFixed(2)};\n`);

  repairedCourses.forEach((c, i) => {
    const orig = originalCourses[i];
    const isLast = i === repairedCourses.length - 1;
    const terminus = isLast ? 'to the Point of Beginning' : 'to a corner';
    const isUnknownOrig = !orig || orig.isUnknown || !orig.bearing || !orig.distance || orig.distance === 0;
    const wasCorrected = !isUnknownOrig && orig && (
      orig.bearing !== c.bearing || orig.distance !== c.distance
    );

    let tag = '';
    if (stepMap[i]) {
      if (stepMap[i].hypothesis === 'INVERSE_GAP_SOLVER') tag = ' [SOLVED by inverse closure]';
      else if (stepMap[i].hypothesis?.includes('FLIP')) tag = ' [CORRECTED: bearing quadrant inverted]';
      else if (stepMap[i].hypothesis === 'UNCLOSED') tag = ' [UNRESOLVED]';
    }

    const bearing = c.bearing || '??';
    const dist = c.distance != null ? c.distance.toFixed(2) : '??';

    if (c.type?.toLowerCase() === 'line') {
      lines.push(`THENCE ${bearing}, a distance of ${dist} ${units}${tag ? ` ${tag}` : ''}, ${terminus};`);
    } else {
      const dir = c.curveDirection || '';
      const r = c.radius != null ? `R=${c.radius.toFixed(2)}'` : '';
      const d = c.delta != null ? `Δ=${c.delta.toFixed(4)}°` : '';
      const l = c.arcLength != null ? `L=${c.arcLength.toFixed(2)}'` : '';
      lines.push(`THENCE along a curve to the ${dir}, ${r}, ${d}, ${l}, ${terminus};`);
    }
  });

  const area = result?.areaAcres != null ? result.areaAcres.toFixed(4) : '??';
  const perim = result?.perimeter != null ? result.perimeter.toFixed(2) : '??';
  lines.push(`\nSaid parcel containing ${area} acres, more or less, and having a perimeter of ${perim} feet.`);
  lines.push(`Bearings are grid bearings based on the deed of record.`);
  return lines.join('\n');
}

// ── Build correction table ────────────────────────────────────────────────────
function buildCorrectionTable(originalCourses, repairedCourses, steps) {
  const stepMap = {};
  for (const s of steps) {
    if (s.courseIndex != null) stepMap[s.courseIndex] = s;
    if (s.courseIndices) s.courseIndices.forEach(i => stepMap[i] = s);
    if (s.solvedIndices) s.solvedIndices.forEach(i => stepMap[i] = s);
  }
  return repairedCourses.map((c, i) => {
    const orig = originalCourses[i];
    const status = stepMap[i]
      ? (stepMap[i].hypothesis === 'INVERSE_GAP_SOLVER' ? 'SOLVED-BY-INVERSE'
        : stepMap[i].hypothesis?.includes('FLIP') ? 'CORRECTED'
        : 'UNRESOLVED')
      : 'ORIGINAL';
    return {
      courseNumber: i + 1,
      bearing: c.bearing || null,
      distance: c.distance,
      status,
      originalBearing: orig?.bearing || null,
      originalDistance: orig?.distance || null,
      hypothesis: stepMap[i]?.hypothesis || null,
    };
  });
}

// ── Main exported solver ──────────────────────────────────────────────────────

/**
 * Solve a broken deed description using a local LLM for extraction
 * and deterministic COGO math for all geometry and repair.
 *
 * @param {string} deedText     - Raw legal description text
 * @param {string} model        - Ollama model name (e.g. 'llama3.2', 'mistral', 'qwen2.5')
 * @param {object} options      - { pobNorthing, pobEasting, units, isOpenEnded }
 * @returns {Promise<object>}   - Full solve result
 */
export async function solveDeedText(deedText, model, options = {}) {
  const startTime = Date.now();

  const pob = {
    northing: options.pobNorthing ?? 5000,
    easting:  options.pobEasting  ?? 5000,
  };
  const units = options.units || 'Feet';
  const isOpenEnded = options.isOpenEnded ?? false;

  console.log(`[DeedTextSolver] Model: ${model} | POB: N${pob.northing} E${pob.easting} | Units: ${units}`);

  // ── Phase 1: LLM extracts courses from text ──────────────────────────────
  console.log(`[DeedTextSolver] Phase 1: Sending deed text to ${model} for extraction...`);
  let rawResponse;
  try {
    rawResponse = await callOllama(model, buildExtractionPrompt(deedText));
  } catch (ex) {
    throw new Error(`LLM extraction failed: ${ex.message}`);
  }

  console.log(`[DeedTextSolver] Phase 1 complete. Raw response length: ${rawResponse.length} chars`);

  // ── Phase 2: Parse LLM JSON output ───────────────────────────────────────
  let extraction;
  try {
    extraction = parseExtractionJson(rawResponse);
  } catch (ex) {
    throw new Error(`Failed to parse LLM JSON output: ${ex.message}. Raw: ${rawResponse.substring(0, 300)}`);
  }

  if (!extraction.courses || extraction.courses.length === 0) {
    throw new Error('LLM returned no courses. The deed text may not contain a traversable boundary.');
  }

  // Override POB if LLM found explicit coordinates in the deed
  if (extraction.pob.northing !== 5000 || extraction.pob.easting !== 5000) {
    pob.northing = extraction.pob.northing;
    pob.easting  = extraction.pob.easting;
  }

  const originalCourses = extraction.courses.map(c => ({ ...c }));
  console.log(`[DeedTextSolver] Phase 2: Extracted ${extraction.courses.length} courses.`);

  // ── Phase 3: COGO repair — all math, zero LLM involvement ────────────────
  console.log(`[DeedTextSolver] Phase 3: Running deterministic COGO repair...`);
  const { courses: repairedCourses, result, steps } = repairCourses(extraction.courses, pob, units);

  const passed = result && isPassing(result);
  const elapsedMs = Date.now() - startTime;

  console.log(`[DeedTextSolver] Done. Status: ${passed ? 'PASS' : 'FAIL'} | Elapsed: ${elapsedMs}ms`);

  // ── Phase 4: Build output ─────────────────────────────────────────────────
  const correctionTable = buildCorrectionTable(originalCourses, repairedCourses, steps);
  const legalDescription = writeLegalDescription(originalCourses, repairedCourses, result, pob, units, steps);

  const hypotheses = steps.map(s => s.hypothesis).filter(Boolean);
  const primaryHypothesis = hypotheses[0] || 'NONE';

  // ── Confidence score ──────────────────────────────────────────────────────
  let trustScore = 100;
  if (!passed) trustScore -= 40;
  const inventedBearings = correctionTable.filter(c => c.status === 'SOLVED-BY-INVERSE').length;
  const correctedBearings = correctionTable.filter(c => c.status === 'CORRECTED').length;
  if (inventedBearings > 1) trustScore -= 15;
  if (correctedBearings > 2) trustScore -= 20;
  if (result?.areaAcres != null && result.areaAcres < 0.01) trustScore -= 25;
  trustScore = Math.max(0, Math.min(100, trustScore));
  const trustLevel = trustScore >= 80 ? 'HIGH' : trustScore >= 55 ? 'MEDIUM' : 'LOW';

  return {
    status: passed ? 'PASS' : 'FAIL',
    model,
    elapsedMs,

    // Extraction
    originalCourses,
    pob,
    units,

    // Repair
    repairedCourses,
    correctionTable,
    steps,
    primaryHypothesis,

    // COGO results
    traverse: result ? {
      stations: result.stations,
      adjustedStations: result.adjustedStations,
      closure: result.closure,
      perimeter: result.perimeter,
      areaAcres: result.areaAcres,
      areaSqFt: result.areaSqFt,
    } : null,

    // Trust
    trustScore,
    trustLevel,

    // Final output
    legalDescription,
  };
}

/**
 * Solve from pre-parsed courses — no LLM required.
 * Runs the full deterministic COGO repair pipeline directly.
 */
export function solveFromCourses(courses, options = {}) {
  const startTime = Date.now();
  const pob = { northing: options.pobNorthing ?? 5000, easting: options.pobEasting ?? 5000 };
  const units = options.units || 'Feet';

  const originalCourses = courses.map(c => ({ ...c }));
  const { courses: repairedCourses, result, steps } = repairCourses(courses, pob, units);

  const passed = result && isPassing(result);
  const correctionTable = buildCorrectionTable(originalCourses, repairedCourses, steps);
  const legalDescription = writeLegalDescription(originalCourses, repairedCourses, result, pob, units, steps);

  let trustScore = 100;
  if (!passed) trustScore -= 40;
  const inventedBearings = correctionTable.filter(c => c.status === 'SOLVED-BY-INVERSE').length;
  const correctedBearings = correctionTable.filter(c => c.status === 'CORRECTED').length;
  if (inventedBearings > 1) trustScore -= 15;
  if (correctedBearings > 2) trustScore -= 20;
  if (result?.areaAcres != null && result.areaAcres < 0.01) trustScore -= 25;
  trustScore = Math.max(0, Math.min(100, trustScore));
  const trustLevel = trustScore >= 80 ? 'HIGH' : trustScore >= 55 ? 'MEDIUM' : 'LOW';

  return {
    status: passed ? 'PASS' : 'FAIL',
    model: 'deterministic-cogo',
    elapsedMs: Date.now() - startTime,
    originalCourses, pob, units,
    repairedCourses, correctionTable, steps,
    primaryHypothesis: steps[0]?.hypothesis || 'NONE',
    traverse: result ? {
      stations: result.stations,
      adjustedStations: result.adjustedStations,
      closure: result.closure,
      perimeter: result.perimeter,
      areaAcres: result.areaAcres,
      areaSqFt: result.areaSqFt,
    } : null,
    trustScore, trustLevel,
    legalDescription,
  };
}

/**
 * Parse raw deed text using regex (no LLM) and run COGO repair.
 * Normalizes verbose cardinal names ("North 45°22'10" East" → "N45°22'10"E").
 * Flags unknown/ambiguous bearings ("North / West", "N?") as isUnknown.
 */
export function solveFromText(deedText, options = {}) {
  const text = deedText || '';

  // Extract POB coordinates from deed preamble
  let pobNorthing = options.pobNorthing ?? 5000;
  let pobEasting  = options.pobEasting  ?? 5000;
  const pobMatch = text.match(/Northing\s+([\d,]+\.?\d*)[,\s]+Easting\s+([\d,]+\.?\d*)/i);
  if (pobMatch) {
    pobNorthing = parseFloat(pobMatch[1].replace(/,/g, ''));
    pobEasting  = parseFloat(pobMatch[2].replace(/,/g, ''));
  }

  // Normalize verbose bearing format to abbreviated: "North 45°22'10\" East" → "N45°22'10\"E"
  function normalizeBearing(raw) {
    if (!raw) return null;
    return raw.trim()
      .replace(/\bNorth\b/gi, 'N').replace(/\bSouth\b/gi, 'S')
      .replace(/\bEast\b/gi,  'E').replace(/\bWest\b/gi,  'W')
      .replace(/\s+/g, '');
  }

  // Detect unknown/ambiguous bearings: "N/West", "N / W", "N?", "??", "North / West"
  function isUnknownBearing(raw, normalized) {
    if (!raw || raw.trim().length < 2) return true;
    if (/[/?]/.test(raw)) return true;
    if (/unknown|unclear|\?\?/i.test(raw)) return true;
    // Normalized bearing must start with N or S followed by a digit OR be NE/NW/SE/SW
    if (!/^[NS]\d/.test(normalized || '') && !/^[NS][EW]$/.test(normalized || '')) return true;
    return false;
  }

  const courses = [];
  const lines = text.split(/\n/).map(l => l.trim()).filter(l => /^THENCE/i.test(l));

  for (const line of lines) {
    const distMatch = line.match(/THENCE\s+(.+?),?\s+a\s+distance\s+of\s+([\d,]+\.?\d*)/i)
      || line.match(/THENCE\s+(.+?)\s+([\d,]+\.\d+)/i);

    if (distMatch) {
      const rawBearing = distMatch[1].replace(/,/g, '').trim();
      const dist       = parseFloat(distMatch[2].replace(/,/g, ''));
      const normalized = normalizeBearing(rawBearing);
      const unknownB   = isUnknownBearing(rawBearing, normalized);
      const unknownD   = isNaN(dist) || dist === 0;

      courses.push({
        type: 'Line',
        bearing:   unknownB ? null : normalized,
        distance:  unknownD ? null : dist,
        isUnknown: unknownB || unknownD,
      });
    }
  }

  if (courses.length === 0) throw new Error('No THENCE courses found in deed text. Verify format.');
  return solveFromCourses(courses, { pobNorthing, pobEasting, units: options.units || 'Feet' });
}


/**
 * List available Ollama models that are suitable for deed text extraction.
 * Returns all available models with a suitability rating.
 */
export async function listAvailableModels() {
  const res = await fetch(`${OLLAMA_BASE}/api/tags`, {
    signal: AbortSignal.timeout(5000),
    dispatcher: ollamaAgent,
  });
  if (!res.ok) throw new Error(`Ollama not reachable: HTTP ${res.status}`);
  const data = await res.json();
  const models = (data.models || []).map(m => {
    const name = m.name;
    const size = m.size || 0;
    // Rate suitability: larger models handle ambiguous deed text better
    let suitability = 'GOOD';
    if (name.includes('7b') || name.includes('8b') || name.includes('3b') || name.includes('2b')) {
      suitability = 'MINIMUM'; // Works but may struggle with archaic phrasing
    }
    if (name.includes('70b') || name.includes('32b') || name.includes('14b')) {
      suitability = 'EXCELLENT';
    }
    return { name, sizeBytes: size, suitability };
  });
  return models;
}
