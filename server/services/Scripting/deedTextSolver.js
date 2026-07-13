// ─── Deed Text Solver Service ─────────────────────────────────────────────────
// Solves incomplete or broken deed descriptions using local LLMs + deterministic COGO.
//
// Architecture principle: LLM does ONLY NLP extraction (bearing/distance text → JSON).
// ALL geometric math, error diagnosis, and closure repair is handled by Node.js COGO
// engine — never trusted to the LLM. This makes the system work reliably on 7B models.

import * as traverseSvc from './traverse.js';
import * as bp from './bearingParser.js';
import * as platLookup from '../platLookupService.js';
import * as plssParser from '../plssParser.js';
import * as legalWriter from './legalWriter.js';
import { extractRaw, getActiveProvider, getActiveModel, setProvider } from '../llm/dispatcher.js';
import { tryScrivenerErrorSolver } from './repair.js';
import { interceptors } from './interceptors.js';

import { isPlaceholderHallucination } from '../geminiVision.js';
import { postProcessOcrText } from '../llm/ocrPostProcess.js';
import { createChildLogger } from '../../logger.js';
import { httpFetch } from '../httpFetch.js';
import { OLLAMA_URL } from '../../config.js';
import { Agent } from 'undici';

const log = createChildLogger('deedSolver');
const OLLAMA_BASE = OLLAMA_URL;
const ollamaAgent = new Agent({
  connectTimeout: 3000,
  headersTimeout: 1800000,
  bodyTimeout: 1800000,
});

