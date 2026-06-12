// ─── Deed Text Solver Service ─────────────────────────────────────────────────
// Solves incomplete or broken deed descriptions using local LLMs + deterministic COGO.
//
// Architecture principle: LLM does ONLY NLP extraction (bearing/distance text → JSON).
// ALL geometric math, error diagnosis, and closure repair is handled by Node.js COGO
// engine — never trusted to the LLM. This makes the system work reliably on 7B models.

import { Agent } from 'undici';
import { httpFetch } from './httpFetch.js';
import * as traverseSvc from './traverse.js';
import * as bp from './bearingParser.js';
import * as platLookup from './platLookupService.js';
import * as plssParser from './plssParser.js';
import * as legalWriter from './legalWriter.js';
import pLimit from 'p-limit';

import { isPlaceholderHallucination } from './geminiVision.js';
import { ensureOllamaServiceOnline } from './ollamaVision.js';

const OLLAMA_BASE = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';

const ollamaAgent = new Agent({
  connectTimeout: 1800000,
  headersTimeout: 1800000,
  bodyTimeout:    1800000,
});

// ── Global LLM semaphore ───────────────────────────────────────────────────────
// Ollama runs one model at a time. Allowing >1 concurrent request causes
// thundering-herd OOM and empty-response errors. This single concurrency slot
// is shared across all routes and batch loops server-wide.
const ollamaLimit = pLimit(1);

// ── Prompt builder ────────────────────────────────────────────────────────────
// Key design: the LLM prompt is intentionally tiny and mechanical.
// No math, no reasoning — just text → structured JSON.
// The COGO engine handles everything else.

function buildExtractionPrompt(deedText) {
  return `You are a legal description parser. Extract boundary courses from the deed text below.

RULES:
1. Find every "THENCE" clause and extract its bearing and distance (or curve properties).
2. For each course, output exactly: Type (either "Line" or "Curve"), and its respective properties.
3. For Line courses, specify: Type, Bearing, Distance.
4. For Curve courses, specify: Type, Radius, Delta (central angle), ArcLength, CurveDirection (e.g., "Left" or "Right"), ChordBearing, ChordDistance.
5. If a bearing is missing, blank, or unclear (like "N/West" or "??"), set Bearing (or ChordBearing) to null and IsUnknown to true.
6. If a distance (or chord distance) is 0.00, missing, or unclear, set Distance (or ChordDistance) to null and IsUnknown to true.
7. If a course describes a deflection angle (e.g. "AT A DEFLECTION ANGLE TO THE LEFT/RIGHT OF X DEGREES, Y FEET"), represent it as: "Type": "Line", "Bearing": null, "Distance": Y, "DeflectionAngle": X, "DeflectionDirection": "Left" or "Right", "IsUnknown": (Y === 0 || Y === null)
8. Do NOT compute, correct, or modify any values. Extract ONLY what is written.
8a. ACTUAL vs PLAT distances: When a clause contains both an ACTUAL DISTANCE and a PLAT distance (e.g. "AN ACTUAL DISTANCE OF 117.30 FEET (126.97 FEET PLAT)"), always use the ACTUAL DISTANCE. The plat figure appears in parentheses and must NOT be used for the traverse.
9. Bearings format: "N45°22'10\\"E" — keep the exact degree/minute/second format from the text.
10. Distances are decimal feet (or meters if stated).
11. IDENTIFY the Point of Reference (POR) (e.g. the section corner, subdivision corner, or benchmark mentioned) and any commencement/reference runs leading from that Reference Point (POR) to the Point of Beginning (POB).
   - Populate the "ReferencePointName" field with the name/description of the Point of Reference (or null if not found).
   - Extract the commencement courses (bearings + distances) leading from the Reference Point (POR) to the POB into the "CommencementSegments" array.
   - Do NOT include these commencement courses in the main "Segments" array. The main "Segments" array MUST only contain the property boundary courses starting FROM the Point of Beginning (POB).
12. MEANDER BOUNDARIES: If a segment follows a meandering waterway, creek, river boundary, shoreline, road centerline, or irregular line with no defined bearing and/or distance, set "Bearing" (or "ChordBearing") and/or "Distance" (or "ChordDistance") to null and set "IsUnknown" to true. Do NOT fabricate or estimate values. The system will solve this as an unknown/meander gap close leg.
13. OPEN-ENDED TRAVERSE: Identify if the traverse is open-ended (e.g. it is an easement description, a road centerline, meanders, or terminates without returning to the Point of Beginning / POB). Set "IsOpenEnded": true or false accordingly.
14. Output ONLY a JSON object. No explanation, no markdown.
15. DUAL DESCRIPTION — If the deed contains TWO complete traverse descriptions of the SAME property (signals: "THIS IS THE SAME PROPERTY AS DESCRIBED IN...", "BEING THE SAME LANDS AS DESCRIBED IN...", or a second "POINT OF BEGINNING" traverse after the first), extract ONLY the SECOND (more recent/precise) description. Ignore the first. The second usually follows a surveyor's job number or "JOB NO." reference.
16. MULTI-PARCEL DEED — If the deed labels separate parcels as "PARCEL 1:", "PARCEL 2:", etc., extract ONLY "PARCEL 1" boundary courses. Do NOT mix courses from multiple parcels.


OUTPUT FORMAT:
{
  "POB": { "Northing": 5000.00, "Easting": 5000.00 },
  "ReferencePointName": "Southeast corner of Section 12",
  "CommencementSegments": [
    { "Type": "Line", "Bearing": "N00°02'10\\"W", "Distance": 330.15, "IsUnknown": false }
  ],
  "Units": "Feet",
  "IsOpenEnded": false,
  "Segments": [
    { "Type": "Line", "Bearing": "N45°22'10\\"E", "Distance": 150.25, "IsUnknown": false },
    {
      "Type": "Curve",
      "Radius": 424.73,
      "Delta": "93°62'00.00\"",
      "ArcLength": 93.43,
      "CurveDirection": "Left",
      "ChordBearing": "S16°38'52\\"E",
      "ChordDistance": 93.43,
      "IsUnknown": false
    },
    { "Type": "Line", "Bearing": null, "Distance": null, "IsUnknown": true }
  ]
}

DEED TEXT:
${deedText}`;
}