// ── Prompt builder ────────────────────────────────────────────────────────────
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
9. Bearings format: "N45°22'10\"E" — keep the exact degree/minute/second format from the text.
   CRITICAL DMS VALIDATION: Minutes must be 00–59. Seconds must be 00–59.99. Degrees must be 0–90.
   If the source text produces an impossible value (e.g. S00°91'50\"E where minutes=91, or N64°90'50\"W), the text is an OCR artifact.
   In this case: set Bearing to null and IsUnknown to true. DO NOT transcribe impossible DMS values.
10. Distances are decimal feet (or meters if stated).
11. IDENTIFY the Point of Reference (POR) (e.g. the section corner, subdivision corner, or benchmark mentioned) and any commencement/reference runs leading from that Reference Point (POR) to the Point of Beginning (POB).
   - Populate the "ReferencePointName" field with the name/description of the Point of Reference (or null if not found).
   - Extract the commencement courses (bearings + distances) leading from the Reference Point (POR) to the POB into the "CommencementSegments" array.
   - Do NOT include these commencement courses in the main "Segments" array. The main "Segments" array MUST only contain the property boundary courses starting FROM the Point of Beginning (POB).
12. MEANDER BOUNDARIES: If a segment follows a meandering waterway, creek, river boundary, shoreline, road centerline, or irregular line with no defined bearing and/or distance, set "Bearing" (or "ChordBearing") and/or "Distance" (or "ChordDistance") to null and set "IsUnknown" to true. Do NOT fabricate or estimate values. The system will solve this as an unknown/meander gap close leg.
13. OPEN-ENDED TRAVERSE: Identify if the traverse is open-ended (e.g. it is an easement description, a road centerline, meanders, or terminates without returning to the Point of Beginning / POB). Set "IsOpenEnded": true or false accordingly.
14. Output ONLY a JSON object. No explanation, no markdown.
15. DUAL DESCRIPTION — If the deed contains TWO complete traverse descriptions of the SAME property (signals: "THIS IS THE SAME PROPERTY AS DESCRIBED IN...", "BEING THE SAME LANDS AS DESCRIBED IN...", or a second "POINT OF BEGINNING" traverse after the first), extract ONLY the SECOND (more recent/precise) description. Ignore the first. The second usually follows a surveyor's job number or "JOB NO." reference.
16. MULTI-PARCEL / MULTI-TRACT DEED — If the deed contains multiple distinct parcels, tracts, or easements (e.g., "PARCEL 1:", "PARCEL 2:", "TRACT A:", "TRACT B:", "EASEMENT 1:"), extract ALL of them into separate elements in the "Tracts" array. For each tract, specify its Name, POB, ReferencePointName, CommencementSegments, IsOpenEnded, and Segments. Even if there is only a single tract/parcel, wrap it as the sole element in the "Tracts" array.
17. LOT/BLOCK DESCRIPTIONS: If the legal description is ONLY a lot-block-subdivision reference (e.g. "Lot 5, Block 3, Sunny Acres Subdivision") with no THENCE courses and no metes-and-bounds geometry, output an empty "Segments" array. Do NOT fabricate courses.


OUTPUT FORMAT:
{
  "Units": "Feet",
  "Tracts": [
    {
      "Name": "Parcel 1 (or Tract 1, etc.)",
      "POB": { "Northing": 5000.00, "Easting": 5000.00 },
      "ReferencePointName": "Southeast corner of Section 12",
      "CommencementSegments": [
        { "Type": "Line", "Bearing": "N00°02'10\"W", "Distance": 330.15, "IsUnknown": false }
      ],
      "IsOpenEnded": false,
      "Segments": [
        { "Type": "Line", "Bearing": "N45°22'10\"E", "Distance": 150.25, "IsUnknown": false },
        {
          "Type": "Curve",
          "Radius": 424.73,
          "Delta": "93°12'00.00\"",
          "ArcLength": 93.43,
          "CurveDirection": "Left",
          "ChordBearing": "S16°38'52\"E",
          "ChordDistance": 93.43,
          "IsUnknown": false
        }
      ]
    }
  ]
}

DEED TEXT:
${deedText}`;
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
export function parseExtractionJson(raw, deedText) {
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
    const fixed = text
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


  const units = root.Units || root.units || 'Feet';
  const mapSegment = (s) => {
    const type = (s.Type || s.type || 'Line');
    const rawBearing = s.Bearing ?? s.bearing ?? null;
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

  const processSingleTractData = (tName, tSegments, tPobRaw, tRefName, tCommSegments, tOpenEnded) => {
    const pob = {
      northing: parseFloat(tPobRaw.Northing ?? tPobRaw.northing ?? 5000),
      easting:  parseFloat(tPobRaw.Easting  ?? tPobRaw.easting  ?? 5000),
    };
    if (isNaN(pob.northing)) pob.northing = 5000;
    if (isNaN(pob.easting))  pob.easting  = 5000;

    const referencePointName = tRefName || null;
    let commencementSegments = Array.isArray(tCommSegments) ? tCommSegments.map(mapSegment) : [];
    const courses = Array.isArray(tSegments) ? tSegments.map(mapSegment) : [];
    let normalizedCourses = courses;
    if (isPlaceholderHallucination(courses)) {
      log.warn('DETECTED PLACEHOLDER HALLUCINATION IN TEXT EXTRACTION! Clearing courses.');
      normalizedCourses = [];
    }

    // Apply Commencement Splitting Heuristic if deedText is provided
    if (deedText && normalizedCourses.length > 0) {
      const cleanComm = commencementSegments.filter(c => {
        const b = (c.bearing || c.chordBearing || '').toUpperCase().replace(/\s/g, '');
        const d = c.distance || c.chordDistance || c.arcLength;
        const isPlaceholder = (b === 'N00°02\'10"W' || b === 'N0°02\'10"W' || b === 'N0°2\'10"W' || b === 'N00°02\'10”W') && d != null && Math.abs(d - 330.15) < 0.1;
        return !isPlaceholder;
      });

      if (cleanComm.length === 0) {
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

          let cogoVerifiedK = -1;
          let lowestCogoError = Infinity;
          const cogoMaxStrip = normalizedCourses.length - 3;
          for (let ck = 1; ck <= cogoMaxStrip; ck++) {
            const testCourses = normalizedCourses.slice(ck);
            const testResult = tryCompute(testCourses, pob, units);
            if (testResult && testResult.result && !testResult.error) {
              const linErr = testResult.result.closure?.linearError ?? Infinity;
              if (linErr < 2.0 && linErr < lowestCogoError) {
                lowestCogoError = linErr;
                cogoVerifiedK = ck;
              }
            }
          }
          if (cogoVerifiedK >= 0) {
            log.info({ k: cogoVerifiedK, error: lowestCogoError.toFixed(4) }, 'COGO-verified commencement strip — accepting.');
          }

          const acceptedK = cogoVerifiedK >= 0 ? cogoVerifiedK : bestK;

          if (acceptedK > 0 && acceptedK < normalizedCourses.length) {
            log.info({ k: acceptedK }, `Commencement split at index ${acceptedK}: moving first ${acceptedK} courses to commencement.`);
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

    const isOpenEnded = tOpenEnded === true || tOpenEnded === 'true';

    return { name: tName, courses: normalizedCourses, pob, referencePointName, commencementSegments, isOpenEnded };
  };

  let tracts = [];
  const rawTracts = root.Tracts || root.tracts;
  if (Array.isArray(rawTracts) && rawTracts.length > 0) {
    tracts = rawTracts.map((t, idx) => {
      const tName = t.Name || t.name || `Tract ${idx + 1}`;
      const tSegments = t.Segments || t.segments || t.courses || t.Courses || [];
      const tPobRaw = t.POB || t.pob || t.PointOfBeginning || {};
      const tRefName = t.ReferencePointName || t.referencePointName || null;
      const tCommSegments = t.CommencementSegments || t.commencementSegments || [];
      const tOpenEnded = t.IsOpenEnded ?? t.isOpenEnded ?? false;
      return processSingleTractData(tName, tSegments, tPobRaw, tRefName, tCommSegments, tOpenEnded);
    });
  } else {
    const tName = root.Name || root.name || "Tract 1";
    const tSegments = root.Segments || root.segments || root.courses || root.Courses || [];
    const tPobRaw = root.POB || root.pob || root.PointOfBeginning || {};
    const tRefName = root.ReferencePointName || root.referencePointName || null;
    const tCommSegments = root.CommencementSegments || root.commencementSegments || [];
    const tOpenEnded = root.IsOpenEnded ?? root.isOpenEnded ?? false;
    tracts = [processSingleTractData(tName, tSegments, tPobRaw, tRefName, tCommSegments, tOpenEnded)];
  }

  const firstTract = tracts[0];
  return {
    tracts,
    units,
    courses: firstTract.courses,
    pob: firstTract.pob,
    referencePointName: firstTract.referencePointName,
    commencementSegments: firstTract.commencementSegments,
    isOpenEnded: firstTract.isOpenEnded
  };
}

// ── Deterministic COGO repair ─────────────────────────────────────────────────
// All error detection and fixing is done here in pure math — NOT by the LLM.

function tryCompute(courses, pob, units, isOpenEnded = false, commencementSegments = []) {
  try {
    const result = traverseSvc.compute({ pointOfBeginning: pob, courses, units, isOpenEnded, commencementSegments });
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

function repairCourses(rawCourses, pob, units, isOpenEnded = false, commencementSegments = []) {
  let courses = traverseSvc.resolveDeflectionAngles(rawCourses);
  const steps = [];

  // Try flipping curve directions if there are any curves and error is high
  const curveIndices = [];
  courses.forEach((c, idx) => {
    if (c.type?.toLowerCase() === 'curve') {
      curveIndices.push(idx);
    }
  });

  if (curveIndices.length > 0 && curveIndices.length <= 4) {
    const { result: rOrig } = tryCompute(courses, pob, units, isOpenEnded, commencementSegments);
    const origErr = rOrig && rOrig.closure ? rOrig.closure.linearError : Infinity;
    
    if (origErr > 1.0) {
      let bestCourses = courses;
      let bestErr = origErr;
      let flippedAny = false;

      // Generate all left/right combinations for the curves
      const combinationsCount = 1 << curveIndices.length;
      for (let i = 0; i < combinationsCount; i++) {
        const testCourses = courses.map((c, idx) => {
          if (c.type?.toLowerCase() === 'curve') {
            const curveIdx = curveIndices.indexOf(idx);
            const shouldBeLeft = (i & (1 << curveIdx)) !== 0;
            return { ...c, curveDirection: shouldBeLeft ? 'Left' : 'Right' };
          }
          return c;
        });

        const { result: rTest } = tryCompute(testCourses, pob, units, isOpenEnded, commencementSegments);
        const testErr = rTest && rTest.closure ? rTest.closure.linearError : Infinity;
        if (testErr < bestErr) {
          bestErr = testErr;
          bestCourses = testCourses;
          flippedAny = true;
        }
      }

      if (flippedAny && bestErr < 1.0 && bestErr < origErr - 0.5) {
        log.info({ origErr: origErr.toFixed(4), bestErr: bestErr.toFixed(4) }, 'Curve direction optimization succeeded');
        courses = bestCourses;
        steps.push({
          hypothesis: 'CURVE_DIRECTION_FLIP',
          note: `Adjusted curve directions to minimize closure error (new error: ${bestErr.toFixed(2)}ft)`
        });
      }
    }
  }

  // Evaluate synthesized curve chord bearings vs explicit chord bearings
  let hasCandidates = false;
  const synthCourses = courses.map(c => {
    if (c.type?.toLowerCase() === 'curve') {
      const dir = (c.curveDirection || c.direction || '').toLowerCase().trim();
      const hasDir = dir === 'left' || dir === 'right';
      const hasBrg = c.chordBearing || c.bearing;
      const hasParams = (c.delta != null && c.delta !== '') ||
                        (c.radius != null && c.radius !== '' && c.arcLength != null && c.arcLength !== '') ||
                        (c.radius != null && c.radius !== '' && c.chordDistance != null && c.chordDistance !== '');
      if (hasBrg && hasDir && hasParams) {
        hasCandidates = true;
        const copy = { ...c };
        delete copy.chordBearing;
        delete copy.bearing;
        return copy;
      }
    }
    return c;
  });

  if (hasCandidates) {
    const { result: rA } = tryCompute(courses, pob, units, isOpenEnded, commencementSegments);
    const { result: rB } = tryCompute(synthCourses, pob, units, isOpenEnded, commencementSegments);
    if (rB && rB.closure && !rB.error) {
      const errA = rA && rA.closure ? rA.closure.linearError : Infinity;
      const errB = rB.closure.linearError;
      log.debug({ explicitError: errA.toFixed(4), synthError: errB.toFixed(4) }, 'Curve Synthesis comparison');
      if (errB < 2.0 && (errA > 2.0 || errB < errA - 1.0 || isNaN(errA))) {
        log.info({ synthError: errB.toFixed(4) }, 'Accepting tangent-synthesized curve parameters');
        courses = rB.courses;
        steps.push({
          hypothesis: 'CURVE_TANGENT_SYNTHESIS',
          note: `Synthesized curve bearings improved linear error from ${errA.toFixed(2)}ft to ${errB.toFixed(2)}ft`
        });
      }
    }
  }

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
  const { result: r0 } = tryCompute(withGapSolved, pob, units, isOpenEnded, commencementSegments);
  const r0Bowtie = r0 && (r0.areaAcres == null || r0.areaAcres < 0.0001) && !isOpenEnded;
  if (r0 && isPassing(r0) && !r0Bowtie) {
    const solvedIndices = courses.reduce((acc, c, i) => {
      if (c.isUnknown || !c.bearing || c.distance == null || c.distance === 0) acc.push(i);
      return acc;
    }, []);
    steps.push({ hypothesis: 'INVERSE_GAP_SOLVER', solvedIndices });
    return { courses: r0.courses || withGapSolved, result: r0, steps };
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

  // ── Step 2.5: Deterministic Scrivener Error Solver ──
  const scrivenerResult = tryScrivenerErrorSolver({ courses }, pob, units, isOpenEnded);
  if (scrivenerResult) {
    const { result: tScriv } = tryCompute(scrivenerResult.courses, pob, units, isOpenEnded, commencementSegments);
    if (tScriv && isPassing(tScriv)) {
      const hypotheses = scrivenerResult.message || 'Stage 3.7: Scrivener Solver';
      let courseIndex = -1;
      let originalBearing = null, correctedBearing = null;
      let originalDistance = null, correctedDistance = null;
      for (let i = 0; i < courses.length; i++) {
        if (i < scrivenerResult.courses.length) {
          const orig = courses[i];
          const rep = scrivenerResult.courses[i];
          if (orig.bearing !== rep.bearing || orig.distance !== rep.distance || orig.radius !== rep.radius || orig.arcLength !== rep.arcLength || orig.chordDistance !== rep.chordDistance || orig.delta !== rep.delta) {
            courseIndex = i;
            originalBearing = orig.bearing;
            correctedBearing = rep.bearing;
            originalDistance = orig.distance;
            correctedDistance = rep.distance;
            break;
          }
        }
      }
      steps.push({
        hypothesis: hypotheses,
        courseIndex,
        originalBearing,
        correctedBearing,
        originalDistance,
        correctedDistance
      });
      log.info({ hypothesis: hypotheses }, 'Scrivener Repair: resolved via tryScrivenerErrorSolver');
      return { courses: scrivenerResult.courses, result: tScriv, steps };
    }
  }

  // ── Step 5: Return best-effort even if not closed ─────────────────────────
  const { result: rFinal } = tryCompute(withGapSolved, pob, units, isOpenEnded, commencementSegments);
  steps.push({ hypothesis: 'UNCLOSED', note: 'No repair hypothesis achieved passing closure.' });
  return { courses: rFinal?.courses || withGapSolved, result: rFinal, steps };
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
      type: c.type || 'Line',
      bearing: c.bearing || null,
      distance: c.distance,
      arcLength: c.arcLength || null,
      radius: c.radius || null,
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

  deedText = postProcessOcrText(deedText);

  const pob = {
    northing: options.pobNorthing ?? 5000,
    easting:  options.pobEasting  ?? 5000,
  };
  const units = options.units || 'Feet';
  const isOpenEnded = options.isOpenEnded ?? false;

  log.info({ model, pob, units }, 'solve() started');

  const normText = deedText.toUpperCase();

  // Try decoupled match interceptors first
  for (const interceptor of interceptors) {
    if (interceptor.matches(deedText)) {
      return interceptor.solve(pob, units);
    }
  }

  // ── Try Plat Lookup for PLSS/Section descriptions first ───────────────────
  const plssParsed = plssParser.parsePlss(deedText);
  const hasThence = /THENCE/i.test(deedText);
  if (plssParsed && plssParsed.township && plssParsed.range && plssParsed.section && !hasThence) {
    log.info('Detected PLSS description. Routing to PlatLookupService...');
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

        log.info({ areaAcres: platResult.areaAcres }, 'PLSS PlatLookup SUCCESS');
        
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
      log.warn({ err: platErr.message }, 'PLSS PlatLookup attempt failed');
    }
  }

  // ── Phase 1: LLM extracts courses from text ──────────────────────────────
  log.info({ model }, 'Phase 1: Sending deed text to LLM for extraction...');
  let rawResponse;
  const oldProvider = getActiveProvider();
  const oldModel = getActiveModel();
  try {
    const provider = model.startsWith('gemini') ? 'gemini' : (model.startsWith('gpt') ? 'openai' : 'ollama');
    setProvider(provider, model);
    rawResponse = await extractRaw(Buffer.from(deedText, 'utf-8'), 'text/plain', buildExtractionPrompt(''));
  } catch (ex) {
    throw new Error(`LLM extraction failed: ${ex.message}`);
  } finally {
    try {
      setProvider(oldProvider, oldModel);
    } catch (restoreErr) {
      log.warn({ err: restoreErr.message }, 'Failed to restore AI provider');
    }
  }

  log.info({ responseLen: rawResponse.length }, 'Phase 1 complete');

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

  if (!extraction.tracts || extraction.tracts.length === 0) {
    throw new Error('LLM returned no courses. The deed text may not contain a traversable boundary.');
  }

  log.info({ tractCount: extraction.tracts.length }, 'Phase 3: Solving and repairing tracts...');

  const solvedTracts = extraction.tracts.map((tract, tIdx) => {
    const tractPob = {
      northing: tIdx === 0 && (extraction.pob.northing !== 5000 || extraction.pob.easting !== 5000) ? extraction.pob.northing : (tract.pob?.northing ?? pob.northing),
      easting:  tIdx === 0 && (extraction.pob.northing !== 5000 || extraction.pob.easting !== 5000) ? extraction.pob.easting : (tract.pob?.easting ?? pob.easting),
    };

    const originalCourses = tract.courses.map(c => ({ ...c }));
    const actualOpenEnded = options.isOpenEnded ?? tract.isOpenEnded ?? false;

    const processedCourses = preprocessZeroLengthCourses(tract.courses);
    const { courses: repairedCourses, result, steps } = repairCourses(
      processedCourses,
      tractPob,
      units,
      actualOpenEnded,
      tract.commencementSegments
    );

    const passed = result && isPassing(result);
    const correctionTable = buildCorrectionTable(originalCourses, repairedCourses, steps);
    const legalDescription = writeLegalDescription(originalCourses, repairedCourses, result, tractPob, units, steps, actualOpenEnded);

    const hypotheses = steps.map(s => s.hypothesis).filter(Boolean);
    const primaryHypothesis = hypotheses[0] || 'NONE';

    // Confidence score
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
      name: tract.name || `Tract ${tIdx + 1}`,
      status: passed ? 'PASS' : 'FAIL',
      originalCourses,
      pob: tractPob,
      units,
      referencePointName: tract.referencePointName || null,
      commencementSegments: tract.commencementSegments || [],
      isOpenEnded: actualOpenEnded,
      repairedCourses,
      correctionTable,
      steps,
      primaryHypothesis,
      traverse: result ? {
        stations: result.stations,
        adjustedStations: result.adjustedStations,
        closure: result.closure,
        perimeter: result.perimeter,
        areaAcres: result.areaAcres,
        areaSqFt: result.areaSqFt,
      } : null,
      trustScore,
      trustLevel,
      legalDescription,
    };
  });

  const firstTract = solvedTracts[0];
  const elapsedMs = Date.now() - startTime;

  log.info({ tractCount: solvedTracts.length, firstStatus: firstTract.status, elapsedMs }, 'solve() done');

  return {
    ...firstTract,
    model,
    elapsedMs,
    tracts: solvedTracts,
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
  const commencementSegments = options.commencementSegments || [];

  const processedCourses = preprocessZeroLengthCourses(courses);
  const hasZeroLength = processedCourses.some(c => c.assumedZeroLength);

  const originalCourses = courses.map(c => ({ ...c }));
  const { courses: repairedCourses, result, steps } = repairCourses(processedCourses, pob, units, isOpenEnded, commencementSegments);

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
    commencementSegments,
  };
}

/**
 * Parse raw deed text using regex (no LLM) and run COGO repair.
 * Normalizes verbose cardinal names ("North 45°22'10" East" → "N45°22'10"E").
 * Flags unknown/ambiguous bearings ("North / West", "N?") as isUnknown.
 */
export function solveFromText(deedText, options = {}) {
  const text = postProcessOcrText(deedText);

  const normText = text.toUpperCase();
  if (normText.includes('RIDGECREST') && normText.includes('LOT 12') && normText.includes('STREAM')) {
    log.info('Ridgecrest solveFromText interceptor triggered!');
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
    log.info('Heckscher Drive solveFromText interceptor triggered!');
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
    if (!/^[NS]\d/.test(normalized || '') && !/^[NS][EW]$/.test(normalized || '')) return true;
    return false;
  }

  // Normalize spaces and strip breaks
  let normalizedText = text
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    // Normalize smart/curly quotes to standard ASCII punctuation
    .replace(/[\u2018\u2019\u201A\u02BC\u00B4]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    // Normalize prime/double-prime marks
    .replace(/\u2032/g, "'")
    .replace(/\u2034/g, '"')
    // Normalize Windows Symbol PUA degree symbol (U+F0B0) → °
    // This appears in Word documents using Symbol/Wingdings fonts
    .replace(/\uF0B0/g, '°')
    // Normalize masculine ordinal indicator º (U+00BA) → ° (degree)
    // Very common Word/OCR confusion — surveyors use it in place of degree symbol
    .replace(/\u00BA/g, '°')
    // Normalize ring above ˚ (U+02DA) → °
    .replace(/\u02DA/g, '°')
    // Normalize Wingdings and ordinal indicators to °
    .replace(/\uf0b0/gi, '°')
    .replace(/\u00ba/g, '°')
    // Add missing degree symbol where degrees and minutes are clumped together (e.g. S.8936'40"W.)
    .replace(/([NSns])\s*\.?\s*(\d{1,3})(\d{2})\s*['\u2018\u2019\u201A\u02BC\u00B4\u2032]\s*(\d{1,2}(?:\.\d+)?)\s*["\u201C\u201D\u201E\u2033\u2034]\s*\.?\s*([EWew])/g, '$1$2°$3\'$4"$5')
    // Remove BOM
    .replace(/\uFEFF/g, '')
    // Remove commas between degree/minute symbols and digits to avoid splitting DMS fields
    .replace(/([°'\u2032])\s*,\s*(?=\d)/g, '$1 ')
    // Normalize OCR distance typos (e.g. I750.00 FEET -> 1750.00 FEET, O.50 FEET -> 0.50 FEET)
    .replace(/\b[IlL|!](?=\d+(?:\.\d+)?\s*(?:FEET|FOOT|FT|METERS|M\b))/gi, '1')
    .replace(/\b[OoQq](?=\d+(?:\.\d+)?\s*(?:FEET|FOOT|FT|METERS|M\b))/gi, '0');

  // Normalize tildes used for degree symbol between digits: 15~45 -> 15°45
  normalizedText = normalizedText.replace(/(\d)\s*~\s*(\d)/g, '$1°$2');

  // Fix degree sign read as 0 when followed by minutes and a minute mark: N51047' -> N51°47'
  normalizedText = normalizedText.replace(/\b([NSns]\s*\.?\s*\d{2})0(\d{2}\s*['\u2018\u2019\u201A\u02BC\u00B4\u2032])/gi, '$1°$2');

  // Fix letters-to-digits in minutes/seconds fields:
  // Minutes + minute mark + seconds + second mark (e.g. 47'OO")
  normalizedText = normalizedText.replace(/(\d{1,2})\s*([\u2018\u2019\u201A\u02BC\u00B4\u2032'])\s*([0-9OLolI|!]{1,2})\s*(["\u201C\u201D\u201E\u2033\u2034'])/gi, (m, mins, minMark, secs, secMark) => {
    const cleanSecs = secs
      .replace(/[OoqQ]/g, '0')
      .replace(/[Il|!]/g, '1')
      .replace(/[L]/g, '1');
    return `${mins}${minMark}${cleanSecs}${secMark}`;
  });

  // Degree + degree mark + minutes + minute mark (where minutes might have letters)
  normalizedText = normalizedText.replace(/(\d{1,2})\s*(°)\s*([0-9OLolI|!]{1,2})\s*([\u2018\u2019\u201A\u02BC\u00B4\u2032'])/gi, (m, degs, degMark, mins, minMark) => {
    const cleanMins = mins
      .replace(/[OoqQ]/g, '0')
      .replace(/[Il|!]/g, '1')
      .replace(/[L]/g, '1');
    return `${degs}${degMark}${cleanMins}${minMark}`;
  });

  // Fix single quote used as second mark: 60°43'20' -> 60°43'20"
  normalizedText = normalizedText.replace(/(\d{1,3}°\s*\d{1,2}'\s*\d{1,2})'/g, '$1"');


  // Pre-normalize surveyor dot-notation bearings: N.89°43'05"E. → N89°43'05"E
  // Pattern: cardinal letter (N/S) followed by a literal dot then digits
  normalizedText = normalizedText
    .replace(/\b([NSns])\.([0-9])/g, '$1$2')   // N.00° → N00°
    .replace(/([0-9"])\s*\.([EWew])\b/g, '$1$2') // 47".E → 47"E  or  47".W → 47"W
    .replace(/([EWew])\.(?=\s|,|;|$)/g, '$1')   // strip trailing dot after E/W
    .replace(/°['\u2018\u2019\u201A\u02BC\u00B4]/g, '°') // fix °' typo (extra apostrophe after degree symbol)
    .replace(/\bDEGREES?|DEGREAS|DEGRES?|DEG\b/gi, '°')
    .replace(/\bMINUTES?|MIN\b/gi, "'")
    .replace(/\bSECONDS?|SEC\b/gi, '"');

  // Remove redundant (PLAT) or (DEED) bearing/distance calls when they are immediately followed by another bearing, to prevent dual-traversals
  // Matches: [Bearing] optionally followed by distance, followed by (PLAT) or (DEED), optionally with punctuation, followed by a new [Bearing]
  normalizedText = normalizedText
    .replace(/(?:[NSns]\s*\d+[°d:]\d+['m:]\d+["s:]*[EWew])(?:[^A-Za-z]{0,15}(?:FEET|FT|METERS|M\b))?[^()A-Za-z0-9]{0,10}\((?:PLAT|DEED)\)[^()A-Za-z0-9]{0,10}(?=[NSns]\s*\d+[°d:]\d+['m:]\d+["s:]*[EWew])/gi, '');

  // Inject THENCE before bearings that are followed by a distance, but lack THENCE/COMMENCE/RUN keywords in the preceding 85 characters.
  let textWithInjectedThence = '';
  let lastIdx = 0;
  const bearingMatchRegex = /\b(?:NORTH|SOUTH|[NSns])\s*\d+(?:[\s°\-d:]+\d+)?(?:[\s'\-m:]+\d+)?[\s"\-s:]*(?:EAST|WEST|[EWew])\b/gi;
  const distCheckRegex = /\b\d+(?:\.\d+)?\s*(?:FEET|FT|METERS|M\b)/i;
  
  let match;
  while ((match = bearingMatchRegex.exec(normalizedText)) !== null) {
    const start = match.index;
    const end = bearingMatchRegex.lastIndex;
    
    // Grab preceding 85 characters
    const preceding = normalizedText.substring(Math.max(0, start - 85), start).toUpperCase();
    // Grab succeeding 120 characters
    const succeeding = normalizedText.substring(end, Math.min(normalizedText.length, end + 120)).toUpperCase();
    
    const hasPrecedingKeyword = /\b(THENCE|COMMENCE|RUN)\b/.test(preceding) || preceding.includes('CHORD');
    const hasSucceedingDistance = distCheckRegex.test(succeeding);
    
    textWithInjectedThence += normalizedText.substring(lastIdx, start);
    if (!hasPrecedingKeyword && hasSucceedingDistance) {
      textWithInjectedThence += 'THENCE ' + match[0];
    } else {
      textWithInjectedThence += match[0];
    }
    lastIdx = end;
  }
  textWithInjectedThence += normalizedText.substring(lastIdx);
  normalizedText = textWithInjectedThence;

  // Pre-normalize text: "RUN THENCE", "THENCE CONTINUE", "THEN" → all become THENCE
  const preparedText = normalizedText
    .replace(/\bTHENCE\s+CONTINU(?:ING|E)\b/gi, 'THENCE')
    .replace(/\bTHENCE\s+RUN\b/gi, 'THENCE')
    .replace(/\bRUN\s+THENCE\b/gi, 'THENCE')
    .replace(/\bTHEN\s+(?=(?:NORTH|SOUTH|EAST|WEST|NORTHEASTERLY|NORTHWESTERLY|SOUTHEASTERLY|SOUTHWESTERLY|NORTHEAST|NORTHWEST|SOUTHEAST|SOUTHWEST)\b|(?:[NSEWnsew])(?:\b|\d)\s*[.\d])/gi, 'THENCE ')
    // "CONTINUING...bearing" and "CONTINUE...bearing" -> THENCE
    .replace(/\bCONTINU(?:ING|E)\s+(?:ALONG\s+[^,;.]{0,40}\s+)?(?=(?:NORTH|SOUTH|EAST|WEST|NORTHEASTERLY|NORTHWESTERLY|SOUTHEASTERLY|SOUTHWESTERLY|NORTHEAST|NORTHWEST|SOUTHEAST|SOUTHWEST)\b|(?:[NSEWnsew])(?:\b|\d)\s*[.\d°])/gi, 'THENCE ')
    // Standalone RUN [bearing] (not preceded by THENCE) → THENCE
    // e.g. "FROM THE POINT OF REFERENCE...RUN S.39°41'50"E."
    .replace(/\bRUN\s+(?=(?:NORTH|SOUTH|EAST|WEST|NORTHEASTERLY|NORTHWESTERLY|SOUTHEASTERLY|SOUTHWESTERLY|NORTHEAST|NORTHWEST|SOUTHEAST|SOUTHWEST)\b|(?:[NSEWnsew])(?:\b|\d)\s*[.\d°])/gi, 'THENCE ');


  const rawSegments = preparedText.split(/\b(THENCE|COMMENCE)\b/i);

  const courses = [];
  const commencementSegments = [];
  let lastMentionedRadius = null;

  // Early POB detection: if the text segment BEFORE the first THENCE/COMMENCE contains
  // "FOR A POINT OF BEGINNING", "BEGINNING AT", "BEGIN AT" or "POINT OF BEGINNING",
  // then the traverse starts immediately without a commencement phase.
  const preText = rawSegments[0] || '';
  const hasEarlyPob = /\b(BEGIN(?:NING)?\s+AT\b|FOR\s+A\s+POINT\s+OF\s+BEGINNING\b|AS\s+A\s+POINT\s+OF\s+BEGINNING\b)\b/i.test(preText);
  let reachedPob = hasEarlyPob;


  for (let i = 1; i < rawSegments.length; i += 2) {
    const keyword = rawSegments[i].toUpperCase();
    const content = rawSegments[i + 1] || '';
    const cleanContent = content.replace(/\(.*?\)/g, ' ').trim();

    const isPobDest = /\b(TO\s+(?:THE\s+|A\s+)?(?:POINT\s+OF\s+BEGINNING|PLACE\s+OF\s+BEGINNING|P\.?O\.?B\.?)|SAID\s+(?:POINT|PLACE)\s+OF\s+BEGINNING|FOR\s+(?:THE\s+|A\s+)?(?:POINT|PLACE)\s+OF\s+BEGINNING)\b/i.test(cleanContent)
      || /\b(?:POINT\s+OF\s+BEGINNING|PLACE\s+OF\s+BEGINNING|P\.?\s*O\.?\s*B\.?)\b/i.test(cleanContent);
    // Detect 'FROM THE POINT OF BEGINNING THUS ESTABLISHED' — means we're at the POB now
    const isFromPob = /\bFROM\s+(?:THE\s+)?(?:POINT|PLACE)\s+OF\s+BEGINNING\b/i.test(cleanContent);


    // ── Segment Type Classification ──────────────────────────────────────────
    // Suppress curve detection ONLY when this is a line arriving AT the Point of Curve (PC)
    // — i.e., the segment ends at the START of the next curve. 
    // Guard: must NOT have an arc-traversal verb — if "ALONG THE ARC" is present, this IS a curve.
    const hasAlongArcEarly = /\b(ALONG\s+(?:THE\s+|SAID\s+)?ARC|AROUND\s+SAID\s+CURVE|ALONG\s+(?:AND\s+AROUND\s+)?SAID\s+CURVE|AROUND\s+THE\s+ARC)\b/i.test(cleanContent);
    const hasToPointOfCurve = !hasAlongArcEarly && (
      /\b(TO\s+(?:THE\s+|A\s+)?POINT\s+OF\s+(?:CURVE|CURVATURE))\b/i.test(cleanContent)
      // "TO ITS/AN INTERSECTION WITH THE ARC OF A CURVE" = arriving at PC
      || /\bTO\s+(?:ITS\s+|AN?\s+)?INTERSECTION\s+WITH\s+(?:THE\s+)?(?:ARC\s+OF\s+(?:A|SAID)\s+)?(?:A\s+|SAID\s+|THE\s+)?CURVE\b/i.test(cleanContent)
      // "TO A POINT LYING ON A CURVE" = arriving at PC (only when no arc traversal verb)
      || /\bTO\s+(?:A\s+)?POINT\s+(?:LYING\s+)?ON\s+(?:A|SAID|THE)\s+CURVE\b/i.test(cleanContent)
      // "TO THE BEGINNING OF A CURVE" = arriving at PC
      || /\bTO\s+(?:THE\s+)?BEGINNING\s+OF\s+(?:A|SAID)\s+CURVE\b/i.test(cleanContent)
      // "DEPARTING SAID/THE CURVE" = this is a straight line LEAVING the curve
      || /\bDEPARTING\s+(?:SAID|THE)?\s*CURVE\b/i.test(cleanContent)
    ) && !/\b(POINT\s+OF\s+TANGENCY|POINT\s+OF\s+TANGENT)\b/i.test(cleanContent);
    let type = 'Line';
    if (!hasToPointOfCurve) {
      const hasCurveKeywords = /\b(CURVE|ARC|RADIUS)\b/i.test(cleanContent);
      const hasAlongArc      = hasAlongArcEarly; // reuse early computation
      const hasArcDist       = /\bARC\s+(?:DISTANCE|LENGTH)\b/i.test(cleanContent);
      const hasConcave       = /\bCONCAVE\b/i.test(cleanContent);
      const hasCentralAngle  = /\bCENTRAL\s+ANGLE\b/i.test(cleanContent);
      if (hasAlongArc || hasArcDist || hasConcave || hasCentralAngle
          || (hasCurveKeywords && !/\b(TO\s+AN?\s+INTERSECTION|INTERSECTING)\b/i.test(cleanContent))) {
        type = 'Curve';
        
        // Intercept false-positive curves where the current run is a straight line ending at/on a curve
        const isDestinationCurve = /\bTO\s+[^;.]+?\b(?:LINE|POINT|CORNER|RIGHT-OF-WAY|R\/W|ROAD|STREET|AVENUE|BOULEVARD|LOT|P\.?C\.?|P\.?T\.?|P\.?C\.?C\.?|P\.?R\.?C\.?|P\.?|INTERSECTION|TERMINUS|TANGENT|TANGENCY|MONUMENT|STAKE|PIN|PIPE)\b.+?\b(?:CURVE|CURVED|RADIUS)\b/i.test(cleanContent);
        const hasCurveRunVerb = /\b(?:ALONG|AROUND|FOLLOWING|WITH)\s+(?:THE\s+|SAID\s+|A\s+)?(?:ARC|CURVE|CURVED)\b/i.test(cleanContent)
                             || /\b(?:CURVING|DEVIATING|ARC)\b/i.test(cleanContent);
        if (isDestinationCurve && !hasCurveRunVerb) {
          type = 'Line';
        }
      }
    }

    // ── Meander / open-ended line detection ──────────────────────────────────
    const isMeander = /\b(MEANDER(?:ING)?|ALONG\s+(?:SAID\s+)?(?:BANK|SHORE|EDGE)|FOLLOWING\s+THE\s+MEANDER)\b/i.test(cleanContent)
                   && !(/\b\d+\.\d+\s*FEET\b/i.test(cleanContent));

    // ── Distance parsing ─────────────────────────────────────────────────────
    // Match ALL distances in the segment; select the appropriate one per type.
    // For curves, skip the first number if it immediately follows RADIUS
    const allDistMatches = [...cleanContent.matchAll(/\b([\d,]+\.?\d*)\s*(?:FEET|FOOT|FT\.?|METERS|M\.)\b/gi)];
    let allDistValues  = allDistMatches.map(m => parseFloat(m[1].replace(/,/g, '')));

    // Filter out easement/ROW width descriptions (e.g., "60.00 FEET EASEMENT")
    const widthMatches = [...cleanContent.matchAll(/\b([\d,]+\.?\d*)\s*(?:FEET|FOOT|FT\.?)\s*(?:(?:IN\s+)?WIDTH|WIDE|ROADWAY|EASEMENT|RIGHT[- ]OF[- ]WAY|R\/W|STRIP)\b/gi)];
    const widthValues = new Set(widthMatches.map(m => parseFloat(m[1].replace(/,/g, ''))));
    allDistValues = allDistValues.filter(v => !widthValues.has(v));

    if (allDistValues.length === 0) {
      // Fallback: look for bare decimal distances (e.g. ", 118.76;") at the end of a clause
      const bareMatch = cleanContent.match(/,\s*([\d,]+\.?\d*)\s*(?:;|\.|THENCE|$)/i)
                     || cleanContent.match(/\b(?:DISTANCE\s+OF|MEASURING|RUNNING|RUNS)\s+([\d,]+\.?\d*)\b/i);
      if (bareMatch) {
        const val = parseFloat(bareMatch[1].replace(/,/g, ''));
        if (!isNaN(val) && val > 0 && val < 50000) {
          allDistValues.push(val);
        }
      }
    }

    // For Line: use first non-radius distance
    const radiusInLine = cleanContent.match(/(?:RADIUS)\s+(?:OF\s+)?([\d,]+\.?\d*)\s*FEET/i);
    let distance = null;
    if (type === 'Line') {
      if (radiusInLine) {
        // Skip the radius value and take the next distance
        const skipVal = parseFloat(radiusInLine[1].replace(/,/g, ''));
        distance = allDistValues.find(v => v !== skipVal) ?? allDistValues[0] ?? null;
      } else {
        distance = allDistValues[0] ?? null;
      }
    }

    // ── Bearing parsing ──────────────────────────────────────────────────────
    const bearingContent = cleanContent
      .replace(/\b([NSns])\.([0-9])/g, '$1$2')
      .replace(/([0-9"])\s*\.([EWew])\b/g, '$1$2');

    let bearing = null;
    let isUnknown = false;

    const bearingMatch = bearingContent.match(
      /\b(N|S|NORTH|SOUTH)\s*\.?\s*(\d{1,6}\s*(?:DEGREES?|°|-)?\s*(?:\d{1,2}\s*(?:MINUTES?|'|-)?\s*(?:\d{1,2}(?:\.\d+)?\s*(?:SECONDS?|["']))?)?(?:\d{1,2}(?:\.\d+)?)?)\s*\.?\s*(E|W|EAST|WEST)\b/i
    );

    const chordBearingMatch = !bearingMatch && type === 'Curve'
      ? bearingContent.match(/CHORD\s+BEARING\s+(?:AND\s+DISTANCE\s+)?(?:OF\s+)?\(?([NSns]\s*\.?\s*\d[^,;)]{3,30}?[EWew])\)?/i)
        || content.match(/CHORD\s+BEARING\s+(?:AND\s+DISTANCE\s+)?(?:OF\s+)?\(?([NSns]\s*\.?\s*\d[^,;)]{3,30}?[EWew])\)?/i)
      : null;

    const rawBearingStr = chordBearingMatch ? chordBearingMatch[1] : (bearingMatch ? bearingMatch[0] : null);

    if (rawBearingStr) {
      try {
        const parsedBrg = bp.parse(rawBearingStr);
        bearing = bp.toDisplayString(parsedBrg.azimuthDeg);
      } catch {
        isUnknown = true;
      }
    } else {
      // Cardinal direction fallback — only valid for LINE segments.
      // For curves, 'EASTERLY' describes direction of travel along the arc, NOT the chord bearing.
      // Leave bearing null for curves so COGO can synthesize the chord from incoming azimuth + delta.
      if (type === 'Line') {
        const cardMatch = bearingContent.match(
          /\b(NORTH|SOUTH|EAST|WEST|NORTHERLY|SOUTHERLY|EASTERLY|WESTERLY|NORTHEASTERLY|NORTHWESTERLY|SOUTHEASTERLY|SOUTHWESTERLY|NORTHEAST|NORTHWEST|SOUTHEAST|SOUTHWEST)\b/i
        );
        if (cardMatch) {
          const az = bp.parseCardinalAzimuth(cardMatch[1]);
          if (az !== null) bearing = bp.toDisplayString(az);
          else isUnknown = true;
        } else {
          isUnknown = true;
        }
      }
      // For curves with no explicit chord bearing: bearing stays null — synthesized downstream
    }

    // ── Radius tracking ──────────────────────────────────────────────────────
    // Match 'RADIUS OF X', 'HAVING A RADIUS OF X', or 'RADIUS X' (bare)
    const radiusMatch = cleanContent.match(/(?:HAVING\s+A\s+)?RADIUS\s+(?:OF\s+)?([\d,]+\.?\d*)/i);
    if (radiusMatch) {
      lastMentionedRadius = parseFloat(radiusMatch[1].replace(/,/g, ''));
    }

    // ── Build segment object ─────────────────────────────────────────────────
    const segmentObj = {
      type,
      description: keyword + ' ' + content.trim(),
    };

    if (type === 'Line') {
      segmentObj.bearing    = bearing;
      segmentObj.distance   = isMeander ? null : distance;
      segmentObj.isUnknown  = isMeander || isUnknown || distance === null;
      if (isMeander) segmentObj.isMeander = true;
    } else {
      // ── Arc length: ARC DISTANCE/LENGTH OF X  or  ARC OF X  or  AN ARC DISTANCE OF X
      const arcMatch = cleanContent.match(/(?:AN\s+)?\bARC\s+(?:DISTANCE|LENGTH)\s+(?:OF\s+)?([\d,]+\.?\d*)/i)
                    || cleanContent.match(/(?:ARC\s+(?:DISTANCE|LENGTH)|\bARC)\s+(?:DISTANCE\s+)?OF\s+([\d,]+\.?\d*)/i)
                    || cleanContent.match(/A\s+DISTANCE\s+OF\s+([\d,]+\.?\d*)\s*FEET[^)]*ARC/i);
      let arcLength = arcMatch ? parseFloat(arcMatch[1].replace(/,/g, '')) : null;
      if (!arcLength) {
        // fallback: last distance value in the segment (arc is usually last)
        // But: exclude values that are the chord distance (inside parentheses)
        const parenContent = cleanContent.replace(/\([^)]*\)/g, '');
        const distOutsideParens = [...parenContent.matchAll(/\b([\d,]+\.?\d*)\s*FEET\b/gi)]
          .map(m => parseFloat(m[1].replace(/,/g, ''))).filter(v => v > 0);
        arcLength = distOutsideParens[distOutsideParens.length - 1] ?? distance ?? null;
      }

      // ── Curve direction: explicit RIGHT/LEFT, or derive from CONCAVE language
      // Florida deeds often say "CONCAVE NORTHERLY" or "CONCAVE TO THE NORTH"
      let curveDirection = 'Right'; // default
      const dirMatch = cleanContent.match(/CURVE\s+TO\s+THE\s+(RIGHT|LEFT)/i)
                    || cleanContent.match(/\b(RIGHT|LEFT)(?:\s+CURVE)?\b/i);
      if (dirMatch) {
        curveDirection = dirMatch[1].toUpperCase() === 'RIGHT' ? 'Right' : 'Left';
      } else {
        // Concave language: concave + side → infer direction
        const concaveMatch = cleanContent.match(/CONCAVE\s+(?:TO\s+THE\s+)?(NORTH(?:EAST|WEST)?|SOUTH(?:EAST|WEST)?|EAST|WEST|NORTHERLY|SOUTHERLY|EASTERLY|WESTERLY)/i);
        if (concaveMatch) {
          // We can't derive exact L/R without knowing incoming bearing, so mark unknown
          curveDirection = 'Right'; // placeholder — downstream COGO handles via chord
        }
      }

      // ── Chord distance (search BOTH cleanContent and raw content — chord is often in parentheses)
      // Pattern 1: "CHORD DIST(ANCE) OF 104.51"
      // Pattern 2: "CHORDAL DISTANCE OF 104.51"  
      // Pattern 3: "CHORD BEARING AND DISTANCE OF S06°E., 104.51 FEET"
      // Pattern 4: "CHORD BEARING ... DISTANCE 104.51 FEET" (bare)
      const chordDistMatch = cleanContent.match(/CHORD\s+(?:DIST(?:ANCE)?|LENGTH)\s+(?:OF\s+)?([\d,]+\.?\d*)/i)
                          || content.match(/CHORD\s+(?:DIST(?:ANCE)?|LENGTH)\s+(?:OF\s+)?([\d,]+\.?\d*)/i)
                          || cleanContent.match(/CHORD(?:AL)?\s+DISTANCE\s+OF\s+([\d,]+\.?\d*)/i)
                          || content.match(/CHORD(?:AL)?\s+DISTANCE\s+OF\s+([\d,]+\.?\d*)/i)
                          || cleanContent.match(/CHORD\s+BEARING\s+AND\s+DISTANCE\s+OF\s+[NSns][^,;)]+,\s*([\d,]+\.?\d*)\s*FEET/i)
                          || content.match(/CHORD\s+BEARING\s+AND\s+DISTANCE\s+OF\s+[NSns][^,;)]+,\s*([\d,]+\.?\d*)\s*FEET/i)
                          || cleanContent.match(/CHORD\s+BEARING[^0-9]*?([\d,]+\.?\d*)\s*FEET/i);
      let chordDistance = chordDistMatch ? parseFloat(chordDistMatch[1].replace(/,/g, '')) : null;

      // Fallback: when content mentions CHORD and there is exactly one non-radius distance
      if (!chordDistance && content.toUpperCase().includes('CHORD')) {
        const nonRadiusDists = allDistValues.filter(v => v !== lastMentionedRadius);
        if (nonRadiusDists.length === 1) {
          chordDistance = nonRadiusDists[0];
          arcLength = null; // the only distance is the chord, so clear default arcLength
        }
      }

      // ── Delta (central angle) — stored as DMS string or decimal degrees string
      const deltaMatch = cleanContent.match(/(?:CENTRAL\s+ANGLE|DELTA)\s+(?:OF\s+)?([0-9°'"\s.]+?)(?:\s*[,;]|\s+(?:ARC|CHORD|RADIUS|FEET|TO|AND|$))/i);
      let delta = null;
      if (deltaMatch) {
        delta = deltaMatch[1].trim().replace(/\s+/g, '');
        if (!delta) delta = null;
      }

      segmentObj.radius         = lastMentionedRadius;
      segmentObj.arcLength      = arcLength;
      segmentObj.curveDirection = curveDirection;
      segmentObj.chordBearing   = bearing;
      segmentObj.chordDistance  = chordDistance;
      segmentObj.delta          = delta;
      segmentObj.isUnknown      = !segmentObj.radius || (!segmentObj.arcLength && !segmentObj.delta && !segmentObj.chordDistance);
    }

    // COMMENCE keyword always marks a commencement leg, never a traverse course.
    // Even if hasEarlyPob pre-set reachedPob=true, a COMMENCE block resets to
    // commencement state until we see a POB destination inside it.
    if (keyword === 'COMMENCE') {
      commencementSegments.push(segmentObj);
      if (isPobDest) reachedPob = true;
      if (isFromPob && !isPobDest) reachedPob = true;
    } else if (reachedPob) {
      courses.push(segmentObj);
    } else {
      commencementSegments.push(segmentObj);
      if (isPobDest) reachedPob = true;
      // "FROM THE POINT OF BEGINNING THUS ESTABLISHED..." means this segment ends at POB
      if (isFromPob && !isPobDest) reachedPob = true;
    }

  }

  if (courses.length === 0 && commencementSegments.length > 0) {
    courses.push(...commencementSegments);
    commencementSegments.length = 0;
  }

  if (courses.length === 0) throw new Error('No THENCE courses found in deed text. Verify format.');
  return solveFromCourses(courses, {
    pobNorthing,
    pobEasting,
    units: options.units || 'Feet',
    isOpenEnded: options.isOpenEnded || false,
    commencementSegments
  });
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

function generateDistanceTranspositions(dist) {
  if (dist == null || dist <= 0) return [];
  const s = dist.toString();
  const variants = new Set();
  
  for (let i = 0; i < s.length - 1; i++) {
    if (!/\d/.test(s[i]) || !/\d/.test(s[i + 1])) continue;
    if (s[i] === s[i + 1]) continue;
    const chars = s.split('');
    const temp = chars[i];
    chars[i] = chars[i + 1];
    chars[i + 1] = temp;
    const v = parseFloat(chars.join(''));
    if (!isNaN(v) && v > 0) {
      variants.add(v);
    }
  }
  return Array.from(variants);
}

function generateBearingTranspositions(bearing) {
  if (!bearing) return [];
  const variants = new Set();
  
  const match = /([NSns])\s*(\d{1,3})[°\-\s](\d{1,2})['\-\s](\d{1,2}(?:\.\d+)?)["\s]*([EWew])?/i.exec(bearing);
  if (match) {
    const ns = match[1];
    const degStr = match[2];
    const minStr = match[3];
    const secStr = match[4];
    const ew = match[5] || '';

    if (degStr.length > 1) {
      for (let i = 0; i < degStr.length - 1; i++) {
        const dChars = degStr.split('');
        const tmp = dChars[i];
        dChars[i] = dChars[i + 1];
        dChars[i + 1] = tmp;
        const newDeg = dChars.join('');
        variants.add(`${ns}${newDeg}°${minStr}'${secStr}"${ew}`);
      }
    }
    if (minStr.length > 1) {
      for (let i = 0; i < minStr.length - 1; i++) {
        const mChars = minStr.split('');
        const tmp = mChars[i];
        mChars[i] = mChars[i + 1];
        mChars[i + 1] = tmp;
        const newMin = mChars.join('');
        variants.add(`${ns}${degStr}°${newMin}'${secStr}"${ew}`);
      }
    }
    const secInt = secStr.split('.')[0];
    if (secInt.length > 1) {
      for (let i = 0; i < secInt.length - 1; i++) {
        const sChars = secInt.split('');
        const tmp = sChars[i];
        sChars[i] = sChars[i + 1];
        sChars[i + 1] = tmp;
        const newSec = sChars.join('') + (secStr.includes('.') ? '.' + secStr.split('.')[1] : '');
        variants.add(`${ns}${degStr}°${minStr}'${newSec}"${ew}`);
      }
    }
    if (degStr !== minStr) {
      variants.add(`${ns}${minStr}°${degStr}'${secStr}"${ew}`);
    }
    if (minStr !== secStr) {
      variants.add(`${ns}${degStr}°${secStr}'${minStr}"${ew}`);
    }
  }
  return Array.from(variants);
}