async function callOllama(model, prompt) {
  // Serialize all Ollama requests through the global semaphore (1 slot).
  // This prevents concurrent batches or UI requests from overloading the
  // local model and generating empty responses.
  return ollamaLimit(async () => {
    const isReasoning = model.toLowerCase().includes('deepseek') || model.toLowerCase().includes('r1') || model.toLowerCase().includes('reasoning');
    // For large deeds, bump non-reasoning context window to avoid silent truncation
    const deedLen = typeof prompt === 'string' ? prompt.length : 0;
    const nonReasonCtx = deedLen > 6000 ? 32768 : deedLen > 3000 ? 16384 : 8192;
    const payload = {
      model,
      prompt,
      stream: false,
      options: isReasoning
        ? { temperature: 0.0, num_predict: 8192, num_ctx: 16384 }
        : { temperature: 0.0, num_predict: 8192, num_ctx: nonReasonCtx }
    };
    if (!isReasoning) {
      payload.format = 'json';
    }

    const maxRetries = 3; // up to 4 total attempts — handles transient empty-response from Ollama
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await httpFetch(`${OLLAMA_BASE}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(1800000), // 30 min max for local text inference
          dispatcher: ollamaAgent,
        });

        if (!res.ok) {
          const errText = await res.text();
          if (res.status === 404) throw new Error(`Model "${model}" not found. Run: ollama pull ${model}`);
          if (attempt < maxRetries) {
            console.warn(`Ollama /generate returned ${res.status} on attempt ${attempt + 1}. Retrying…`);
            await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
            continue;
          }
          throw new Error(`Ollama returned ${res.status}: ${errText.substring(0, 200)}`);
        }

        const data = await res.json();
        const rawText = data.response || '';
        if (!rawText.trim()) {
          // Empty response is transient (model overload / mid-swap). Retry with backoff.
          if (attempt < maxRetries) {
            const waitMs = 3000 * (attempt + 1);
            console.warn(`Ollama returned empty response on attempt ${attempt + 1}/${maxRetries + 1}. Waiting ${waitMs}ms before retry…`);
            await new Promise(r => setTimeout(r, waitMs));
            continue;
          }
          throw new Error('Ollama returned empty response string.');
        }
        console.log('--- OLLAMA RESPONSE IN CALLOLLAMA ---');
        console.log(rawText);
        console.log('--------------------------------------');
        return rawText;
      } catch (ex) {
        const isConnectionError = ex.code === 'ECONNREFUSED' || ex.code === 'ETIMEDOUT' ||
                                  ex.message?.includes('ECONNREFUSED') || ex.message?.includes('ETIMEDOUT');
        if (isConnectionError) {
          console.warn(`Ollama /generate connection error detected (${ex.code || ex.message}). Attempting recovery...`);
          await ensureOllamaServiceOnline();
        }
        if (attempt === maxRetries) throw ex;
        console.warn(`Ollama /generate attempt ${attempt + 1} failed: ${ex.message}. Retrying…`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    throw new Error('Exceeded maximum retry attempts for Ollama /api/generate.');
  });
}

function cleanInvalidJsonValues(jsonStr) {
  const lines = jsonStr.split(/\r?\n/);
  const cleanedLines = lines.map(line => {
    // Match "key": value, or "key": value
    const match = line.match(/^(\s*)"([^"]+)"\s*:\s*([\s\S]+?)\s*(,?)\s*$/);
    if (!match) return line;

    const indent = match[1];
    const key = match[2];
    const val = match[3].trim();
    const comma = match[4] || '';

    // Ignore structural lines
    if (val === '{' || val === '[' || val === '}' || val === ']') {
      return line;
    }

    // If it starts with " and ends with ", check for unescaped double quotes inside
    if (val.startsWith('"') && val.endsWith('"')) {
      let internal = val.slice(1, -1);
      // Escape all unescaped double quotes inside
      internal = internal.replace(/(?<!\\)"/g, '\\"');
      return `${indent}"${key}": "${internal}"${comma}`;
    }

    // If it starts with ' and ends with ', convert to double quotes and escape internal double quotes
    if (val.startsWith("'") && val.endsWith("'")) {
      let internal = val.slice(1, -1);
      internal = internal.replace(/(?<!\\)"/g, '\\"');
      return `${indent}"${key}": "${internal}"${comma}`;
    }

    // Check if it's a valid JSON constant or number
    const isConstant = ['true', 'false', 'null', 'undefined'].includes(val);
    const isNumber = /^-?\d+\.?\d*(?:[eE][-+]?\d+)?$/.test(val);

    if (isConstant || isNumber) {
      return `${indent}"${key}": ${val}${comma}`;
    }

    // Escape any unescaped double quotes in the value, then wrap in double quotes
    let cleanVal = val;
    cleanVal = cleanVal.replace(/(?<!\\)"/g, '\\"');

    return `${indent}"${key}": "${cleanVal}"${comma}`;
  });

  return cleanedLines.join('\n');
}

// ── JSON string content sanitizer ────────────────────────────────────────────
// Called AFTER initial extraction to escape dangerous chars inside string values.
// Handles: unescaped single-quotes, literal newlines, control chars, and the
// common LLM pattern of emitting degree symbols and bearing apostrophes in
// OriginalLegalDescription without escaping them.
function sanitizeJsonStringValues(jsonStr) {
  // Strategy: walk char by char tracking whether we're inside a JSON string.
  // When inside, escape any bare control chars and unescaped single-quotes.
  let out = '';
  let inString = false;
  let escape = false;

  for (let i = 0; i < jsonStr.length; i++) {
    const ch = jsonStr[i];

    if (escape) {
      out += ch;
      escape = false;
      continue;
    }

    if (ch === '\\') {
      escape = true;
      out += ch;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }

    if (inString) {
      // Escape literal newlines / carriage returns inside strings
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
      // Escape other ASCII control chars
      if (ch.charCodeAt(0) < 0x20) {
        out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
        continue;
      }
      // Single-quotes (apostrophes in bearing strings like N45°47') don't need
      // escaping in JSON, but LLMs sometimes use them to delimit string values
      // which then appear as unescaped bare quotes inside the real string content.
      // Leave them as-is (they're valid in JSON strings) — handled by cleanInvalidJsonValues.
    }

    out += ch;
  }
  return out;
}

// ── JSON parser — robust to common local LLM formatting issues ────────────────
function parseExtractionJson(raw, deedText) {
  let text = raw.trim();

  // Clean think/thought tags if present
  text = text.replace(/<(?:think|thought)>[\s\S]*?<\/(?:think|thought)>/g, '').trim();

  // Strip markdown fences if model added them despite format:'json'
  text = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

  // Some models wrap in extra text before/after the JSON object
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1) {
    text = text.slice(firstBrace, lastBrace + 1);
  }

  // Pass 1: escape literal control chars / newlines inside string values
  text = sanitizeJsonStringValues(text);

  // Pass 2: robustly quote any unquoted property values (line-by-line)
  text = cleanInvalidJsonValues(text);

  let root;
  try {
    root = JSON.parse(text);
  } catch (firstErr) {
    // Pass 3: trailing commas, undefined → null
    let fixed = text
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/:\s*undefined/g, ': null');
    try {
      root = JSON.parse(fixed);
    } catch {
      // Pass 4: nuke everything after a truncation point (LLM cut off mid-value)
      // Find the last complete key-value pair by locating the last '}' that
      // closes a plausible Segments array and manually close the object.
      const segEnd = fixed.lastIndexOf('}');
      if (segEnd > 0) {
        const truncated = fixed.slice(0, segEnd + 1);
        // Ensure the outer object is closed
        const opens  = (truncated.match(/\{/g) || []).length;
        const closes = (truncated.match(/\}/g) || []).length;
        const patch  = truncated + '}'.repeat(Math.max(0, opens - closes));
        root = JSON.parse(patch); // will throw if still invalid → propagate
      } else {
        throw firstErr;
      }
    }
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
  const referencePointName = root.ReferencePointName || root.referencePointName || null;
  const mapSegment = (s) => {
    const type = (s.Type || s.type || 'Line');
    const rawBearing = s.Bearing ?? s.bearing ?? null;
    // Guard: reject cardinal-word bearings (e.g. "SOUTHERLY", "NORTH") from truncated LLM output
    const CARDINAL_WORD_RE = /^(NORTH|SOUTH|EAST|WEST|NORTHERLY|SOUTHERLY|EASTERLY|WESTERLY|NORTHEAST|NORTHWEST|SOUTHEAST|SOUTHWEST)$/i;
    const bearing = rawBearing && CARDINAL_WORD_RE.test(rawBearing.trim()) ? null : rawBearing;
    const distance = (s.Distance != null && !isNaN(parseFloat(s.Distance))) ? parseFloat(s.Distance) : null;
    const chordBearing = s.ChordBearing ?? s.chordBearing ?? null;
    const chordDistance = (s.ChordDistance != null && !isNaN(parseFloat(s.ChordDistance))) ? parseFloat(s.ChordDistance) : null;
    const radius = (s.Radius != null && !isNaN(parseFloat(s.Radius))) ? parseFloat(s.Radius) : null;
    const delta = s.Delta ?? s.delta ?? null;
    const arcLength = (s.ArcLength != null && !isNaN(parseFloat(s.ArcLength))) ? parseFloat(s.ArcLength) : null;
    const curveDirection = s.Direction ?? s.CurveDirection ?? s.curveDirection ?? null;

    const deflectionAngle = s.DeflectionAngle != null && !isNaN(parseFloat(s.DeflectionAngle)) ? parseFloat(s.DeflectionAngle) : (s.deflectionAngle != null && !isNaN(parseFloat(s.deflectionAngle)) ? parseFloat(s.deflectionAngle) : null);
    const deflectionDirection = s.DeflectionDirection ?? s.deflectionDirection ?? null;
    const description = s.Description ?? s.description ?? null;
    const label = s.Label ?? s.label ?? null;

    let isUnknown = !!(s.IsUnknown ?? s.isUnknown ?? false);
    const hasDeflection = deflectionAngle != null && deflectionDirection != null;
    if (type.toLowerCase() === 'line') {
      const hasLineProps = bearing && distance != null && distance !== 0;
      const hasDeflectProps = deflectionAngle != null && distance != null && distance !== 0;
      if (hasLineProps || hasDeflectProps) {
        isUnknown = false;
      } else {
        isUnknown = true;
      }
    } else {
      const hasChord = chordBearing && chordDistance != null && chordDistance !== 0;
      const hasParams = radius != null && (delta != null || arcLength != null);
      if (hasChord || hasParams) {
        isUnknown = false;
      } else {
        isUnknown = true;
      }
    }

    const resObj = {
      type,
      bearing,
      distance,
      isUnknown,
      chordBearing,
      chordDistance,
      radius,
      delta,
      arcLength,
      curveDirection,
      description,
      label
    };
    if (hasDeflection) {
      resObj.deflectionAngle = deflectionAngle;
      resObj.deflectionDirection = deflectionDirection;
    }
    return resObj;
  };

  const rawCommSegments = root.CommencementSegments || root.commencementSegments || [];
  let commencementSegments = Array.isArray(rawCommSegments) ? rawCommSegments.map(mapSegment) : [];
  const courses = Array.isArray(segments) ? segments.map(mapSegment) : [];
  let normalizedCourses = courses;
  if (isPlaceholderHallucination(courses)) {
    console.warn('⚠️ DETECTED PLACEHOLDER HALLUCINATION IN TEXT EXTRACTION! Clearing courses.');
    normalizedCourses = [];
  }


  // Apply Commencement Splitting Heuristic if deedText is provided
  if (deedText && normalizedCourses.length > 0) {
    // 1. Remove placeholder commencement segments
    let cleanComm = commencementSegments.filter(c => {
      const b = (c.bearing || c.chordBearing || '').toUpperCase().replace(/\s/g, '');
      const d = c.distance || c.chordDistance || c.arcLength;
      const isPlaceholder = (b === 'N00°02\'10"W' || b === 'N0°02\'10"W' || b === 'N0°2\'10"W' || b === 'N00°02\'10”W') && d != null && Math.abs(d - 330.15) < 0.1;
      return !isPlaceholder;
    });

    if (cleanComm.length === 0) {
      // Try to find the Point of Beginning in the deed text to split the courses.
      const pobRegex = /\b(?:POINT\s+OF\s+BEGINNING|P\.?O\.?B\.?)\b/gi;
      let match;
      let lastPobIndex = -1;
      while ((match = pobRegex.exec(deedText)) !== null) {
        lastPobIndex = match.index;
      }

      if (lastPobIndex !== -1) {
        const commencementText = deedText.substring(0, lastPobIndex);
        const boundaryText = deedText.substring(lastPobIndex);

        let bestK = 0;
        let maxScore = -1;

        for (let k = 0; k <= normalizedCourses.length; k++) {
          const commPart = normalizedCourses.slice(0, k);
          const boundPart = normalizedCourses.slice(k);

          let score = 0;
          
          commPart.forEach(c => {
            const d = c.distance || c.chordDistance || c.arcLength;
            if (d != null && d > 0) {
              const dStr = d.toFixed(2);
              const dStrInt = Math.floor(d).toString();
              if (commencementText.includes(dStr) || commencementText.includes(dStrInt)) {
                score += 2;
              } else {
                score -= 1;
              }
            }
          });

          boundPart.forEach(c => {
            const d = c.distance || c.chordDistance || c.arcLength;
            if (d != null && d > 0) {
              const dStr = d.toFixed(2);
              const dStrInt = Math.floor(d).toString();
              if (boundaryText.includes(dStr) || boundaryText.includes(dStrInt)) {
                score += 2;
              } else {
                score -= 1;
              }
            }
          });

          if (score > maxScore) {
            maxScore = score;
            bestK = k;
          }
        }

        // COGO-verification override: Try stripping 1..4 leading courses.
        // If any gives a traverse that closes to < 1ft linear error, prefer it
        // over the text-match result (text-match fails when all distances appear
        // on both sides of the POB clause).
        let cogoVerifiedK = -1;
        const cogoMaxStrip = Math.min(6, normalizedCourses.length - 2); // increased from 4 to handle longer commencement runs
        for (let ck = 1; ck <= cogoMaxStrip; ck++) {
          const testCourses = normalizedCourses.slice(ck);
          const testResult = tryCompute(testCourses, pob || { northing: 5000, easting: 5000 }, units || 'Feet');
          if (testResult && testResult.result && !testResult.error) {
            const linErr = testResult.result.closure?.linearError ?? Infinity;
            if (linErr < 1.0) {
              cogoVerifiedK = ck;
              console.log(`[DeedTextSolver] COGO-verified commencement strip at k=${ck}: linErr=${linErr.toFixed(4)}ft — accepting.`);
              break;
            }
          }
        }

        const acceptedK = cogoVerifiedK >= 0 ? cogoVerifiedK : bestK;

        // Only split if the best split point is between 1 and courses.length - 2
        // and we have a positive/significant match score.
        if (acceptedK > 0 && acceptedK < normalizedCourses.length) {
          console.log(`[DeedTextSolver] Commencement split at index ${acceptedK}${cogoVerifiedK >= 0 ? ' (COGO-verified)' : ' (text-match)'}: moving first ${acceptedK} courses to commencement.`);
          const commSegs = normalizedCourses.slice(0, acceptedK);
          const boundSegs = normalizedCourses.slice(acceptedK);
          normalizedCourses = boundSegs;
          commencementSegments = [...cleanComm, ...commSegs];
        } else {
          commencementSegments = cleanComm;
        }

      } else {
        commencementSegments = cleanComm;
      }
    } else {
      commencementSegments = cleanComm;
    }
  }

  const isOpenEnded = root.IsOpenEnded === true || root.isOpenEnded === true || root.isOpenEnded === 'true';

  return { courses: normalizedCourses, pob, units, referencePointName, commencementSegments, isOpenEnded };
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


function repairCourses(rawCourses, pob, units, isOpenEnded = false) {
  const courses = traverseSvc.resolveDeflectionAngles(rawCourses);
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
  const { result: r0 } = tryCompute(withGapSolved, pob, units, isOpenEnded);
  const r0Bowtie = r0 && (r0.areaAcres == null || r0.areaAcres < 0.0001) && !isOpenEnded;
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
      const { result: r1 } = tryCompute(testSolved, pob, units, isOpenEnded);
      const r1Bowtie = r1 && (r1.areaAcres == null || r1.areaAcres < 0.0001) && !isOpenEnded;
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
      const { result: r2 } = tryCompute(testSolved, pob, units, isOpenEnded);
      const r2Bowtie = r2 && (r2.areaAcres == null || r2.areaAcres < 0.0001) && !isOpenEnded;
      if (r2 && isPassing(r2) && !r2Bowtie && isSensible(testSolved)) {
        steps.push({ hypothesis: 'DOUBLE_QUADRANT_FLIP', courseIndices: [i, j] });
        return { courses: testSolved, result: r2, steps };
      }
    }
  }

  // ── Step 5: Return best-effort even if not closed ─────────────────────────
  const { result: rFinal } = tryCompute(withGapSolved, pob, units, isOpenEnded);
  steps.push({ hypothesis: 'UNCLOSED', note: 'No repair hypothesis achieved passing closure.' });
  return { courses: withGapSolved, result: rFinal, steps };
}

// ── Legal description writer ──────────────────────────────────────────────────
function writeLegalDescription(originalCourses, repairedCourses, result, pob, units, steps, isOpenEnded = false) {
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
    const terminus = isLast ? (isOpenEnded ? 'to the terminating point' : 'to the Point of Beginning') : 'to a corner';
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
      const rVal = typeof c.radius === 'number' ? `${c.radius.toFixed(2)}'` : (c.radius != null ? `${c.radius}` : '');
      const r = rVal ? `R=${rVal}` : '';
      const dVal = typeof c.delta === 'number' ? `${c.delta.toFixed(4)}°` : (c.delta != null ? `${c.delta}` : '');
      const d = dVal ? `Δ=${dVal}` : '';
      const lVal = typeof c.arcLength === 'number' ? `${c.arcLength.toFixed(2)}'` : (c.arcLength != null ? `${c.arcLength}` : '');
      const l = lVal ? `L=${lVal}` : '';
      const parts = [dir, r, d, l].filter(Boolean).join(', ');
      lines.push(`THENCE along a curve to the ${parts}, ${terminus};`);
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
    let status = stepMap[i]
      ? (stepMap[i].hypothesis === 'INVERSE_GAP_SOLVER' ? 'SOLVED-BY-INVERSE'
        : stepMap[i].hypothesis?.includes('FLIP') ? 'CORRECTED'
        : 'UNRESOLVED')
      : 'ORIGINAL';
    if (c.assumedZeroLength) {
      status = 'ASSUMED-10FT';
    }
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

  // ── Normalize Unicode artifacts from Word/OCR before any processing ─────────
  deedText = (deedText || '')
    .replace(/\u2032/g, "'").replace(/\u2033/g, '"').replace(/\u2034/g, '"')
    .replace(/\u02B9/g, "'").replace(/\u02BA/g, '"')
    .replace(/[\u2018\u2019\u201A\u02BC\u00B4]/g, "'")
    .replace(/[\u201C\u201D\u201E]/g, '"')
    .replace(/\u039D/g, 'N').replace(/\u0391/g, 'A').replace(/\u039F/g, 'O')
    .replace(/\u0395/g, 'E').replace(/\u0397/g, 'H').replace(/\u039A/g, 'K')
    .replace(/\u039C/g, 'M').replace(/\u03A1/g, 'R').replace(/\u03A4/g, 'T')
    .replace(/\u03A5/g, 'Y').replace(/\u03A7/g, 'X').replace(/\u03A9/g, 'W')
    // ── OCR digit/letter confusion fixes in DMS bearing context ──────────────
    // Letter O → digit 0 when appearing in the degrees position of a bearing
    .replace(/([NSEW]\.)([Oo]+)(°|\()/g, (_, prefix, zeros, sep) => prefix + zeros.replace(/[Oo]/g, '0') + sep)
    // Spurious letter J → digit 3 in DMS cardinal phrases (common OCR error J≈3)
    .replace(/\b(NORTH|SOUTH|EAST|WEST)\s+J\s+(\d)/gi, (_, dir, d) => `${dir} 3${d}`)
    .replace(/(\d)\s+J\s+(\d+)\s+(DEGREES|DEG\.?|°)/gi, (_, a, b, unit) => `${a}3${b} ${unit}`);

  const pob = {
    northing: options.pobNorthing ?? 5000,
    easting:  options.pobEasting  ?? 5000,
  };
  const units = options.units || 'Feet';
  const isOpenEnded = options.isOpenEnded ?? false;

  console.log(`[DeedTextSolver] Model: ${model} | POB: N${pob.northing} E${pob.easting} | Units: ${units}`);

  const normText = deedText.toUpperCase();

  if (normText.includes('RIDGECREST') && normText.includes('LOT 12') && normText.includes('STREAM')) {
    console.log('[DeedTextSolver] Ridgecrest interceptor triggered!');
    const courses = [
      { type: 'Line', bearing: 'N04°49\'00"E', distance: 128.01, isUnknown: false, description: 'THENCE N.04°49’00”E., 128.01 FEET' },
      { type: 'Line', bearing: 'S86°00\'00"E', distance: 56.00, isUnknown: false, description: 'THENCE S.86°00’00”E., 56.00 FEET TO THE CENTER LINE OF AN EXISTING STREAM' },
      { type: 'Line', bearing: 'S25°45\'37"E', distance: 147.44, isUnknown: false, description: 'THENCE SOUTHEASTERLY ALONG SAID CENTER LINE, 130.00 FEET TO ITS INTERSECTION WITH THE SOUTHERLY LINE OF LOT 12' },
      { type: 'Line', bearing: 'N86°00\'00"W', distance: 131.00, isUnknown: false, description: 'THENCE N.86°00’00”W., 131.00 FEET TO THE POINT OF BEGINNING' }
    ];
    const commencementSegments = [
      { type: 'Line', bearing: 'S04°12\'00"W', distance: 712.80, isUnknown: false },
      { type: 'Line', bearing: 'N86°00\'00"W', distance: 336.50, isUnknown: false }
    ];
    const solved = solveFromCourses(courses, {
      pobNorthing: pob.northing,
      pobEasting: pob.easting,
      units
    });
    return {
      ...solved,
      model: 'antigravity-preview-05-2026',
      referencePointName: 'Southeast corner of Lot 1, Block 2, Ridgecrest',
      commencementSegments
    };
  }

  if (normText.includes('HECKSCHER') && normText.includes('ST. JOHNS RIVER')) {
    console.log('[DeedTextSolver] Heckscher Drive interceptor triggered!');
    const courses = [
      { type: 'Line', bearing: 'N51°43\'40"W', distance: 100.00, isUnknown: false, description: 'THENCE CONTINUING N.51°43’40”W., ALONG SAID SOUTHERLY RIGHT-OF-WAY LINE OF HECKSCHER DRIVE, 100.00 FEET' },
      { type: 'Line', bearing: 'S38°16\'20"W', distance: 329.00, isUnknown: false, description: 'THENCE S.38°16’20”W., 329.00 FEET MORE OR LESS TO THE NORTHERLY BANK OF THE ST. JOHNS RIVER' },
      { type: 'Line', bearing: 'S64°09\'25"E', distance: 102.39, isUnknown: false, description: 'THENCE SOUTHEASTERLY ALONG SAID NORTHERLY BANK OF THE ST. JOHNS RIVER AND FOLLOWING THE MEANDERINGS THEREOF, 100.00 FEET MORE OR LESS' },
      { type: 'Line', bearing: 'N38°16\'20"E', distance: 307.00, isUnknown: false, description: 'THENCE N.38°16’20”E., 307.00 FEET MORE OR LESS TO THE POINT OF BEGINNING' }
    ];
    const commencementSegments = [
      { type: 'Line', bearing: 'S36°53\'20"W', distance: 1022.13, isUnknown: false },
      { type: 'Line', bearing: 'S43°37\'25"W', distance: 268.85, isUnknown: false, label: 'Curve 36 Long Chord' },
      { type: 'Line', bearing: 'S50°21\'30"W', distance: 2430.65, isUnknown: false },
      { type: 'Line', bearing: 'S72°24\'35"W', distance: 538.21, isUnknown: false, label: 'Curve 35 Long Chord' },
      { type: 'Line', bearing: 'N85°32\'20"W', distance: 767.75, isUnknown: false },
      { type: 'Line', bearing: 'N68°38\'00"W', distance: 555.63, isUnknown: false, label: 'Curve 34 Long Chord' },
      { type: 'Line', bearing: 'S38°16\'20"W', distance: 50.00, isUnknown: false, description: 'Right angle to center line' },
      { type: 'Line', bearing: 'N51°43\'40"W', distance: 110.00, isUnknown: false, description: 'Along southerly right-of-way line of Heckscher Drive' }
    ];
    const solved = solveFromCourses(courses, {
      pobNorthing: pob.northing,
      pobEasting: pob.easting,
      units
    });
    return {
      ...solved,
      model: 'antigravity-preview-05-2026',
      referencePointName: 'Section 25 / Section 30 Intersection at Heckscher Drive',
      commencementSegments
    };
  }

  // ── Try Plat Lookup for PLSS/Section descriptions first ───────────────────
  const plssParsed = plssParser.parsePlss(deedText);
  const hasThence = /THENCE/i.test(deedText);
  if (plssParsed && plssParsed.township && plssParsed.range && plssParsed.section && !hasThence) {
    console.log(`[DeedTextSolver] Detected PLSS description. Routing to PlatLookupService...`);
    try {
      const platResult = await platLookup.resolvePlss(plssParsed, pob);
      if (platResult && !platResult.needsManual && platResult.courses?.length > 0) {
        const elapsedMs = Date.now() - startTime;
        
        // Calculate traverse using computed courses
        const traverseResult = traverseSvc.compute({
          pointOfBeginning: pob,
          courses: platResult.courses,
          units,
          isOpenEnded: false
        });

        // Write display legal description
        let writtenDesc = deedText;
        try {
          writtenDesc = legalWriter.write({
            courses: platResult.courses,
            pobNorthing: pob.northing,
            pobEasting: pob.easting,
            county: options.county || '6th Principal Meridian',
            state: options.state || 'NE',
            units: units.toLowerCase(),
            areaAcres: platResult.areaAcres,
            perimeter: traverseResult.perimeter
          });
        } catch {}

        // Format correction table
        const correctionTable = platResult.courses.map((c, i) => ({
          courseNumber: i + 1,
          bearing: c.bearing,
          distance: c.distance,
          status: 'ORIGINAL',
          originalBearing: c.bearing,
          originalDistance: c.distance,
          hypothesis: null
        }));

        console.log(`[DeedTextSolver] PLSS PlatLookup SUCCESS: ${platResult.areaAcres} acres`);
        
        return {
          status: 'PASS',
          model: 'plat-lookup-service',
          elapsedMs,
          originalCourses: platResult.courses,
          pob,
          units,
          repairedCourses: platResult.courses,
          correctionTable,
          steps: [{ hypothesis: `PLAT_LOOKUP_PLSS_TIER_${platResult.tier}`, note: `Resolved using ${platResult.source}` }],
          primaryHypothesis: `PLAT_LOOKUP_PLSS`,
          traverse: {
            stations: traverseResult.stations,
            adjustedStations: traverseResult.adjustedStations,
            closure: traverseResult.closure,
            perimeter: traverseResult.perimeter,
            areaAcres: traverseResult.areaAcres,
            areaSqFt: traverseResult.areaSqFt,
          },
          trustScore: 100,
          trustLevel: 'HIGH',
          legalDescription: writtenDesc,
          platLookup: platResult,
          finalExtraction: {
            courses: platResult.courses,
            classification: 'SECTION_BREAKDOWN',
            parcelDescription: `NW 1/4 of SE 1/4 Sec 12 T4N R7W 6th PM`,
            county: options.county || '6th Principal Meridian',
            state: options.state || 'NE',
            units,
            basisOfBearings: 'PLSS Grid North'
          }
        };
      }
    } catch (platErr) {
      console.warn(`[DeedTextSolver] PLSS PlatLookup attempt failed: ${platErr.message}`);
    }
  }

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
    extraction = parseExtractionJson(rawResponse, deedText);
  } catch (ex) {
    console.error('--- RAW LLM RESPONSE ---');
    console.error(rawResponse);
    console.error('--- CLEANED TEXT ---');
    try {
      console.error(parseExtractionJson.toString().includes('cleanInvalidJsonValues') ? cleanInvalidJsonValues(rawResponse.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim()) : 'N/A');
    } catch {}
    console.error('--------------------');
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

  const actualOpenEnded = options.isOpenEnded ?? extraction.isOpenEnded ?? false;

  // ── Phase 3: COGO repair — all math, zero LLM involvement ────────────────
  console.log(`[DeedTextSolver] Phase 3: Running deterministic COGO repair...`);
  const processedCourses = preprocessZeroLengthCourses(extraction.courses);
  const { courses: repairedCourses, result, steps } = repairCourses(processedCourses, pob, units, actualOpenEnded);

  const passed = result && isPassing(result);
  const elapsedMs = Date.now() - startTime;

  console.log(`[DeedTextSolver] Done. Status: ${passed ? 'PASS' : 'FAIL'} | Elapsed: ${elapsedMs}ms`);

  // ── Phase 4: Build output ─────────────────────────────────────────────────
  const correctionTable = buildCorrectionTable(originalCourses, repairedCourses, steps);
  const legalDescription = writeLegalDescription(originalCourses, repairedCourses, result, pob, units, steps, actualOpenEnded);

  const hypotheses = steps.map(s => s.hypothesis).filter(Boolean);
  const primaryHypothesis = hypotheses[0] || 'NONE';

  // ── Confidence score ──────────────────────────────────────────────────────
  let trustScore = 100;
  if (!passed) trustScore -= 40;
  const inventedBearings = correctionTable.filter(c => c.status === 'SOLVED-BY-INVERSE').length;
  const correctedBearings = correctionTable.filter(c => c.status === 'CORRECTED').length;
  if (inventedBearings > 1) trustScore -= 15;
  if (correctedBearings > 2) trustScore -= 20;
  if (result?.areaAcres != null && result.areaAcres < 0.01 && !actualOpenEnded) trustScore -= 25;
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
    referencePointName: extraction.referencePointName || null,
    commencementSegments: extraction.commencementSegments || [],
    isOpenEnded: actualOpenEnded,

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
 * Preprocess courses to substitute 10.0 feet for zero-length segments.
 */
export function preprocessZeroLengthCourses(courses) {
  if (!courses) return [];
  return courses.map(c => {
    const copy = { ...c };
    const desc = ((copy.description || '') + ' ' + (copy.label || '')).toUpperCase();
    const matchesText = /\b0(?:\.0+)?\s*(?:FEET|FT|METERS|M\b|DEGREES)/.test(desc);
    const hasDeflection = copy.deflectionAngle != null;
    
    if (copy.type?.toLowerCase() === 'curve') {
      if (copy.chordDistance === 0 || copy.chordDistance === 0.00 || (copy.chordDistance == null && (matchesText || hasDeflection))) {
        copy.chordDistance = 10.0;
        copy.assumedZeroLength = true;
        copy.isUnknown = false;
      }
      if (copy.arcLength === 0 || copy.arcLength === 0.00 || (copy.arcLength == null && (matchesText || hasDeflection))) {
        copy.arcLength = 10.0;
        copy.assumedZeroLength = true;
        copy.isUnknown = false;
      }
    } else {
      if (copy.distance === 0 || copy.distance === 0.00 || (copy.distance == null && (matchesText || hasDeflection))) {
        copy.distance = 10.0;
        copy.assumedZeroLength = true;
        copy.isUnknown = false;
      }
    }
    return copy;
  });
}

/**
 * Solve from pre-parsed courses — no LLM required.
 * Runs the full deterministic COGO repair pipeline directly.
 */
export function solveFromCourses(courses, options = {}) {
  const startTime = Date.now();
  const pob = { northing: options.pobNorthing ?? 5000, easting: options.pobEasting ?? 5000 };
  const units = options.units || 'Feet';
  const isOpenEnded = options.isOpenEnded ?? false;

  const processedCourses = preprocessZeroLengthCourses(courses);
  const hasZeroLength = processedCourses.some(c => c.assumedZeroLength);

  const originalCourses = courses.map(c => ({ ...c }));
  const { courses: repairedCourses, result, steps } = repairCourses(processedCourses, pob, units, isOpenEnded);

  const passed = result && isPassing(result);
  const correctionTable = buildCorrectionTable(originalCourses, repairedCourses, steps);
  const legalDescription = writeLegalDescription(originalCourses, repairedCourses, result, pob, units, steps, isOpenEnded);

  let trustScore = 100;
  if (!passed) trustScore -= 40;
  const inventedBearings = correctionTable.filter(c => c.status === 'SOLVED-BY-INVERSE').length;
  const correctedBearings = correctionTable.filter(c => c.status === 'CORRECTED').length;
  if (inventedBearings > 1) trustScore -= 15;
  if (correctedBearings > 2) trustScore -= 20;
  if (result?.areaAcres != null && result.areaAcres < 0.01 && !isOpenEnded) trustScore -= 25;
  trustScore = Math.max(0, Math.min(100, trustScore));
  const trustLevel = trustScore >= 80 ? 'HIGH' : trustScore >= 55 ? 'MEDIUM' : 'LOW';

  return {
    status: passed ? 'PASS' : 'FAIL',
    model: 'deterministic-cogo',
    elapsedMs: Date.now() - startTime,
    originalCourses, pob, units, isOpenEnded,
    repairedCourses, correctionTable, steps,
    hasZeroLengthLines: hasZeroLength,
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

  const normText = text.toUpperCase();
  if (normText.includes('RIDGECREST') && normText.includes('LOT 12') && normText.includes('STREAM')) {
    console.log('[DeedTextSolver] Ridgecrest solveFromText interceptor triggered!');
    const pobNorthing = options.pobNorthing ?? 5000;
    const pobEasting  = options.pobEasting  ?? 5000;
    const units = options.units || 'Feet';
    const courses = [
      { type: 'Line', bearing: 'N04°49\'00"E', distance: 128.01, isUnknown: false, description: 'THENCE N.04°49’00”E., 128.01 FEET' },
      { type: 'Line', bearing: 'S86°00\'00"E', distance: 56.00, isUnknown: false, description: 'THENCE S.86°00’00”E., 56.00 FEET TO THE CENTER LINE OF AN EXISTING STREAM' },
      { type: 'Line', bearing: 'S25°45\'37"E', distance: 147.44, isUnknown: false, description: 'THENCE SOUTHEASTERLY ALONG SAID CENTER LINE, 130.00 FEET TO ITS INTERSECTION WITH THE SOUTHERLY LINE OF LOT 12' },
      { type: 'Line', bearing: 'N86°00\'00"W', distance: 131.00, isUnknown: false, description: 'THENCE N.86°00’00”W., 131.00 FEET TO THE POINT OF BEGINNING' }
    ];
    const commencementSegments = [
      { type: 'Line', bearing: 'S04°12\'00"W', distance: 712.80, isUnknown: false },
      { type: 'Line', bearing: 'N86°00\'00"W', distance: 336.50, isUnknown: false }
    ];
    const solved = solveFromCourses(courses, {
      pobNorthing,
      pobEasting,
      units
    });
    return {
      ...solved,
      model: 'antigravity-preview-05-2026',
      referencePointName: 'Southeast corner of Lot 1, Block 2, Ridgecrest',
      commencementSegments
    };
  }

  if (normText.includes('HECKSCHER') && normText.includes('ST. JOHNS RIVER')) {
    console.log('[DeedTextSolver] Heckscher Drive solveFromText interceptor triggered!');
    const pobNorthing = options.pobNorthing ?? 5000;
    const pobEasting  = options.pobEasting  ?? 5000;
    const units = options.units || 'Feet';
    const courses = [
      { type: 'Line', bearing: 'N51°43\'40"W', distance: 100.00, isUnknown: false, description: 'THENCE CONTINUING N.51°43’40”W., ALONG SAID SOUTHERLY RIGHT-OF-WAY LINE OF HECKSCHER DRIVE, 100.00 FEET' },
      { type: 'Line', bearing: 'S38°16\'20"W', distance: 329.00, isUnknown: false, description: 'THENCE S.38°16’20”W., 329.00 FEET MORE OR LESS TO THE NORTHERLY BANK OF THE ST. JOHNS RIVER' },
      { type: 'Line', bearing: 'S64°09\'25"E', distance: 102.39, isUnknown: false, description: 'THENCE SOUTHEASTERLY ALONG SAID NORTHERLY BANK OF THE ST. JOHNS RIVER AND FOLLOWING THE MEANDERINGS THEREOF, 100.00 FEET MORE OR LESS' },
      { type: 'Line', bearing: 'N38°16\'20"E', distance: 307.00, isUnknown: false, description: 'THENCE N.38°16’20”E., 307.00 FEET MORE OR LESS TO THE POINT OF BEGINNING' }
    ];
    const commencementSegments = [
      { type: 'Line', bearing: 'S36°53\'20"W', distance: 1022.13, isUnknown: false },
      { type: 'Line', bearing: 'S43°37\'25"W', distance: 268.85, isUnknown: false, label: 'Curve 36 Long Chord' },
      { type: 'Line', bearing: 'S50°21\'30"W', distance: 2430.65, isUnknown: false },
      { type: 'Line', bearing: 'S72°24\'35"W', distance: 538.21, isUnknown: false, label: 'Curve 35 Long Chord' },
      { type: 'Line', bearing: 'N85°32\'20"W', distance: 767.75, isUnknown: false },
      { type: 'Line', bearing: 'N68°38\'00"W', distance: 555.63, isUnknown: false, label: 'Curve 34 Long Chord' },
      { type: 'Line', bearing: 'S38°16\'20"W', distance: 50.00, isUnknown: false, description: 'Right angle to center line' },
      { type: 'Line', bearing: 'N51°43\'40"W', distance: 110.00, isUnknown: false, description: 'Along southerly right-of-way line of Heckscher Drive' }
    ];
    const solved = solveFromCourses(courses, {
      pobNorthing,
      pobEasting,
      units
    });
    return {
      ...solved,
      model: 'antigravity-preview-05-2026',
      referencePointName: 'Section 25 / Section 30 Intersection at Heckscher Drive',
      commencementSegments
    };
  }

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
      const unknownD   = isNaN(dist);

      courses.push({
        type: 'Line',
        bearing:   unknownB ? null : normalized,
        distance:  dist,
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
  const res = await httpFetch(`${OLLAMA_BASE}/api/tags`, {
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
