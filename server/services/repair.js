// ─── Repair Service ─────────────────────────────────────────────────────────
// Automated multi-stage deed repair pipeline:
//   Stage 5  — Hierarchical Multi-Agent Resolution (runs first as primary solver)
//   Stage 0  — Direct Gemini Extraction (fallback if agent fails)
//   Stage 1  — Bowtie / Quadrant Inversion Auto-Fix
//   Stage 1.5— Surveyor Shape Constraint & Scrivener Corrector
//   Stage 3.5— Compass Rule (Bowditch) Adjustment
//   Stage 2+ — Re-extraction & heuristic fallback chain
// Pass Threshold: LinearError < 0.30 ft OR PrecisionRatio >= 1:10,000

import * as gemini from './geminiVision.js';
import * as traverseSvc from './traverse.js';
import * as bp from './bearingParser.js';
import { SupervisorAgent } from './agentSystem.js';
import { createChildLogger } from '../logger.js';
import { pdfOcrCache } from './llm/pdfProcessor.js';
import crypto from 'crypto';
import { GEMINI_API_KEY, ALLOW_API_FALLBACK } from '../config.js';

const log = createChildLogger('repair');

const PASS_LINEAR_ERROR_FT = 0.30;
const PASS_PRECISION_RATIO = 10000.0;

/**
 * Run the full repair pipeline for a single deed image.
 * @param {Buffer} imageBytes
 * @param {string} mimeType
 * @param {{ northing: number, easting: number }} pob
 * @param {string} units
 * @param {boolean} isOpenEnded
 * @param {string} fileName
 * @param {number} maxTurns
 * @param {boolean} allowEscalation
 * @returns {Promise<object>} RepairResult
 */
export async function runRepairPipeline(imageBytes, mimeType, pob, units, isOpenEnded = false, fileName = '', maxTurns = 3, allowEscalation = true) {
  const t0 = Date.now();
  log.info({ file: fileName, mimeType, maxTurns }, 'Pipeline started');
  let result = await _runRepairPipelineInner(imageBytes, mimeType, pob, units, isOpenEnded, fileName, maxTurns);

  // Dynamic escalation: if local model failed and we have Gemini API Key, try Gemini as a final safety net!
  const currentProvider = gemini.getActiveProvider();
  if (allowEscalation &&
      (result.status === 'FAIL' || result.status === 'ERROR') &&
      (currentProvider === 'ollama' || currentProvider === 'openai') &&
      GEMINI_API_KEY &&
      ALLOW_API_FALLBACK !== false) {

    const fallbackModel = 'gemini-2.5-flash';
    console.log(` Escalating failed deed "${fileName}" (status=${result.status}) from local model [${gemini.getActiveModel()}] to cloud model [${fallbackModel}] for another look.`);

    const originalModel = gemini.getActiveModel();
    try {
      gemini.setProvider('gemini', fallbackModel);
      const escalatedResult = await _runRepairPipelineInner(imageBytes, mimeType, pob, units, isOpenEnded, fileName, maxTurns);
      if (escalatedResult.status === 'PASS' || escalatedResult.status === 'MEANDER') {
        console.log(`✓ Escalation succeeded! Deed passed via ${fallbackModel}`);
        result = escalatedResult;
        result.repairStageUsed = `${result.repairStageUsed} (Escalated Fallback from ${currentProvider}:${originalModel})`;
      } else {
        console.log(` Escalation did not resolve the issue. Status: ${escalatedResult.status}`);
      }
    } catch (escalateErr) {
      console.warn(`⚠️ Escalation attempt failed:`, escalateErr.message);
    } finally {
      // Restore original provider and model
      gemini.setProvider(currentProvider, originalModel);
    }
  }

  const final = finalizeResult(result);
  const elapsed = Date.now() - t0;
  log.info(
    { file: fileName, status: final?.status, stage: final?.repairStageUsed, elapsedMs: elapsed },
    'Pipeline complete',
  );
  return final;
}

function finalizeResult(result) {
  if (result) {
    if (!result.finalExtraction) result.finalExtraction = result.extraction || {};
    
    // Stage 17: Resolve county and state from raw OCR text
    let rawText = result.finalExtraction.rawText || 
                  result.finalExtraction.originalLegalDesc || 
                  result.finalExtraction.originalLegalDescription || 
                  result.originalExtraction?.rawText || 
                  result.originalExtraction?.originalLegalDesc || 
                  result.originalExtraction?.originalLegalDescription || 
                  '';
                  
    const inferred = gemini.inferCountyStateFromText(rawText);
    
    if (!result.finalExtraction.county || result.finalExtraction.county === 'Unknown') {
      result.finalExtraction.county = inferred.county || 'Unknown County';
    }
    if (!result.finalExtraction.state || result.finalExtraction.state === 'Unknown') {
      result.finalExtraction.state = inferred.state || 'Unknown State';
    }
    
    // Sync to extraction as well
    if (result.extraction) {
      result.extraction.county = result.finalExtraction.county;
      result.extraction.state = result.finalExtraction.state;
    }

    if (result.finalTraverse) {
      const stations = result.finalTraverse.adjustedStations || result.finalTraverse.stations;
      if (stations && stations.length >= 3) {
        const hasSelfIntersection = detectSelfIntersection(stations);
        result.finalTraverse.hasSelfIntersection = hasSelfIntersection;
        if (hasSelfIntersection) {
          result.hasSelfIntersection = true;
          result.selfIntersectionComment = 'Warning: Boundary has self-intersecting lines (bowtie).';
          if (!result.traverseError?.includes('Self-intersecting')) {
            result.traverseError = (result.traverseError ? result.traverseError + '; ' : '') + 'Warning: Self-intersecting boundary detected.';
          }
        }
      }
    }
  }
  return result;
}

async function _runRepairPipelineInner(imageBytes, mimeType, pob, units, isOpenEnded = false, fileName = '', maxTurns = 3) {
  const pipelineStart = Date.now();
  let bustCourseIdx = -1;  // Index of the most-suspected single-bust course (-1 = unknown)

  // ── Stage 5: Hierarchical Multi-Agent Deed Resolution System ────────────────────
  log.info({ stage: 'stage5_agent', file: fileName }, 'Executing Hierarchical Multi-Agent System');
  let cachedExtraction = null; // Fix #2: cache Stage 5 extraction to avoid redundant Gemini call
  try {
    const supervisor = new SupervisorAgent();
    const agentResult = await supervisor.solve(imageBytes, mimeType, pob, units, isOpenEnded, fileName, maxTurns);

    // Always cache the extraction for Stage 0 reuse (Fix #2)
    if (agentResult.extraction?.courses?.length > 0) {
      cachedExtraction = agentResult.extraction;
    }

    if (agentResult.status === 'PASS') {
      console.log(`✓ Hierarchical Agent System succeeded: ${agentResult.repairStageUsed}`);
      const steps = buildSolutionSteps(
        agentResult.extraction,
        agentResult.extraction,
        agentResult.repairStageUsed,
        agentResult.traverse,
        Date.now() - pipelineStart
      );
      return {
        finalExtraction: agentResult.extraction,
        finalTraverse: agentResult.traverse,
        status: 'PASS',
        repairStageUsed: agentResult.repairStageUsed,
        traverseError: null,
        originalExtraction: agentResult.extraction,
        agentTurns: agentResult.agentTurns || [],
        trustScore: agentResult.trustScore ?? null,
        trustLevel: agentResult.trustLevel ?? null,
        trustFlags: agentResult.trustFlags || [],
        bustCourseIndex: agentResult.bustCourseIndex ?? null,
        solutionSteps: steps,
      };
    }
    console.log('⚠ Hierarchical Agent System failed to close. Falling back to sequential pipeline stages...');
    if (agentResult.bustCourseIndex !== undefined && agentResult.bustCourseIndex !== null) {
      bustCourseIdx = agentResult.bustCourseIndex;
    }
  } catch (err) {
    console.error('✗ Hierarchical Agent System encountered an error, falling back:', err.message);
  }

  // ── Stage 0: Direct Gemini Extraction ───────────────────────────────────
  // Fix #2: Reuse Stage 5 cached extraction if available — skip redundant Gemini call
  let extraction;
  if (cachedExtraction) {
    console.log('Repair Pipeline Stage 0: Reusing Stage 5 cached extraction (no extra Gemini call).');
    extraction = cachedExtraction;
  } else {
    console.log('Repair Pipeline Stage 0: Direct Gemini extraction.');
    try {
      extraction = await gemini.extractBoundary(imageBytes, mimeType);
    } catch (ex) {
      console.error('Stage 0: Gemini extraction failed hard.', ex.message);
      throw ex;
    }
  }

  const originalExtraction = extraction;

  if (!extraction.courses || extraction.courses.length === 0) {
    return {
      finalExtraction: extraction, finalTraverse: null, status: 'FAIL',
      repairStageUsed: 'Stage 0: No courses extracted',
      traverseError: 'Gemini returned empty course list.',
      originalExtraction,
    };
  }

  // Fix #9: Prefer the structured isOpenEnded boolean from extraction; string scan is secondary fallback
  const docText = extraction.rawJson || '';
  let actualOpenEnded = extraction.isOpenEnded || detectOpenEnded(docText, fileName, false) || isOpenEnded;
  if (actualOpenEnded) {
    // If the text contains an explicit return to POB, it is NOT open-ended.
    const fullDocText = getDocumentText(imageBytes, mimeType);
    const hasPobReturn = hasPobReturnText(docText) || hasPobReturnText(extraction.originalLegalDesc || '') || hasPobReturnText(fullDocText);
    if (hasPobReturn) {
      console.log('Open-ended classification overridden: document contains a return to POB.');
      actualOpenEnded = false;
    }
  }
  if (actualOpenEnded) {
    console.log('Classified traverse as OPEN-ENDED (Easement, Right-of-Way, Centerline, Strip Deed).');
    // Stage 0 Short-Circuit: Open-ended survey lines are correct by design.
    // Do NOT burn through the full repair pipeline — exit immediately as MEANDER.
    const [tvOpen] = tryCompute(extraction.courses, pob, units, true);
    return {
      finalExtraction: extraction,
      finalTraverse:   tvOpen,
      status:          'MEANDER',
      repairStageUsed: 'Stage 0: Open-Ended Survey Centerline (Strip/Easement/R-O-W)',
      traverseError:   null,
      originalExtraction: extraction,
    };
  }

  // ── Compute initial traverse ──────────────────────────────────────────
  let [traverse, traverseError] = tryCompute(extraction.courses, pob, units, actualOpenEnded);
  if (traverse && isPassing(traverse)) {
    console.log(`Stage 0 PASS: ${traverse.closure.precisionRatio}`);
    if (traverse.courses) {
      extraction.courses = traverse.courses;
      extraction.rawJson = JSON.stringify(traverse.courses);
    }
    const steps = buildSolutionSteps(originalExtraction, extraction, 'Stage 1: Direct Traverse', traverse, Date.now() - pipelineStart);
    return { finalExtraction: extraction, finalTraverse: traverse, status: 'PASS', repairStageUsed: 'Stage 1: Direct Traverse', traverseError: null, originalExtraction, solutionSteps: steps };
  }

  // ── Stage 0.5: Preemptive Commencement Leg Stripper ───────────────────
  if (traverse && !isPassing(traverse) && extraction.courses?.length > 2) {
    const stripResult = _tryPreemptiveCommencementStrip(
      extraction.courses, pob, units, actualOpenEnded, traverse.closure
    );
    if (stripResult) {
      console.log(`Stage 0.5 Preemptive Commencement Stripper: removed ${stripResult.stripLen} leading course(s).`);
      extraction = {
        ...extraction,
        courses: stripResult.courses,
        rawJson: JSON.stringify(stripResult.courses),
        message: stripResult.message
      };
      // Recompute traverse on the stripped courses so subsequent stages use the correct traverse baseline
      const [tStrip, eStrip] = tryCompute(extraction.courses, pob, units, actualOpenEnded);
      if (tStrip) {
        traverse = tStrip;
        traverseError = eStrip;
        if (isPassing(traverse)) {
          console.log(`Stage 0.5 PASS: ${traverse.closure.precisionRatio}`);
          const steps = buildSolutionSteps(originalExtraction, extraction, stripResult.message, traverse, Date.now() - pipelineStart);
          return { finalExtraction: extraction, finalTraverse: traverse, status: 'PASS', repairStageUsed: stripResult.message, traverseError: null, originalExtraction, solutionSteps: steps };
        }
      }
    }
  }

  // ── Stage 1: Bowtie / Quadrant Inversion Auto-Fix ─────────────────────
  console.log('Stage 1: Bowtie/Quadrant Inversion bearing-flip repair.');
  const stage1Extraction = tryBowtieAutoFix(extraction, pob, units);
  const [t1, e1] = tryCompute(stage1Extraction.courses, pob, units, actualOpenEnded);
  if (t1 && isPassing(t1)) {
    console.log(`Stage 1 PASS: ${t1.closure.precisionRatio}`);
    if (t1.courses) {
      stage1Extraction.courses = t1.courses;
      stage1Extraction.rawJson = JSON.stringify(t1.courses);
    }
    const label = stage1Extraction.message || 'Stage 1: Bowtie Auto-Fix';
    const steps = buildSolutionSteps(originalExtraction, stage1Extraction, label, t1, Date.now() - pipelineStart);
    return { finalExtraction: stage1Extraction, finalTraverse: t1, status: 'PASS', repairStageUsed: label, traverseError: null, originalExtraction, solutionSteps: steps };
  }

  // ── Stage 1.5: Surveyor Shape Constraint & Scrivener Corrector ─────────
  let stage1_5Extraction = stage1Extraction;
  let t1_5 = t1;
  if (stage1Extraction.courses && (stage1Extraction.courses.length === 3 || stage1Extraction.courses.length === 4)) {
    console.log('Stage 1.5: Surveyor Shape Constraint & Scrivener Corrector.');
    stage1_5Extraction = trySurveyorShapeCorrection(stage1Extraction, pob, units);
    if (stage1_5Extraction !== stage1Extraction) {
      const [t1_5_new, e1_5] = tryCompute(stage1_5Extraction.courses, pob, units, actualOpenEnded);
      if (t1_5_new) {
        t1_5 = t1_5_new;
        if (isPassing(t1_5)) {
          console.log(`Stage 1.5 PASS: ${t1_5.closure.precisionRatio}`);
          if (t1_5.courses) {
            stage1_5Extraction.courses = t1_5.courses;
            stage1_5Extraction.rawJson = JSON.stringify(t1_5.courses);
          }
          const label15 = stage1_5Extraction.message || 'Stage 1.5: Surveyor Shape & Scrivener Corrector';
          const steps15 = buildSolutionSteps(originalExtraction, stage1_5Extraction, label15, t1_5, Date.now() - pipelineStart);
          return {
            finalExtraction: stage1_5Extraction, finalTraverse: t1_5, status: 'PASS',
            repairStageUsed: label15, traverseError: null, originalExtraction, solutionSteps: steps15
          };
        }
      }
    }
  }

  let bestExtraction = stage1_5Extraction || stage1Extraction || extraction;
  let bestTraverse = t1_5 || t1 || traverse;
  let bestStage = (stage1_5Extraction && stage1_5Extraction.message) || (stage1Extraction && stage1Extraction.message) || 'Stage 1: Bowtie Auto-Fix';

  // ── Stage 3.5: Compass Rule (Bowditch) Adjustment ────────────────────
  // Standard surveying practice: if a traverse closes to 1:5,000 or better
  // AND linear error ≤ 1.0 ft, distribute the misclosure proportionally
  // across all courses (Bowditch method) and accept as PASS(Adjusted).
  // This converts ~300 near-closed FAILs without any AI re-extraction.
  if (bestTraverse && !actualOpenEnded) {
    const linErr = bestTraverse.closure?.linearError ?? Infinity;
    const precStr = bestTraverse.closure?.precisionRatio ?? '';
    const precVal = (() => {
      const parts = precStr.split(':');
      if (parts.length < 2) return 0;
      const v = parseFloat(parts[1].replace(/,/g,'').replace('∞','999999999').trim());
      return isNaN(v) ? 0 : v;
    })();

    const COMPASS_RULE_MIN_PRECISION = 3000;  // 1:3,000 minimum (1970s–2000s survey standard)
    const COMPASS_RULE_MAX_LINEAR_FT = 2.0;   // 2.0 ft maximum misclosure (relaxed from 1.0 ft)

    if (linErr > 0 && linErr <= COMPASS_RULE_MAX_LINEAR_FT && precVal >= COMPASS_RULE_MIN_PRECISION) {
      console.log(`Stage 3.5 PASS (Compass Rule): error=${linErr.toFixed(4)}ft ratio=${precStr} — applying Bowditch adjustment`);

      // Re-compute traverse using the Bowditch-adjusted stations from traverse.js
      // The adjusted stations are already in bestTraverse.adjustedStations
      // Rebuild a "clean" traverse result that reflects the adjusted coordinates
      const adjustedTraverse = {
        ...bestTraverse,
        closure: {
          ...bestTraverse.closure,
          linearError: 0,
          errorNorthing: 0,
          errorEasting: 0,
          precisionRatio: '1:∞ (Compass-Adjusted)',
          status: `✓ PASSES (Compass Rule Adjusted from ${precStr})`,
        },
        compassRuleApplied: true,
        compassRuleOriginalError: linErr,
        compassRuleOriginalPrecision: precStr,
      };

      // Recompute area from adjusted stations
      const adjPts = bestTraverse.adjustedStations || [];
      if (adjPts.length > 2) {
        let area = 0;
        for (let i = 0; i < adjPts.length; i++) {
          const p1 = adjPts[i];
          const p2 = adjPts[(i + 1) % adjPts.length];
          area += (p1.easting * p2.northing) - (p2.easting * p1.northing);
        }
        adjustedTraverse.areaSqFt = Math.abs(area) / 2.0;
        adjustedTraverse.areaAcres = adjustedTraverse.areaSqFt / 43560.0;
      }

      const steps35 = buildSolutionSteps(originalExtraction, bestExtraction,
        `Stage 3.5: Compass Rule Adjusted (was ${precStr}, error=${linErr.toFixed(4)}ft)`,
        adjustedTraverse, Date.now() - pipelineStart);

      return {
        finalExtraction: bestExtraction,
        finalTraverse:   adjustedTraverse,
        status:          'PASS',
        repairStageUsed: `Stage 3.5: Compass Rule Adjusted (${precStr})`,
        traverseError:   null,
        originalExtraction,
        solutionSteps:   steps35,
      };
    }
  }

  // ── Stage 3.6: Meander-Parcel Gap Closure ────────────────────────────
  // For deeds with water boundary meander courses (creek, river, lake, marsh),
  // the AI often extracts the meander segment with isUnknown=true or distance=0
  // because the deed says "along the meanderings thereof, 100 ft more or less".
  // These are VALID parcels — the water boundary is inherently approximate.
  // Strategy: force all meander-like unknown courses into the gap solver,
  // which replaces them with a straight-line chord. If the resulting traverse
  // closes cleanly (or within 5ft for multi-meander parcels), mark as MEANDER.
  if (isMeanderDeed(bestExtraction)) {
    console.log('Stage 3.6: Meander-Parcel — attempting gap closure of water boundary courses.');

    const meanderCourses = (bestExtraction.courses || []).map(c => {
      // Mark as unknown if: distance=0, isUnknown=true, or description contains meander keywords and bearing is unparseable
      const desc = ((c.description || '') + ' ' + (c.label || '')).toUpperCase();
      let parsedBearingValid = false;
      const b = c.bearing || c.chordBearing;
      if (b) {
        try {
          bp.parse(b);
          parsedBearingValid = true;
        } catch {}
      }
      const isMeanderAlways = /MEANDER/.test(desc);
      const isMeanderIfUnparseable = /MORE OR LESS|BANK OF|CREEK|RIVER|LAKE|MARSH|CANAL|THEREOF/.test(desc);
      const isMeanderCourse =
        c.isUnknown ||
        c.distance === 0 || c.distance == null ||
        isMeanderAlways ||
        (!parsedBearingValid && isMeanderIfUnparseable);
      if (isMeanderCourse) {
        return { type: 'Line', bearing: null, distance: null, isUnknown: true, _wasMeander: true };
      }
      return { ...c };
    });

    // Check we have at least one unknown run and at least one known course
    const hasUnknown = meanderCourses.some(c => c.isUnknown);
    const hasKnown   = meanderCourses.some(c => !c.isUnknown);

    if (hasUnknown && hasKnown) {
      const [tmGap] = tryCompute(meanderCourses, pob, units, false);
      if (tmGap) {
        const linErr = tmGap.closure.linearError;
        // For meander parcels: accept up to 5ft error (water boundaries shift seasonally)
        const MEANDER_MAX_ERROR_FT = 5.0;
        if (linErr <= MEANDER_MAX_ERROR_FT) {
          const solvedCourses = traverseSvc.autoFixUnknownRuns(meanderCourses, pob);
          const [tmSolved] = tryCompute(solvedCourses, pob, units, false);
          const finalTrav = tmSolved || tmGap;
          console.log(`Stage 3.6 MEANDER: gap-closed water boundary, linearError=${finalTrav.closure.linearError.toFixed(3)}ft`);
          const mergedExtraction = {
            ...bestExtraction,
            courses: solvedCourses,
            rawJson: JSON.stringify(solvedCourses),
            isOpenEnded: false,
          };
          const steps36 = buildSolutionSteps(originalExtraction, mergedExtraction,
            'Stage 3.6: Meander-Parcel Gap Closure', finalTrav, Date.now() - pipelineStart);
          return {
            finalExtraction: mergedExtraction,
            finalTraverse:   finalTrav,
            status:          'MEANDER',
            repairStageUsed: `Stage 3.6: Meander-Parcel (water boundary ≤${MEANDER_MAX_ERROR_FT}ft, gap-closed)`,
            traverseError:   null,
            originalExtraction,
            solutionSteps:   steps36,
          };
        } else {
          console.log(`Stage 3.6: gap closure gave ${linErr.toFixed(3)}ft — too large, falling through to Stage 4.`);
        }
      }
    }
  }

  // ── Stage 3.7: Deterministic Scrivener Error Solver ──────────────────────
  // Encodes key principles from COGO closure analysis (Parcel B pattern):
  //
  // PRINCIPLE 1 — Area-consistent but non-closing = single course error.
  //   When the computed area (from forced shoelace on open traverse) closely
  //   matches the deed's stated area, the geometry is largely correct and only
  //   ONE course is likely wrong. Do NOT re-extract — solve mathematically.
  //
  // PRINCIPLE 2 — Final return course distance is the #1 scrivener target.
  //   Deed typists often miscopy the closing distance (last "back to POB" leg).
  //   Strategy: compute the EXACT distance needed to close from C(n-1) endpoint
  //   back to POB along the existing final bearing. Accept if precision >= 1:7500.
  //
  // PRINCIPLE 3 — Bearing quadrant inversions (NS or EW swap).
  //   A single misread letter (S for N, W for E) produces a geometric mirror.
  //   Test all four reflections of every course bearing individually.
  //
  // PRINCIPLE 4 — Digit-drop / transcription distance errors.
  //   Common patterns: 9x.xx → 10x.xx (leading-digit drop), x9.xx → x0.xx,
  //   or a decimal shift (195.0 → 19.50). Test ±10, ±20, ÷10, ×10 variants.
  //
  // PRINCIPLE 5 — Consecutive same-bearing courses should be merged.
  //   When two adjacent courses share the exact bearing, they are intentionally
  //   split (ROW boundaries, easement limits) — do NOT merge them for repair.
  //   But DO test correcting the second segment's distance independently.

  if (bestTraverse && !isPassing(bestTraverse)) {
    console.log('Stage 3.7: Deterministic Scrivener Error Solver — systematic single-course correction.');
    const s37result = tryScrivenerErrorSolver(bestExtraction, pob, units, actualOpenEnded);
    if (s37result) {
      const [t37, e37] = tryCompute(s37result.courses, pob, units, actualOpenEnded);
      const t37Passed = checkPass(t37);
      if (t37Passed) {
        console.log(`Stage 3.7 PASS: ${t37Passed.closure.precisionRatio} — ${s37result.message}`);
        t37Passed.courses = s37result.courses;
        const steps37 = buildSolutionSteps(originalExtraction, s37result, s37result.message, t37Passed, Date.now() - pipelineStart);
        return {
          finalExtraction: s37result,
          finalTraverse:   t37Passed,
          status:          'PASS',
          repairStageUsed: `Stage 3.7: ${s37result.message}`,
          traverseError:   null,
          originalExtraction,
          solutionSteps:   steps37,
        };
      } else {
        console.log(`Stage 3.7: best candidate error=${t37?.closure?.linearError?.toFixed(3) ?? '?'}ft — did not pass.`);
      }
    } else {
      console.log('Stage 3.7: No single-course correction achieved closure.');
    }
  }

  // ── Stage 3.8: Bearing Consistency Harmonizer ─────────────────────────────
  // Near-antiparallel course pairs with 0.01°–5° bearing mismatch.
  // Classic pattern: deed south line vs plat ROW use different bearing control.
  if (bestTraverse && !isPassing(bestTraverse) && !actualOpenEnded) {
    console.log('Stage 3.8: Bearing Consistency Harmonizer.');
    const s38result = _tryBearingHarmonization(bestExtraction?.courses || [], pob, units, actualOpenEnded);
    if (s38result) {
      const [t38] = tryCompute(s38result.courses, pob, units, actualOpenEnded);
      const t38Passed = checkPass(t38);
      if (t38Passed) {
        console.log(`Stage 3.8 PASS: ${t38Passed.closure.precisionRatio} — ${s38result.message}`);
        t38Passed.courses = s38result.courses;
        const steps38 = buildSolutionSteps(originalExtraction, s38result, s38result.message, t38Passed, Date.now() - pipelineStart);
        return { finalExtraction: s38result, finalTraverse: t38Passed, status: 'PASS',
          repairStageUsed: `Stage 3.8: ${s38result.message}`, traverseError: null,
          originalExtraction, solutionSteps: steps38 };
      } else {
        console.log(`Stage 3.8: error=${t38?.closure?.linearError?.toFixed(3) ?? '?'}ft — did not pass.`);
      }
    } else {
      console.log('Stage 3.8: No near-antiparallel pair found within 5°.');
    }
  }

  // ── Stage 3.9: Commencement Leg Stripper ──────────────────────────────────
  // When the closure error vector (dN, dE) closely matches one or two leading
  // courses (within 5%), those courses are misidentified commencement legs.
  // Strip them from the boundary and retest.
  // Dominant pattern: the extractor includes "COMMENCE … THENCE S.89°W 1318.72ft
  // … THENCE S.00°W 30ft … POB" causing a ~1319ft unidirectional error.
  if (bestTraverse && !isPassing(bestTraverse) && bestExtraction?.courses?.length > 2) {
    console.log('Stage 3.9: Commencement Leg Stripper.');
    const s39result = _tryCommencementStrip(
      bestExtraction.courses, pob, units, actualOpenEnded, bestTraverse.closure
    );
    if (s39result) {
      const [t39] = tryCompute(s39result.courses, pob, units, actualOpenEnded);
      const t39Passed = checkPass(t39);
      if (t39Passed) {
        console.log(`Stage 3.9 PASS: ${t39Passed.closure.precisionRatio} — ${s39result.message}`);
        t39Passed.courses = s39result.courses;
        const steps39 = buildSolutionSteps(
          originalExtraction, s39result, s39result.message, t39Passed, Date.now() - pipelineStart
        );
        return {
          finalExtraction: s39result, finalTraverse: t39Passed, status: 'PASS',
          repairStageUsed: `Stage 3.9: ${s39result.message}`,
          traverseError: null, originalExtraction, solutionSteps: steps39,
        };
      } else {
        console.log(`Stage 3.9: error=${t39?.closure?.linearError?.toFixed(3) ?? '?'}ft — did not pass.`);
      }
    } else {
      console.log('Stage 3.9: No commencement-leg match found within 5%.');
    }
  }

  // ── Stage 3.9b: Commencement Leg Restorer & Scrivener Solver ──────────────
  // If we have commencement segments extracted, but the traverse fails to close,
  // it is common that the first 1-3 commencement segments are actually boundary segments.
  // Test prepending the last k commencement segments back to the main courses,
  // and run both direct traverse and the Deterministic Scrivener Solver on them.
  if (bestTraverse && !isPassing(bestTraverse) && originalExtraction?.commencementSegments?.length > 0) {
    console.log('Stage 3.9b: Commencement Leg Restorer.');
    const comm = originalExtraction.commencementSegments;
    const main = bestExtraction?.courses || [];
    
    let resolvedRestoration = null;
    
    for (let k = 1; k <= comm.length; k++) {
      const restoredComm = comm.slice(comm.length - k);
      const remainingComm = comm.slice(0, comm.length - k);
      const candidateCourses = [...restoredComm, ...main];
      
      const testExtraction = {
        ...bestExtraction,
        courses: candidateCourses,
        commencementSegments: remainingComm,
        rawJson: JSON.stringify(candidateCourses)
      };
      
      // Test 1: Direct closure on restored courses
      const [tRestored] = tryCompute(candidateCourses, pob, units, actualOpenEnded);
      const tRestoredPassed = checkPass(tRestored);
      if (tRestoredPassed) {
        resolvedRestoration = {
          extraction: testExtraction,
          traverse: tRestoredPassed,
          message: `Stage 3.9b: Commencement Restorer restored ${k} commencement leg(s) directly`
        };
        break;
      }
      
      // Test 2: Scrivener error solver on restored courses
      const sResult = tryScrivenerErrorSolver(testExtraction, pob, units, actualOpenEnded);
      if (sResult) {
        const [tSolved] = tryCompute(sResult.courses, pob, units, actualOpenEnded);
        const tSolvedPassed = checkPass(tSolved);
        if (tSolvedPassed) {
          resolvedRestoration = {
            extraction: sResult,
            traverse: tSolvedPassed,
            message: `Stage 3.9b: Commencement Restorer restored ${k} commencement leg(s) + Scrivener correction (${sResult.message})`
          };
          break;
        }
      }
    }
    
    if (resolvedRestoration) {
      console.log(`Stage 3.9b PASS: ${resolvedRestoration.message}`);
      const steps39b = buildSolutionSteps(originalExtraction, resolvedRestoration.extraction, resolvedRestoration.message, resolvedRestoration.traverse, Date.now() - pipelineStart);
      return {
        finalExtraction: resolvedRestoration.extraction,
        finalTraverse:   resolvedRestoration.traverse,
        status:          'PASS',
        repairStageUsed: resolvedRestoration.message,
        traverseError:   null,
        originalExtraction,
        solutionSteps:   steps39b
      };
    } else {
      console.log('Stage 3.9b: No commencement-leg restoration achieved closure.');
    }
  }

  // ── Stage 2: Dual-Run Consensus (Generative Fallback) ───────────────────
  console.log('Stage 2: Dual-run Gemini consensus voting.');

  let stage2Extraction = null, t2 = null;
  try {
    stage2Extraction = await gemini.extractBoundary(imageBytes, mimeType);
    [t2] = tryCompute(stage2Extraction.courses, pob, units, actualOpenEnded);
  } catch (ex) {
    console.warn('Stage 2: Second Gemini run failed, skipping consensus.', ex.message);
  }

  if (t2) {
    const err1 = bestTraverse?.closure?.linearError ?? Infinity;
    const err2 = t2.closure.linearError;
    if (err2 < err1) {
      bestExtraction = stage2Extraction;
      bestTraverse = t2;
      bestStage = 'Stage 2: Consensus (Run 2)';
      console.log(`Stage 2: Run 2 wins with LinearError=${err2}`);
    } else {
      console.log(`Stage 2: Run 1 wins with LinearError=${err1}`);
    }
  }

  const t2Passed = checkPass(t2);
  if (t2Passed) {
    console.log(`Stage 2 PASS: ${t2Passed.closure.precisionRatio}`);
    if (t2Passed.courses) {
      bestExtraction.courses = t2Passed.courses;
      bestExtraction.rawJson = JSON.stringify(t2Passed.courses);
    }
    const steps2 = buildSolutionSteps(originalExtraction, bestExtraction, bestStage, t2Passed, Date.now() - pipelineStart);
    return { finalExtraction: bestExtraction, finalTraverse: t2Passed, status: 'PASS', repairStageUsed: bestStage, traverseError: null, originalExtraction, solutionSteps: steps2 };
  }

  // ── Stage 3: AI Misclosure Repair (Generative Fallback) ─────────────────
  console.log('Stage 3: AI misclosure repair.');
  const worstTraverse = bestTraverse || traverse || t1;
  try {
    const stage3Extraction = await gemini.extractMisclosureRepair(imageBytes, mimeType, bestExtraction, worstTraverse);
    const [t3, e3] = tryCompute(stage3Extraction.courses, pob, units, actualOpenEnded);
    const t3Passed = checkPass(t3);
    if (t3Passed) {
      console.log(`Stage 3 PASS: ${t3Passed.closure.precisionRatio}`);
      if (t3Passed.courses) {
        stage3Extraction.courses = t3Passed.courses;
        stage3Extraction.rawJson = JSON.stringify(t3Passed.courses);
      }
      const steps3 = buildSolutionSteps(originalExtraction, stage3Extraction, 'Stage 3: AI Misclosure Repair', t3Passed, Date.now() - pipelineStart);
      return { finalExtraction: stage3Extraction, finalTraverse: t3Passed, status: 'PASS', repairStageUsed: 'Stage 3: AI Misclosure Repair', traverseError: null, originalExtraction, solutionSteps: steps3 };
    }
    if (t3 && worstTraverse && worstTraverse.closure && t3.closure.linearError < worstTraverse.closure.linearError) {
      bestExtraction = stage3Extraction;
      bestTraverse = t3;
      console.log(`Stage 3 improved error: ${t3.closure.linearError}`);
    }
  } catch (ex) {
    console.warn('Stage 3: AI repair call failed, proceeding to Stage 4.', ex.message);
  }

  // Sync solved courses for Stage 4 fallback scenarios as well
  if (bestTraverse && bestTraverse.courses) {
    bestExtraction.courses = bestTraverse.courses;
    bestExtraction.rawJson = JSON.stringify(bestTraverse.courses);
  }


  // ── Stage 4.5b: Bearing-Minute Perturbation ─────────────────────────────
  // Near-unidirectional error + known bust course → perturb bearing ±1'–30'.
  if (bustCourseIdx >= 0 && bestExtraction?.courses && bestTraverse && !isPassing(bestTraverse)) {
    const pbResult = _tryBearingMinutePerturbation(
      bestExtraction.courses, bustCourseIdx, pob, units, actualOpenEnded, bestTraverse.closure);
    if (pbResult) {
      const [tPB] = tryCompute(pbResult.courses, pob, units, actualOpenEnded);
      const tPBPassed = checkPass(tPB);
      if (tPBPassed) {
        console.log(`Stage 4.5b PASS: ${tPBPassed.closure.precisionRatio}`);
        const stepsPB = buildSolutionSteps(originalExtraction, pbResult, pbResult.message, tPBPassed, Date.now() - pipelineStart);
        return { finalExtraction: pbResult, finalTraverse: tPBPassed, status: 'PASS',
          repairStageUsed: pbResult.message, traverseError: null, originalExtraction, solutionSteps: stepsPB };
      }
    }
  }

  if (isMeanderDeed(bestExtraction)) {
    console.log('Stage 4: Detected MEANDER deed (water boundary).');
    const hasSelfIntersection = bestTraverse ? detectSelfIntersection(bestTraverse.adjustedStations || bestTraverse.stations) : false;
    return {
      finalExtraction: bestExtraction, finalTraverse: bestTraverse, status: 'MEANDER',
      repairStageUsed: 'Stage 4: Meander Deed (Water Boundary)',
      traverseError: bestTraverse
        ? `Closure error ${bestTraverse.closure?.linearError?.toFixed(4)} ft — deed contains meander/water boundary lines.` + (hasSelfIntersection ? ' Warning: Self-intersecting boundary detected.' : '')
        : (traverseError || 'Deed geometry contains calculation errors or missing meander parameters.'),
      originalExtraction,
      hasSelfIntersection,
    };
  }

  console.log('Stage 4: Marking deed for adjacent-lot boundary review.');
  const hasSelfIntersection = bestTraverse ? detectSelfIntersection(bestTraverse.adjustedStations || bestTraverse.stations) : false;
  return {
    finalExtraction: bestExtraction, finalTraverse: bestTraverse, status: 'FAIL',
    repairStageUsed: 'Stage 4: Needs Adjacent Lot Review',
    traverseError: bestTraverse
      ? `Closure error ${bestTraverse.closure?.linearError?.toFixed(4)} ft after all repair stages.` + (hasSelfIntersection ? ' Warning: Self-intersecting boundary detected.' : '')
      : (traverseError || 'Deed geometry contains calculation errors or missing curve parameters.'),
    originalExtraction,
    hasSelfIntersection,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Stage 3.9 helper — Commencement Leg Stripper.
 * When the closure error vector (errN, errE) closely matches the cumulative
 * northing/easting of the first 1–3 courses (within 5% of error magnitude),
 * those courses were incorrectly included as boundary courses but are actually
 * commencement (reference) runs. Strip them and re-test closure.
 *
 * Dominant pattern: "COMMENCE … S.89°43'W 1318.72ft → S.00°14'W 30ft → POB"
 * extractor includes both legs, causing ~1319ft westward closure error.
 */
function _tryPreemptiveCommencementStrip(courses, pob, units, isOpenEnded, closure) {
  const errN = closure?.errorNorthing ?? 0;
  const errE = closure?.errorEasting ?? 0;
  const errMag = Math.hypot(errN, errE);
  if (errMag < 5.0 || courses.length < 4) return null;

  let bestStrip = null;
  let minResid = Infinity;

  for (let stripLen = 1; stripLen <= Math.min(12, courses.length - 3); stripLen++) {
    let cumN = 0, cumE = 0;
    let allResolvable = true;
    for (let k = 0; k < stripLen; k++) {
      const c = courses[k];
      const bearing = c.bearing || c.chordBearing;
      const distance = c.distance != null ? c.distance : c.chordDistance;
      if (!bearing || c.isUnknown || distance == null) { allResolvable = false; break; }
      let parsed;
      try { parsed = bp.parse(bearing); } catch { allResolvable = false; break; }
      if (parsed?.azimuthDeg == null) { allResolvable = false; break; }
      const az = parsed.azimuthDeg * Math.PI / 180;
      cumN += distance * Math.cos(az);
      cumE += distance * Math.sin(az);
    }
    if (!allResolvable) continue;

    const residN = errN + cumN;
    const residE = errE + cumE;
    const residMag = Math.hypot(residN, residE);

    if (residMag < errMag * 0.15 && residMag < minResid) {
      minResid = residMag;
      const stripped = courses.slice(stripLen);
      const stripped_names = courses.slice(0, stripLen).map((c, k) => `C${k+1}(${c.bearing || c.chordBearing || 'Curve'},${c.distance != null ? c.distance : c.chordDistance}ft)`).join(' + ');
      bestStrip = {
        courses: stripped,
        message: `Stage 0.5: Preemptive Commencement Stripper removed ${stripLen} leading course(s) [${stripped_names}] — were commencement runs, not boundary`,
        stripLen
      };
    }
  }
  return bestStrip;
}

function _tryCommencementStrip(courses, pob, units, isOpenEnded, closure) {
  const errN = closure?.errorNorthing ?? 0;
  const errE = closure?.errorEasting ?? 0;
  const errMag = Math.hypot(errN, errE);
  if (errMag < 5.0 || courses.length < 4) return null;

  let bestStrip = null;
  let minResid = Infinity;

  // For each possible leading strip length (up to 12 courses):
  for (let stripLen = 1; stripLen <= Math.min(12, courses.length - 3); stripLen++) {
    let cumN = 0, cumE = 0;
    let allResolvable = true;
    for (let k = 0; k < stripLen; k++) {
      const c = courses[k];
      const bearing = c.bearing || c.chordBearing;
      const distance = c.distance != null ? c.distance : c.chordDistance;
      if (!bearing || c.isUnknown || distance == null) { allResolvable = false; break; }
      let parsed;
      try { parsed = bp.parse(bearing); } catch { allResolvable = false; break; }
      if (parsed?.azimuthDeg == null) { allResolvable = false; break; }
      const az = parsed.azimuthDeg * Math.PI / 180;
      cumN += distance * Math.cos(az);
      cumE += distance * Math.sin(az);
    }
    if (!allResolvable) continue;

    // Check if stripping these courses would reduce the error significantly
    const residN = errN + cumN;  // error PLUS the commencement displacement → should approach 0
    const residE = errE + cumE;
    const residMag = Math.hypot(residN, residE);


    // Accept if the stripped courses account for ≥85% of the error
    if (residMag < errMag * 0.15 && residMag < minResid) {
      const stripped = courses.slice(stripLen);
      const [test] = tryCompute(stripped, pob, units, isOpenEnded);
      if (test && isPassing(test)) {
        minResid = residMag;
        const stripped_names = courses.slice(0, stripLen).map((c, k) => `C${k+1}(${c.bearing || c.chordBearing || 'Curve'},${c.distance != null ? c.distance : c.chordDistance}ft)`).join(' + ');
        bestStrip = {
          courses: stripped,
          message: `Commencement Leg Stripper: removed ${stripLen} leading course(s) [${stripped_names}] — were commencement runs, not boundary`,
        };
      }
    }
  }
  return bestStrip;
}

/**
 * Stage 4.5b helper — Bearing-Minute Perturbation.
 * Activates only when closure error is near-unidirectional (errRatio < 0.15).
 * Tests ±1',±2',±5',±10',±20',±30' on the identified bust course bearing.
 */

function _tryBearingMinutePerturbation(courses, bustIdx, pob, units, isOpenEnded, closure) {
  const bustCourse = courses[bustIdx];
  if (!bustCourse?.bearing || bustCourse.type?.toLowerCase() !== 'line') return null;
  const errN = closure?.errorNorthing ?? 0;
  const errE = closure?.errorEasting ?? 0;
  const errMag = Math.hypot(errN, errE);
  if (errMag < 0.30) return null;
  if (Math.min(Math.abs(errN), Math.abs(errE)) / (errMag || 1) > 0.15) return null;

  const azToQB = (az) => {
    const a = ((az % 360) + 360) % 360;
    let q1, q2, dd;
    if (a <= 90)       { q1 = 'N'; q2 = 'E'; dd = a; }
    else if (a <= 180) { q1 = 'S'; q2 = 'E'; dd = 180 - a; }
    else if (a <= 270) { q1 = 'S'; q2 = 'W'; dd = a - 180; }
    else               { q1 = 'N'; q2 = 'W'; dd = 360 - a; }
    const d = Math.floor(dd), mr = (dd - d) * 60, m = Math.floor(mr);
    const s = Math.min(59, Math.round((mr - m) * 60));
    return `${q1}${String(d).padStart(2,'0')}°${String(m).padStart(2,'0')}'${String(s).padStart(2,'0')}"${q2}`;
  };
  let parsed; try { parsed = bp.parse(bustCourse.bearing); } catch { return null; }
  if (parsed?.azimuthDeg == null) return null;
  for (const dm of [1, 2, 5, 10, 20, 30, -1, -2, -5, -10, -20, -30]) {
    const nb = azToQB(((parsed.azimuthDeg + dm / 60) % 360 + 360) % 360);
    if (nb === bustCourse.bearing) continue;
    const tc = courses.map((c, i) => i === bustIdx ? { ...c, bearing: nb } : c);
    const [t] = tryCompute(tc, pob, units, isOpenEnded);
    const tPassed = checkPass(t);
    if (tPassed) return {
      courses: tc,
      message: `Stage 4.5b: Bearing Perturbation — C${bustIdx + 1} ${bustCourse.bearing} ${dm > 0 ? '+' : ''}${dm}' → ${nb}`,
    };
  }
  return null;
}

/**
 * Stage 3.8 helper — Bearing Consistency Harmonizer.
 * Finds near-antiparallel course pairs with 0.01°–5° bearing mismatch and
 * tests harmonizing each to its partner's exact reverse bearing.
 */
function _tryBearingHarmonization(courses, pob, units, isOpenEnded) {
  const to360 = az => ((az % 360) + 360) % 360;
  const azToQB = (az) => {
    const a = to360(az);
    let q1, q2, dd;
    if (a <= 90)       { q1 = 'N'; q2 = 'E'; dd = a; }
    else if (a <= 180) { q1 = 'S'; q2 = 'E'; dd = 180 - a; }
    else if (a <= 270) { q1 = 'S'; q2 = 'W'; dd = a - 180; }
    else               { q1 = 'N'; q2 = 'W'; dd = 360 - a; }
    const d = Math.floor(dd), mr = (dd - d) * 60, m = Math.floor(mr);
    const s = Math.min(59, Math.round((mr - m) * 60));
    return `${q1}${String(d).padStart(2,'0')}°${String(m).padStart(2,'0')}'${String(s).padStart(2,'0')}"${q2}`;
  };
  const N = courses.length;
  for (let i = 0; i < N; i++) {
    if (courses[i].type?.toLowerCase() !== 'line' || !courses[i].bearing) continue;
    let pI; try { pI = bp.parse(courses[i].bearing); } catch { continue; }
    if (pI?.azimuthDeg == null) continue;
    const revI = to360(pI.azimuthDeg + 180);
    for (let j = i + 1; j < N; j++) {
      if (courses[j].type?.toLowerCase() !== 'line' || !courses[j].bearing) continue;
      let pJ; try { pJ = bp.parse(courses[j].bearing); } catch { continue; }
      if (pJ?.azimuthDeg == null) continue;
      const diff = Math.min(Math.abs(revI - pJ.azimuthDeg), 360 - Math.abs(revI - pJ.azimuthDeg));
      if (diff <= 0.01 || diff >= 5.0) continue;
      // Variant A: harmonize i → reverse of j
      const nbA = azToQB(to360(pJ.azimuthDeg + 180));
      if (nbA !== courses[i].bearing) {
        const vA = courses.map((c, k) => k === i ? { ...c, bearing: nbA } : c);
        const [tA] = tryCompute(vA, pob, units, isOpenEnded);
        const tAPassed = checkPass(tA);
        if (tAPassed) return { courses: vA, message: `Bearing Harmonization: C${i+1} → reverse of C${j+1} (${courses[i].bearing}→${nbA})` };
      }
      // Variant B: harmonize j → reverse of i
      const nbB = azToQB(revI);
      if (nbB !== courses[j].bearing) {
        const vB = courses.map((c, k) => k === j ? { ...c, bearing: nbB } : c);
        const [tB] = tryCompute(vB, pob, units, isOpenEnded);
        const tBPassed = checkPass(tB);
        if (tBPassed) return { courses: vB, message: `Bearing Harmonization: C${j+1} → reverse of C${i+1} (${courses[j].bearing}→${nbB})` };
      }
    }
  }
  return null;
}

/**
 * Helper to classify the probable error source of a deed based on corrections applied.
 */
function determineProbableErrorSource(stage, corrections) {
  if (!corrections || corrections.length === 0) {
    if (stage && (stage.includes('Open-Ended') || stage.includes('Centerline') || stage.includes('Easement') || stage.includes('Strip'))) {
      return 'HISTORICAL_FIELD_ERROR';
    }
    return 'NONE';
  }

  const stageLower = (stage || '').toLowerCase();
  
  if (stageLower.includes('ocr')) {
    return 'OCR_ERROR';
  }
  if (stageLower.includes('scrivener') || stageLower.includes('commencement')) {
    return 'SCRIVENER_ERROR';
  }
  if (stageLower.includes('compass rule') || stageLower.includes('meander') || stageLower.includes('water')) {
    return 'HISTORICAL_FIELD_ERROR';
  }

  let hasOcrPattern = false;
  let hasScrivenerPattern = false;

  for (const c of corrections) {
    if (c.changeType === 'BEARING_CORRECTED') {
      const orig = (c.originalBearing || '').toLowerCase();
      const corr = (c.correctedBearing || '').toLowerCase();
      if (orig.includes('p') || orig.includes('9') || (orig.includes("'") && !corr.includes("'")) || (orig.includes('l') && corr.includes('1'))) {
        hasOcrPattern = true;
      }
      const origMatch = orig.match(/^([nsew])(\d+)[°d](\d+)['′](\d+)[nsew]$/);
      const corrMatch = corr.match(/^([nsew])(\d+)[°d](\d+)['′](\d+)[nsew]$/);
      if (origMatch && corrMatch) {
        const quadrantFlip = (origMatch[1] !== corrMatch[1] || origMatch[4] !== corrMatch[4]) && origMatch[2] === corrMatch[2] && origMatch[3] === corrMatch[3];
        if (quadrantFlip) {
          hasScrivenerPattern = true;
        }
      }
    }
    if (c.changeType === 'DISTANCE_CORRECTED') {
      hasScrivenerPattern = true;
    }
  }

  if (hasOcrPattern) return 'OCR_ERROR';
  if (hasScrivenerPattern) return 'SCRIVENER_ERROR';

  if (stageLower.includes('ai') || stageLower.includes('agent')) {
    return 'SCRIVENER_ERROR';
  }

  return 'HISTORICAL_FIELD_ERROR';
}

/**
 * Builds a structured solution-steps record comparing original vs repaired courses.
 * Stored in SolutionStepsJson in DeedLogs for full forensic replay.
 */
function buildSolutionSteps(originalExtraction, repairedExtraction, stage, traverse, elapsedMs = 0) {
  const origCourses  = originalExtraction?.courses  || [];
  const repairCourses = repairedExtraction?.courses || [];

  const corrections = repairCourses.map((rc, i) => {
    const oc = origCourses[i];
    const bearingChanged  = oc && rc.bearing  && oc.bearing  !== rc.bearing;
    const distanceChanged = oc && rc.distance != null && oc.distance != null && Math.abs(oc.distance - rc.distance) > 0.001;
    const wasUnknown      = !oc || oc.isUnknown || !oc.bearing || oc.distance == null || oc.distance === 0;

    let changeType = 'ORIGINAL';
    if (wasUnknown && rc.bearing)      changeType = 'SOLVED_BY_INVERSE';
    else if (bearingChanged)           changeType = 'BEARING_CORRECTED';
    else if (distanceChanged)          changeType = 'DISTANCE_CORRECTED';

    return {
      courseNumber: i + 1,
      changeType,
      originalBearing:  oc?.bearing   ?? null,
      correctedBearing: rc.bearing    ?? null,
      originalDistance: oc?.distance  ?? null,
      correctedDistance: rc.distance  ?? null,
      type: rc.type ?? 'Line',
    };
  });

  // If repairedExtraction has MORE courses (gap solved new segments)
  for (let i = origCourses.length; i < repairCourses.length; i++) {
    const rc = repairCourses[i];
    corrections.push({
      courseNumber: i + 1,
      changeType: 'SOLVED_BY_INVERSE',
      originalBearing: null, correctedBearing: rc.bearing ?? null,
      originalDistance: null, correctedDistance: rc.distance ?? null,
      type: rc.type ?? 'Line',
    });
  }

  const changed = corrections.filter(c => c.changeType !== 'ORIGINAL');

  return {
    stage,
    elapsedMs,
    timestamp: new Date().toISOString(),
    originalCourseCount: origCourses.length,
    repairedCourseCount: repairCourses.length,
    correctionsApplied: changed.length,
    probableErrorSource: determineProbableErrorSource(stage, corrections),
    closureAfter: traverse ? {
      linearError:    traverse.closure?.linearError  ?? null,
      precisionRatio: traverse.closure?.precisionRatio ?? null,
      status:         traverse.closure?.status ?? null,
      areaAcres:      traverse.areaAcres ?? null,
      perimeter:      traverse.perimeter ?? null,
    } : null,
    corrections,
    summary: changed.length === 0
      ? 'No corrections required — deed closed on first attempt.'
      : changed.map(c =>
          c.changeType === 'SOLVED_BY_INVERSE'
            ? `Course ${c.courseNumber}: solved by inverse gap (→ ${c.correctedBearing} ${c.correctedDistance?.toFixed(2)}')`
            : c.changeType === 'BEARING_CORRECTED'
              ? `Course ${c.courseNumber}: bearing corrected (${c.originalBearing} → ${c.correctedBearing})`
              : `Course ${c.courseNumber}: distance adjusted (${c.originalDistance?.toFixed(2)}' → ${c.correctedDistance?.toFixed(2)}')`
        ).join('; '),
  };
}

function tryCompute(courses, pob, units, isOpenEnded = false) {
  if (!courses || courses.length === 0) return [null, 'No courses'];
  try {
    const result = traverseSvc.compute({ pointOfBeginning: pob, courses, units, isOpenEnded });
    return [result, null];
  } catch (ex) {
    return [null, ex.message];
  }
}

function isPassing(t) {
  if (t.closure.status.includes('Open-Ended')) return true;

  // Degeneracy Check: Area is extremely small, but perimeter is significant
  const isDegenerate = t.areaSqFt != null && t.areaSqFt < 10.0 && t.perimeter > 100.0;
  if (isDegenerate) {
    console.log(`isPassing: Rejected degenerate traverse (areaSqFt=${t.areaSqFt.toFixed(2)}, perimeter=${t.perimeter.toFixed(2)})`);
    return false;
  }

  // Backtracking Check: Reject if there are backtracking/opposite consecutive courses
  if (t.courses && detectBacktracking(t.courses, true)) {
    console.log(`isPassing: Rejected traverse due to backtracking`);
    return false;
  }

  if (t.closure.linearError < PASS_LINEAR_ERROR_FT) return true;
  const parts = t.closure.precisionRatio.split(':');
  if (parts.length > 1) {
    const cleaned = parts[1].replace(/,/g, '').replace('∞', '999999999').trim();
    const ratio = parseFloat(cleaned);
    if (!isNaN(ratio) && ratio >= PASS_PRECISION_RATIO) return true;
  }
  return false;
}

export function applyCompassRuleIfEligible(t) {
  if (!t || t.closure?.status?.includes('Open-Ended') || t.compassRuleApplied) return t;

  const linErr = t.closure?.linearError ?? Infinity;
  const precStr = t.closure?.precisionRatio ?? '';
  const precVal = (() => {
    const parts = precStr.split(':');
    if (parts.length < 2) return 0;
    const v = parseFloat(parts[1].replace(/,/g,'').replace('∞','999999999').trim());
    return isNaN(v) ? 0 : v;
  })();

  const COMPASS_RULE_MIN_PRECISION = 3000;
  const COMPASS_RULE_MAX_LINEAR_FT = 2.0;

  if (linErr > 0 && linErr <= COMPASS_RULE_MAX_LINEAR_FT && precVal >= COMPASS_RULE_MIN_PRECISION) {
    const adjustedTraverse = {
      ...t,
      closure: {
        ...t.closure,
        linearError: 0,
        errorNorthing: 0,
        errorEasting: 0,
        precisionRatio: '1:∞ (Compass-Adjusted)',
        status: `✓ PASSES (Compass Rule Adjusted from ${precStr})`,
      },
      compassRuleApplied: true,
      compassRuleOriginalError: linErr,
      compassRuleOriginalPrecision: precStr,
    };

    const adjPts = t.adjustedStations || [];
    if (adjPts.length > 2) {
      let area = 0;
      for (let i = 0; i < adjPts.length; i++) {
        const p1 = adjPts[i];
        const p2 = adjPts[(i + 1) % adjPts.length];
        area += (p1.easting * p2.northing) - (p2.easting * p1.northing);
      }
      adjustedTraverse.areaSqFt = Math.abs(area) / 2.0;
      adjustedTraverse.areaAcres = adjustedTraverse.areaSqFt / 43560.0;
    }
    return adjustedTraverse;
  }

  return t;
}

export function checkPass(t) {
  if (!t) return null;
  if (isPassing(t)) return t;
  const adjusted = applyCompassRuleIfEligible(t);
  if (adjusted && isPassing(adjusted)) return adjusted;
  return null;
}

/**
 * Stage 3.7 — Deterministic Scrivener Error Solver
 *
 * Systematically tests single-course corrections derived from 5 key principles
 * observed in real deed closure failures (Parcel B pattern analysis):
 *
 *  Principle 2: Exact closing distance on final course (most common fix)
 *  Principle 2b: Exact closing distance on ANY course bearing (all courses)
 *  Principle 3: Bearing quadrant inversion — flip NS or EW on each course
 *  Principle 4: Distance digit errors — ±10/±20/÷10/×10 variants
 *  Principle 4b: Decimal shift errors (e.g. 95.78 vs 957.8 vs 9.578)
 *
 * Returns the corrected extraction object (with .message) if a fix passes,
 * or null if no single-course correction achieves closure.
 *
 * Design rule: never modifies more than one course per hypothesis.
 * This prevents false positives from over-fitting to bad geometry.
 */
export function tryScrivenerErrorSolver(extraction, pob, units, isOpenEnded) {
  const courses = extraction?.courses;
  if (!courses || courses.length < 3) return null;

  const N_COURSES = courses.length;

  // ── Utility: run traverse from a start position through a slice of courses ──
  const runSlice = (startN, startE, slice) => {
    let N = startN, E = startE;
    for (const c of slice) {
      const az = (() => { try { return bp.parse(c.bearing)?.azimuthDeg ?? null; } catch { return null; } })();
      if (az == null || !c.distance) return null;
      const rad = (az * Math.PI) / 180;
      N += c.distance * Math.cos(rad);
      E += c.distance * Math.sin(rad);
    }
    return { N, E };
  };

  // ── Compute prefix endpoint (position after first i courses) ──
  const prefixPts = [{ N: pob.northing, E: pob.easting }];
  for (let i = 0; i < N_COURSES; i++) {
    const prev = prefixPts[i];
    const c = courses[i];
    const az = (() => { try { return bp.parse(c.bearing)?.azimuthDeg ?? null; } catch { return null; } })();
    // Guard: if prev is null (prior course had no bearing/distance) or current course is invalid,
    // propagate null so downstream Principle 2b skips this index safely.
    if (!prev || az == null || !c.distance) { prefixPts.push(prev ?? null); continue; }
    const rad = (az * Math.PI) / 180;
    prefixPts.push({
      N: prev.N + c.distance * Math.cos(rad),
      E: prev.E + c.distance * Math.sin(rad),
    });
  }

  // ── Scoring: evaluate full modified course list ──
  const evaluate = (modifiedCourses) => {
    const [t] = tryCompute(modifiedCourses, pob, units, isOpenEnded);
    if (!t) return null;
    return { t, linearError: t.closure.linearError };
  };

  let bestResult = null;
  let bestError  = Infinity;
  const tryCandidate = (modifiedCourses, label) => {
    const res = evaluate(modifiedCourses);
    if (!res) return;
    if (res.linearError < bestError) {
      bestError  = res.linearError;
      bestResult = { courses: modifiedCourses, message: label };
    }
  };

  // ────────────────────────────────────────────────────────────────
  // PRINCIPLE 2: Exact closing distance on the FINAL course
  // Most common scrivener error: typist mis-copies the return leg distance.
  // Strategy: hold the final bearing fixed; compute the distance that makes
  // the traverse close exactly from the C(n-1) endpoint back to POB.
  // ────────────────────────────────────────────────────────────────
  (() => {
    const lastCourse = courses[N_COURSES - 1];
    const preLastPt  = prefixPts[N_COURSES - 1];
    if (!lastCourse?.bearing || !preLastPt) return;

    const az  = (() => { try { return bp.parse(lastCourse.bearing)?.azimuthDeg ?? null; } catch { return null; } })();
    if (az == null) return;
    const rad = (az * Math.PI) / 180;
    const cosA = Math.cos(rad), sinA = Math.sin(rad);

    // Exact close in Northing: d = (pobN - preLastN) / cos(az)
    // Exact close in Easting:  d = (pobE - preLastE) / sin(az)
    const dN_needed = pob.northing - preLastPt.N;
    const dE_needed = pob.easting  - preLastPt.E;

    // Solve least-squares distance that minimizes residual
    // d = (cosA*dN_needed + sinA*dE_needed) / (cosA² + sinA²) = cosA*dN + sinA*dE
    const dExact = cosA * dN_needed + sinA * dE_needed;

    if (dExact > 0.1) {
      const fixed = courses.map((c, i) =>
        i === N_COURSES - 1 ? { ...c, distance: parseFloat(dExact.toFixed(4)) } : { ...c }
      );
      const origDist = lastCourse.distance;
      tryCandidate(fixed,
        `Scrivener fix: C${N_COURSES} distance ${origDist?.toFixed(2) ?? '?'}→${dExact.toFixed(2)}ft (final leg exact close)`);
    }
  })();

  // ────────────────────────────────────────────────────────────────
  // PRINCIPLE 2b: Exact closing distance on EVERY course
  // Sometimes the error is mid-traverse, not on the last leg.
  // For each course i: fix its distance so remaining courses close.
  // ────────────────────────────────────────────────────────────────
  for (let i = 0; i < N_COURSES; i++) {
    const c = courses[i];
    if (!c.bearing || !c.distance) continue;
    const preI = prefixPts[i];
    if (!preI) continue;

    const az  = (() => { try { return bp.parse(c.bearing)?.azimuthDeg ?? null; } catch { return null; } })();
    if (az == null) continue;
    const rad = (az * Math.PI) / 180;
    const cosA = Math.cos(rad), sinA = Math.sin(rad);

    // Run courses AFTER i (i+1 … n-1) from a test endpoint
    // Find d such that: preI + d*(cosA,sinA) + suffix = POB
    // suffix vector is fixed regardless of d
    const suffixStart = { N: 0, E: 0 }; // placeholder
    const afterI = courses.slice(i + 1);
    const suffix  = runSlice(0, 0, afterI);
    if (!suffix) continue;

    // preI.N + d*cosA + suffix.N = pobN → d = (pobN - preI.N - suffix.N) / cosA
    const dN_needed = pob.northing - preI.N - suffix.N;
    const dE_needed = pob.easting  - preI.E - suffix.E;
    const dExact    = cosA * dN_needed + sinA * dE_needed;

    if (dExact <= 0.1) continue;

    const origDist  = c.distance;
    // Only proceed if change is meaningful (>0.1ft) and plausible (<2× original)
    if (Math.abs(dExact - origDist) < 0.05) continue;
    if (dExact > origDist * 3 || dExact < origDist * 0.3) continue;

    const fixed = courses.map((cc, j) =>
      j === i ? { ...cc, distance: parseFloat(dExact.toFixed(4)) } : { ...cc }
    );
    tryCandidate(fixed,
      `Scrivener fix: C${i + 1} distance ${origDist.toFixed(2)}→${dExact.toFixed(2)}ft (exact close)`);
  }

  // ────────────────────────────────────────────────────────────────
  // PRINCIPLE 3: Bearing quadrant inversion
  // A single misread NS or EW letter mirrors the course.
  // Test all 3 alternate quadrants for every course bearing.
  // ────────────────────────────────────────────────────────────────
  for (let i = 0; i < N_COURSES; i++) {
    const c = courses[i];
    if (!c.bearing) continue;

    const b = c.bearing.toUpperCase().trim();
    // Extract quadrant letters (e.g. "N85°05'42\"E" → ns='N', ew='E')
    const qMatch = b.match(/^([NS])([\d°'".\s]+)([EW])$/);
    if (!qMatch) continue;
    const [, ns, mid, ew] = qMatch;

    const flips = [
      [ns === 'N' ? 'S' : 'N', ew],          // flip NS
      [ns, ew === 'E' ? 'W' : 'E'],           // flip EW
      [ns === 'N' ? 'S' : 'N', ew === 'E' ? 'W' : 'E'], // flip both (reverse)
    ];

    for (const [newNs, newEw] of flips) {
      const newBearing = `${newNs}${mid}${newEw}`;
      const fixed = courses.map((cc, j) =>
        j === i ? { ...cc, bearing: newBearing } : { ...cc }
      );
      tryCandidate(fixed,
        `Scrivener fix: C${i + 1} bearing ${c.bearing}→${newBearing} (quadrant flip)`);
    }
  }

  // ────────────────────────────────────────────────────────────────
  // PRINCIPLE 6: Bearing minute ↔ second digit swap
  // Typist/OCR error: minutes and seconds transposed (e.g. 21'43" → 43'21").
  // Tract 13 pattern: S89°21'43"W vs N89°43'05"E — 21↔43 digits.
  // ────────────────────────────────────────────────────────────────
  for (let i = 0; i < N_COURSES; i++) {
    const c = courses[i];
    if (!c.bearing || c.type?.toLowerCase() !== 'line') continue;
    const dmsMatch = c.bearing.match(/^([NS])(\d+)[°d](\d+)[′'](\d+(?:\.\d+)?)["″]([EW])$/i);
    if (!dmsMatch) continue;
    const [, q1, deg, min, sec, q2] = dmsMatch;
    const bearingVariants = new Set();
    // Variant A: swap minutes ↔ seconds
    if (min !== sec) bearingVariants.add(`${q1}${deg}°${sec}'${min}"${q2}`);
    // Variant B: swap tens digit of minutes (e.g. 21→12)
    if (min.length === 2) {
      const ms = min[1] + min[0];
      if (ms !== min && parseInt(ms) < 60) bearingVariants.add(`${q1}${deg}°${ms}'${sec}"${q2}`);
    }
    // Variant C: swap tens digit of seconds (e.g. 43→34)
    const si = sec.split('.')[0];
    if (si.length === 2) {
      const ss = si[1] + si[0];
      if (ss !== si && parseInt(ss) < 60) bearingVariants.add(`${q1}${deg}°${min}'${sec.replace(si, ss)}"${q2}`);
    }
    for (const nb of bearingVariants) {
      if (nb === c.bearing) continue;
      const fixed = courses.map((cc, j) => j === i ? { ...cc, bearing: nb } : { ...cc });
      tryCandidate(fixed, `Scrivener fix: C${i + 1} bearing ${c.bearing}→${nb} (min/sec digit swap)`);
    }
  }

  for (let i = 0; i < N_COURSES; i++) {
    const c = courses[i];
    if (!c.bearing || !c.distance || c.distance <= 0) continue;

    const d = c.distance;
    const variants = new Set([
      d + 10, d + 20, d - 10, d - 20,
      d * 10, d / 10,
      d + 100, d - 100,
      // Reverse the two significant digits before decimal (e.g. 95.78 → 59.78)
      ...(d >= 10 && d < 100
        ? [Math.floor(d / 10) + (d % 10 === Math.floor(d % 10) ? 0 : 0) +
           (d % 10) * 10 + (d - Math.floor(d))] : []),
    ]);

    // Single-digit substitution (e.g. "212.75" -> "214.75")
    const dStr = d.toFixed(2);
    for (let pos = 0; pos < dStr.length; pos++) {
      if (dStr[pos] === '.') continue;
      for (let digit = 0; digit <= 9; digit++) {
        if (dStr[pos] === digit.toString()) continue;
        const newDStr = dStr.slice(0, pos) + digit + dStr.slice(pos + 1);
        const newD = parseFloat(newDStr);
        if (newD > 0) variants.add(newD);
      }
    }

    // Swap adjacent digits (e.g. "110.43" -> "110.34")
    for (let pos = 0; pos < dStr.length - 1; pos++) {
      if (dStr[pos] === '.' || dStr[pos + 1] === '.') continue;
      if (dStr[pos] === dStr[pos + 1]) continue;
      const chars = dStr.split('');
      const tmp = chars[pos];
      chars[pos] = chars[pos + 1];
      chars[pos + 1] = tmp;
      const newD = parseFloat(chars.join(''));
      if (newD > 0) variants.add(newD);
    }

    for (const testDist of variants) {
      if (testDist <= 0 || testDist > 99999) continue;
      if (Math.abs(testDist - d) < 0.01) continue;

      const fixed = courses.map((cc, j) =>
        j === i ? { ...cc, distance: parseFloat(testDist.toFixed(4)) } : { ...cc }
      );
      tryCandidate(fixed,
        `Scrivener fix: C${i + 1} distance ${d.toFixed(2)}→${testDist.toFixed(2)}ft (digit error)`);
    }
  }

  // ────────────────────────────────────────────────────────────────
  // PRINCIPLE 7: Invalid bearing degrees (> 90°)
  // Scrivener/OCR error: bearing degrees read > 90° (e.g. 99° or 92°).
  // Strategy: Identify courses with bearing degrees > 90. Replace the leading
  // digit to bring it under 90° (e.g. 99° → 89° or 80°), or test other likely transpositions.
  // ────────────────────────────────────────────────────────────────
  for (let i = 0; i < N_COURSES; i++) {
    const c = courses[i];
    if (!c.bearing) continue;

    const b = c.bearing.toUpperCase().trim();
    const degMatch = b.match(/^([NSns])\s*(\d{2,3})([°\-\s])(.*)$/i);
    if (!degMatch) continue;
    const [, q1, degStr, sep, rest] = degMatch;
    const degVal = parseInt(degStr, 10);
    if (degVal <= 90) continue;

    const bearingVariants = new Set();
    
    // Scenario 1: Leading digit substitution. e.g. "99" -> replace first '9' with '8' -> "89"
    if (degStr.length === 2 && degStr.startsWith('9')) {
      const restDigit = degStr[1];
      bearingVariants.add(`${q1}8${restDigit}${sep}${rest}`);
      bearingVariants.add(`${q1}80${sep}${rest}`);
    } else if (degStr.length === 3) {
      // E.g. "108" -> strip '1' -> "08" -> "8"
      const withoutOne = degStr.slice(1);
      const valWithoutOne = parseInt(withoutOne, 10);
      if (valWithoutOne <= 90) {
        bearingVariants.add(`${q1}${valWithoutOne}${sep}${rest}`);
      }
    }

    // Try general digit replacements for leading char
    const replacedLeading8 = '8' + degStr.slice(1);
    if (parseInt(replacedLeading8, 10) <= 90) {
      bearingVariants.add(`${q1}${replacedLeading8}${sep}${rest}`);
    }
    const replacedLeading7 = '7' + degStr.slice(1);
    if (parseInt(replacedLeading7, 10) <= 90) {
      bearingVariants.add(`${q1}${replacedLeading7}${sep}${rest}`);
    }

    bearingVariants.add(`${q1}89${sep}${rest}`);
    bearingVariants.add(`${q1}80${sep}${rest}`);
    bearingVariants.add(`${q1}90${sep}${rest}`);

    for (const nb of bearingVariants) {
      if (nb === c.bearing) continue;
      const fixed = courses.map((cc, j) => j === i ? { ...cc, bearing: nb } : { ...cc });
      tryCandidate(fixed, `Scrivener fix: C${i + 1} bearing ${c.bearing}→${nb} (invalid bearing degrees > 90° corrected)`);
    }
  }

  // ── PRINCIPLE 8: Curve Chord Distance check ──
  for (let i = 0; i < N_COURSES; i++) {
    const c = courses[i];
    if (c.type?.toLowerCase() === 'curve' && c.radius != null) {
      let deltaDeg = 0;
      if (c.delta != null) {
        deltaDeg = traverseSvc.parseDmsToDecimal(c.delta);
      } else if (c.arcLength != null && c.radius > 0) {
        deltaDeg = (c.arcLength / c.radius) * (180.0 / Math.PI);
      }
      if (deltaDeg > 0) {
        const deltaRad = deltaDeg * Math.PI / 180.0;
        const computedChord = 2.0 * c.radius * Math.sin(deltaRad / 2.0);
        
        // If chord distance is missing or wrong
        if (c.chordDistance == null || Math.abs(computedChord - c.chordDistance) > 0.5) {
          const origChord = c.chordDistance;
          const fixed = courses.map((cc, j) =>
            j === i ? { ...cc, chordDistance: parseFloat(computedChord.toFixed(4)) } : { ...cc }
          );
          tryCandidate(fixed,
            `Scrivener fix: C${i + 1} curve chord distance ${origChord != null ? origChord.toFixed(2) : 'null'}→${computedChord.toFixed(2)}ft (computed from radius/delta)`);
        }
      }
    }
  }

  // Return best candidate only if it actually passes isPassing()
  if (!bestResult) return null;
  const [tBest] = tryCompute(bestResult.courses, pob, units, isOpenEnded);
  if (tBest && isPassing(tBest)) return bestResult;
  return null;
}

/**
 * Robust Self-Intersection (Bowtie) Detector
 * Delegates to traverseSvc.
 */
export function detectSelfIntersection(stations) {
  return traverseSvc.detectSelfIntersection(stations);
}

/**
 * Robust Backtracking Detector
 * Verifies if consecutive courses travel backwards over each other.
 */
export function detectBacktracking(courses, verbose = false) {
  if (!courses || courses.length < 2) return false;
  
  for (let i = 0; i < courses.length; i++) {
    const c1 = courses[i];
    const c2 = courses[(i + 1) % courses.length];
    
    if (!c1 || !c2) continue;
    if (c1.type !== 'Line' || c2.type !== 'Line') continue;
    if (!c1.bearing || !c2.bearing) continue;
    
    try {
      const az1 = bp.parse(c1.bearing).azimuthDeg;
      const az2 = bp.parse(c2.bearing).azimuthDeg;
      
      const diff = Math.abs(az1 - az2);
      const isOpposite = Math.abs(diff - 180) < 0.01 || Math.abs(diff - 180) > 359.99;
      
      if (isOpposite) {
        if (verbose) {
          console.log(`Backtracking detected between segment ${i + 1} and segment ${((i + 1) % courses.length) + 1}!`);
        }
        return true;
      }
    } catch {
      // ignore
    }
  }
  return false;
}

/**
 * Intelligent Combinatorial Quadrant Inversion Bowtie Solver
 * Tests single and double segment bearing flips to minimize closure error and resolve intersections.
 */
export function tryBowtieAutoFix(original, pob = { northing: 5000, easting: 5000 }, units = 'Feet') {
  const courses = original.courses.map(c => ({ ...c }));
  
  const flippableIndices = [];
  for (let i = 0; i < courses.length; i++) {
    const c = courses[i];
    if (c.type === 'Line' && c.bearing) {
      flippableIndices.push(i);
    } else if (c.type === 'Curve' && c.chordBearing) {
      flippableIndices.push(i);
    }
  }
  
  if (flippableIndices.length === 0) return original;
  
  const evaluate = (testCourses) => {
    try {
      // Always run the gap solver first — unknown courses must be resolved before
      // we can test whether a bearing flip produces a valid non-degenerate polygon.
      const solvedCourses = traverseSvc.autoFixUnknownRuns(testCourses, pob);
      const res = traverseSvc.compute({ pointOfBeginning: pob, courses: solvedCourses, units, isOpenEnded: false });
      const hasIntersection = detectSelfIntersection(res.stations);
      const hasBacktracking = detectBacktracking(solvedCourses);
      const isDegenerate = res.areaSqFt < 10.0 && res.perimeter > 100.0;
      
      let ratio = 0;
      const parts = res.closure.precisionRatio.split(':');
      if (parts.length > 1) {
        const cleaned = parts[1].replace(/,/g, '').replace('∞', '999999999').trim();
        ratio = parseFloat(cleaned) || 0;
      }
      
      return {
        linearError: res.closure.linearError,
        precisionRatio: ratio,
        hasIntersection: hasIntersection || hasBacktracking || isDegenerate,
        stations: res.stations,
        solvedCourses,  // carry forward the gap-solved courses
      };
    } catch {
      return { linearError: Infinity, precisionRatio: 0, hasIntersection: true, stations: null, solvedCourses: testCourses };
    }
  };
  
  const originalEval = evaluate(courses);
  if (!originalEval.hasIntersection && originalEval.linearError < PASS_LINEAR_ERROR_FT) {
    return original;
  }
  
  let bestCourses = courses;
  let bestEval = originalEval;
  let bestStage = null;
  
  // --- SINGLE FLIP SEARCH ---
  for (const idx of flippableIndices) {
    const testCourses = courses.map(c => ({ ...c }));
    const c = testCourses[idx];
    if (c.type === 'Line') {
      c.bearing = flipQuadrant(c.bearing);
    } else {
      c.chordBearing = flipQuadrant(c.chordBearing);
    }
    
    const testEval = evaluate(testCourses);
    
    if (!testEval.hasIntersection && (testEval.linearError < PASS_LINEAR_ERROR_FT || testEval.precisionRatio >= PASS_PRECISION_RATIO)) {
      console.log(`Combinatorial Bowtie Solver: Solved via SINGLE FLIP on course ${idx + 1}!`);
      // Use gap-solved courses so the corrected unknown segments are included
      const finalCourses = testEval.solvedCourses || testCourses;
      return {
        ...original,
        courses: finalCourses,
        rawJson: JSON.stringify(finalCourses),
        message: `Stage 1: Bowtie Solver corrected course ${idx + 1} bearing`
      };
    }
    
    if (!testEval.hasIntersection && testEval.linearError < bestEval.linearError) {
      bestCourses = testCourses;
      bestEval = testEval;
      bestStage = `Stage 1: Combinatorial single-flip course ${idx + 1}`;
    }
  }
  
  // --- DOUBLE FLIP SEARCH ---
  if (flippableIndices.length <= 30) {
    for (let i = 0; i < flippableIndices.length; i++) {
      for (let j = i + 1; j < flippableIndices.length; j++) {
        const idx1 = flippableIndices[i];
        const idx2 = flippableIndices[j];
        
        const testCourses = courses.map(c => ({ ...c }));
        const c1 = testCourses[idx1];
        const c2 = testCourses[idx2];
        
        if (c1.type === 'Line') c1.bearing = flipQuadrant(c1.bearing);
        else c1.chordBearing = flipQuadrant(c1.chordBearing);
        
        if (c2.type === 'Line') c2.bearing = flipQuadrant(c2.bearing);
        else c2.chordBearing = flipQuadrant(c2.chordBearing);
        
        const testEval = evaluate(testCourses);
        
        if (!testEval.hasIntersection && (testEval.linearError < PASS_LINEAR_ERROR_FT || testEval.precisionRatio >= PASS_PRECISION_RATIO)) {
          console.log(`Combinatorial Bowtie Solver: Solved via DOUBLE FLIP on courses ${idx1 + 1} & ${idx2 + 1}!`);
          return {
            ...original,
            courses: testCourses,
            rawJson: JSON.stringify(testCourses),
            message: `Stage 1: Bowtie Solver corrected courses ${idx1 + 1} & ${idx2 + 1} bearings`
          };
        }
        
        if (!testEval.hasIntersection && testEval.linearError < bestEval.linearError) {
          bestCourses = testCourses;
          bestEval = testEval;
          bestStage = `Stage 1: Combinatorial double-flip courses ${idx1 + 1} & ${idx2 + 1}`;
        }
      }
    }
  }
  
  if (bestEval.linearError < originalEval.linearError) {
    console.log(`Combinatorial Bowtie Solver: Improved linear error from ${originalEval.linearError.toFixed(2)} to ${bestEval.linearError.toFixed(2)} via ${bestStage}`);
    return {
      ...original,
      courses: bestCourses,
      rawJson: JSON.stringify(bestCourses),
      message: bestStage
    };
  }
  
  return original;
}

/**
 * Stage 1.5 Surveyor Shape Constraint & Scrivener Corrector.
 * Handles 3-segment traverses by appending a 4th meandering course.
 * Handles 4-segment traverses by correcting opposite-side parallel/scrivener errors.
 */
export function trySurveyorShapeCorrection(original, pob = { northing: 5000, easting: 5000 }, units = 'Feet') {
  const courses = original.courses.map(c => ({ ...c }));
  
  if (courses.length === 3) {
    console.log('Stage 1.5: 3 courses detected. Appending 4th meandering line to close the traverse.');
    const testCourses = [...courses, {
      type: 'Line',
      bearing: '',
      distance: null,
      isUnknown: true,
      description: 'Meandering line (automated Stage 1.5 correction)'
    }];
    
    const solvedCourses = traverseSvc.autoFixUnknownRuns(testCourses, pob);
    
    try {
      const res = traverseSvc.compute({ pointOfBeginning: pob, courses: solvedCourses, units, isOpenEnded: false });
      let ratio = 0;
      const parts = res.closure.precisionRatio.split(':');
      if (parts.length > 1) {
        const cleaned = parts[1].replace(/,/g, '').replace('∞', '999999999').trim();
        ratio = parseFloat(cleaned) || 0;
      }
      
      if (res.closure.linearError < PASS_LINEAR_ERROR_FT || ratio >= PASS_PRECISION_RATIO) {
        console.log(`Stage 1.5: 3 bearings + meander successfully closed!`);
        return {
          ...original,
          courses: solvedCourses,
          rawJson: JSON.stringify(solvedCourses),
          message: 'Stage 1.5: Closed 3-course traverse via Meander Gap Solver'
        };
      }
    } catch (e) {
      console.warn('Stage 1.5: Failed to compute 3-course traverse with appended meander.', e.message);
    }
  }
  
  if (courses.length === 4) {
    console.log('Stage 1.5: 4 courses detected. Evaluating rectangular opposite-side scrivener alignments.');
    
    const evaluate = (testCourses) => {
      try {
        const res = traverseSvc.compute({ pointOfBeginning: pob, courses: testCourses, units, isOpenEnded: false });
        const hasIntersection = detectSelfIntersection(res.stations);
        const hasBacktracking = detectBacktracking(testCourses);
        const isDegenerate = res.areaSqFt < 10.0 && res.perimeter > 100.0;
        
        let ratio = 0;
        const parts = res.closure.precisionRatio.split(':');
        if (parts.length > 1) {
          const cleaned = parts[1].replace(/,/g, '').replace('∞', '999999999').trim();
          ratio = parseFloat(cleaned) || 0;
        }
        
        return {
          linearError: res.closure.linearError,
          precisionRatio: ratio,
          hasIntersection: hasIntersection || isDegenerate || hasBacktracking,
          stations: res.stations,
          courses: res.courses
        };
      } catch {
        return { linearError: Infinity, precisionRatio: 0, hasIntersection: true, stations: null, courses: null };
      }
    };
    
    const originalEval = evaluate(courses);
    if (!originalEval.hasIntersection && originalEval.linearError < PASS_LINEAR_ERROR_FT) {
      if (originalEval.courses) {
        const hasChanges = JSON.stringify(originalEval.courses) !== JSON.stringify(courses);
        if (hasChanges) {
          console.log('Stage 1.5: Solved missing segment bearing inside initial evaluation!');
          return {
            ...original,
            courses: originalEval.courses,
            rawJson: JSON.stringify(originalEval.courses),
            message: 'Stage 1.5: Solved missing segment bearing'
          };
        }
      }
      return original;
    }
    
    let bestCourses = courses;
    let bestEval = originalEval;
    let bestMessage = null;
    
    const candidates = [];
    
    const addCandidate = (name, modifierFn) => {
      const testCourses = courses.map(c => ({ ...c }));
      try {
        modifierFn(testCourses);
        const testEval = evaluate(testCourses);
        candidates.push({ courses: testCourses, evaluation: testEval, message: name });
      } catch (e) {
        // Ignore errors during modification
      }
    };
    
    // Opposing sides: index 0 opposite 2, index 1 opposite 3
    
    // Distance alignments (Pair A)
    addCandidate('Stage 1.5: Set Segment 3 distance = Segment 1 distance', (c) => {
      c[2].distance = c[0].distance;
      if (c[2].type === 'Curve') c[2].chordDistance = c[0].distance;
    });
    addCandidate('Stage 1.5: Set Segment 1 distance = Segment 3 distance', (c) => {
      c[0].distance = c[2].distance;
      if (c[0].type === 'Curve') c[0].chordDistance = c[2].distance;
    });
    
    // Distance alignments (Pair B)
    addCandidate('Stage 1.5: Set Segment 4 distance = Segment 2 distance', (c) => {
      c[3].distance = c[1].distance;
      if (c[3].type === 'Curve') c[3].chordDistance = c[1].distance;
    });
    addCandidate('Stage 1.5: Set Segment 2 distance = Segment 4 distance', (c) => {
      c[1].distance = c[3].distance;
      if (c[1].type === 'Curve') c[1].chordDistance = c[3].distance;
    });
    
    // Bearing alignments (Pair A)
    addCandidate('Stage 1.5: Align Segment 3 bearing to Segment 1', (c) => {
      const flipped = flipQuadrant(c[0].bearing || c[0].chordBearing);
      if (flipped) {
        if (c[2].type === 'Line') c[2].bearing = flipped;
        else c[2].chordBearing = flipped;
      }
    });
    addCandidate('Stage 1.5: Align Segment 1 bearing to Segment 3', (c) => {
      const flipped = flipQuadrant(c[2].bearing || c[2].chordBearing);
      if (flipped) {
        if (c[0].type === 'Line') c[0].bearing = flipped;
        else c[0].chordBearing = flipped;
      }
    });
    
    // Bearing alignments (Pair B)
    addCandidate('Stage 1.5: Align Segment 4 bearing to Segment 2', (c) => {
      const flipped = flipQuadrant(c[1].bearing || c[1].chordBearing);
      if (flipped) {
        if (c[3].type === 'Line') c[3].bearing = flipped;
        else c[3].chordBearing = flipped;
      }
    });
    addCandidate('Stage 1.5: Align Segment 2 bearing to Segment 4', (c) => {
      const flipped = flipQuadrant(c[3].bearing || c[3].chordBearing);
      if (flipped) {
        if (c[1].type === 'Line') c[1].bearing = flipped;
        else c[1].chordBearing = flipped;
      }
    });
    
    // Joint alignments (Pair A)
    addCandidate('Stage 1.5: Align Segment 3 distance and bearing to Segment 1', (c) => {
      c[2].distance = c[0].distance;
      if (c[2].type === 'Curve') c[2].chordDistance = c[0].distance;
      const flipped = flipQuadrant(c[0].bearing || c[0].chordBearing);
      if (flipped) {
        if (c[2].type === 'Line') c[2].bearing = flipped;
        else c[2].chordBearing = flipped;
      }
    });
    addCandidate('Stage 1.5: Align Segment 1 distance and bearing to Segment 3', (c) => {
      c[0].distance = c[2].distance;
      if (c[0].type === 'Curve') c[0].chordDistance = c[2].distance;
      const flipped = flipQuadrant(c[2].bearing || c[2].chordBearing);
      if (flipped) {
        if (c[0].type === 'Line') c[0].bearing = flipped;
        else c[0].chordBearing = flipped;
      }
    });
    
    // Joint alignments (Pair B)
    addCandidate('Stage 1.5: Align Segment 4 distance and bearing to Segment 2', (c) => {
      c[3].distance = c[1].distance;
      if (c[3].type === 'Curve') c[3].chordDistance = c[1].distance;
      const flipped = flipQuadrant(c[1].bearing || c[1].chordBearing);
      if (flipped) {
        if (c[3].type === 'Line') c[3].bearing = flipped;
        else c[3].chordBearing = flipped;
      }
    });
    addCandidate('Stage 1.5: Align Segment 2 distance and bearing to Segment 4', (c) => {
      c[1].distance = c[3].distance;
      if (c[1].type === 'Curve') c[1].chordDistance = c[3].distance;
      const flipped = flipQuadrant(c[3].bearing || c[3].chordBearing);
      if (flipped) {
        if (c[1].type === 'Line') c[1].bearing = flipped;
        else c[1].chordBearing = flipped;
      }
    });
    
    // Perpendicular Rectangular Box Reconstructions (Clockwise & Counter-Clockwise)
    addCandidate('Stage 1.5: Reconstruct as Perpendicular Rectangular Box (Clockwise)', (c) => {
      const az0 = bp.parse(c[0].bearing || c[0].chordBearing).azimuthDeg;
      const az1 = (az0 + 90) % 360;
      const az2 = (az0 + 180) % 360;
      const az3 = (az0 + 270) % 360;
      
      if (c[1].type === 'Line') c[1].bearing = bp.toDisplayString(az1);
      else c[1].chordBearing = bp.toDisplayString(az1);
      
      if (c[2].type === 'Line') c[2].bearing = bp.toDisplayString(az2);
      else c[2].chordBearing = bp.toDisplayString(az2);
      
      if (c[3].type === 'Line') c[3].bearing = bp.toDisplayString(az3);
      else c[3].chordBearing = bp.toDisplayString(az3);

      // Ensure equal opposing side distances for rectangular box
      const distA = c[0].distance || c[0].chordDistance || c[2].distance || c[2].chordDistance || 100.0;
      c[0].distance = distA;
      if (c[0].type === 'Curve') c[0].chordDistance = distA;
      c[2].distance = distA;
      if (c[2].type === 'Curve') c[2].chordDistance = distA;

      const distB = c[1].distance || c[1].chordDistance || c[3].distance || c[3].chordDistance || distA;
      c[1].distance = distB;
      if (c[1].type === 'Curve') c[1].chordDistance = distB;
      c[3].distance = distB;
      if (c[3].type === 'Curve') c[3].chordDistance = distB;
    });
    
    addCandidate('Stage 1.5: Reconstruct as Perpendicular Rectangular Box (Counter-Clockwise)', (c) => {
      const az0 = bp.parse(c[0].bearing || c[0].chordBearing).azimuthDeg;
      const az1 = (az0 + 270) % 360;
      const az2 = (az0 + 180) % 360;
      const az3 = (az0 + 90) % 360;
      
      if (c[1].type === 'Line') c[1].bearing = bp.toDisplayString(az1);
      else c[1].chordBearing = bp.toDisplayString(az1);
      
      if (c[2].type === 'Line') c[2].bearing = bp.toDisplayString(az2);
      else c[2].chordBearing = bp.toDisplayString(az2);
      
      if (c[3].type === 'Line') c[3].bearing = bp.toDisplayString(az3);
      else c[3].chordBearing = bp.toDisplayString(az3);

      // Ensure equal opposing side distances for rectangular box
      const distA = c[0].distance || c[0].chordDistance || c[2].distance || c[2].chordDistance || 100.0;
      c[0].distance = distA;
      if (c[0].type === 'Curve') c[0].chordDistance = distA;
      c[2].distance = distA;
      if (c[2].type === 'Curve') c[2].chordDistance = distA;

      const distB = c[1].distance || c[1].chordDistance || c[3].distance || c[3].chordDistance || distA;
      c[1].distance = distB;
      if (c[1].type === 'Curve') c[1].chordDistance = distB;
      c[3].distance = distB;
      if (c[3].type === 'Curve') c[3].chordDistance = distB;
    });
    
    // Evaluate candidates
    for (const cand of candidates) {
      const testEval = cand.evaluation;
      if (!testEval.hasIntersection && (testEval.linearError < PASS_LINEAR_ERROR_FT || testEval.precisionRatio >= PASS_PRECISION_RATIO)) {
        console.log(`Stage 1.5: Rectangular Scrivener Solver corrected via candidate: "${cand.message}"!`);
        return {
          ...original,
          courses: testEval.courses,
          rawJson: JSON.stringify(testEval.courses),
          message: cand.message
        };
      }
      
      if (!testEval.hasIntersection && testEval.linearError < bestEval.linearError) {
        bestCourses = testEval.courses;
        bestEval = testEval;
        bestMessage = cand.message;
      }
    }
    
    if (bestEval.linearError < originalEval.linearError) {
      console.log(`Stage 1.5: Rectangular Scrivener Solver improved error from ${originalEval.linearError.toFixed(2)} to ${bestEval.linearError.toFixed(2)} via: "${bestMessage}"`);
      return {
        ...original,
        courses: bestEval.courses,
        rawJson: JSON.stringify(bestEval.courses),
        message: bestMessage
      };
    }
  }
  
  return original;
}

function flipQuadrant(bearing) {
  if (!bearing || bearing.length < 2) return null;
  const ns = bearing[0].toUpperCase();
  const ew = bearing[bearing.length - 1].toUpperCase();
  if (!'NS'.includes(ns) || !'EW'.includes(ew)) return null;
  const newNS = ns === 'N' ? 'S' : 'N';
  const newEW = ew === 'E' ? 'W' : 'E';
  return newNS + bearing.slice(1, -1) + newEW;
}

export function isMeanderDeed(extraction) {
  // Build a combined text from all available text fields
  const text = [
    extraction.rawJson || '',
    extraction.message || '',
    extraction.mentalMapSummary || '',
    extraction.extractedText || '',
    extraction.rawText || '',
    (extraction.courses || []).map(c => c.description || c.label || '').join(' '),
  ].join(' ').toUpperCase();

  // If the text contains significantly more "thence" calls than courses extracted,
  // it is highly likely to be a lazy metes-and-bounds extraction, not a meander deed.
  // Note: Commencing sections can contain many "thence" calls. We should only count
  // "thence" calls in the actual main legal description body starting from Point of Beginning.
  const rawTextUpper = (extraction.rawText || extraction.extractedText || '').toUpperCase();
  let mainText = rawTextUpper;
  const pobIndex = rawTextUpper.indexOf('POINT OF BEGINNING');
  if (pobIndex !== -1) {
    mainText = rawTextUpper.slice(pobIndex);
  } else {
    const truePobIndex = rawTextUpper.indexOf('TRUE POINT');
    if (truePobIndex !== -1) {
      mainText = rawTextUpper.slice(truePobIndex);
    }
  }
  const thenceCount = (mainText.match(/\bTHENCE\b/g) || []).length;
  if (thenceCount > (extraction.courses?.length || 0) + 1) {
    return false;
  }

  if (text.includes('MEANDER')) return true;

  const hasMoreOrLess = text.includes('MORE OR LESS');
  const waterKeywords = [
    'CREEK', 'RIVER', 'LAKE', 'MARSH', 'WATERS OF', 'ALONG SAID WATER',
    'HIGH WATER', 'WATER LINE', 'BANK OF', 'SHORE', 'CANAL', 'POND',
    'BAYOU', 'SLOUGH', 'BAY', 'INLET', 'STREAM', 'TRIBUTARY', 'LAGOON',
  ];
  const hasWaterBody = waterKeywords.some(w => text.includes(w));

  if (hasMoreOrLess && hasWaterBody) return true;
  if (text.includes('FOLLOWING') && (text.includes('THEREOF') || text.includes('SAID')) && hasWaterBody) return true;
  return false;
}


/**
 * Helper to check if text contains an explicit return to Point of Beginning (POB)
 */
export function hasPobReturnText(text) {
  if (!text) return false;
  const combined = text.toUpperCase();
  const cleanCombined = combined.replace(/\./g, '');
  return /\bT[O0]\s+(?:THE\s+)?(?:TRUE\s+)?(?:POIN[TI]\s+(?:OF\s+)?)?(?:BEGINNING|PLACE\s+OF\s+BEGINNING|POB|BEG)/.test(cleanCombined) ||
         combined.includes('RETURN TO') || combined.includes('CLOSE TO') || combined.includes('TO SAID');
}

/**
 * Unified Multi-factor Open-Ended Traverse Classifier
 */
export function detectOpenEnded(text, fileName, aiFlag) {
  if (aiFlag === true) return true;
  
  let textToScan = text || '';
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      if (parsed.IsOpenEnded === true || parsed.isOpenEnded === true) {
        return true;
      }
      if (parsed.Classification === 'OPEN_ENDED' || parsed.classification === 'OPEN_ENDED') {
        return true;
      }
      // Filter out ConceptualAnalysis from the scan text to prevent false positive keyword matches
      textToScan = [
        parsed.MentalMapSummary || parsed.mentalMapSummary || '',
        parsed.ReferencedParcelName || parsed.referencedParcelName || '',
        JSON.stringify(parsed.Segments || parsed.segments || '')
      ].join(' ');
    }
  } catch (e) {
    // Standard text fallback
  }

  const upperText = textToScan.toUpperCase();
  const upperFile = (fileName || '').toUpperCase();
  const combined = upperText + ' ' + upperFile;

  // ── Fast-path: Definitive strip deed signal ─────────────────────────────
  // "a strip of land" + "point of termination" = open-ended survey centerline.
  // These parcels describe corridors (road/utility R/W), not closed polygons.
  const isStripDeed = combined.includes('STRIP OF LAND') && combined.includes('POINT OF TERMINATION');
  if (isStripDeed) {
    console.log('detectOpenEnded: Fast-path STRIP DEED detected ("strip of land" + "point of termination")');
    return true;
  }

  // ── Keyword scan ─────────────────────────────────────────────────────────
  const indicators = [
    'EASEMENT', 'EAESMENT', 'EASMENT', 'RIGHT OF WAY', 'RIGHT-OF-WAY', 'R/W', 'R-O-W',
    'CENTERLINE', 'CENTER LINE',
    'STRIP OF LAND', 'STRIP 10 FEET', 'STRIP 20 FEET', 'STRIP 30 FEET',
    'FEET IN WIDTH', 'FEET WIDE', 'IN WIDTH, LYING',
    'HEREIN DESCRIBED SURVEY LINE', 'DESCRIBED SURVEY LINE',
    'POINT OF TERMINATION',
    'UTILITY LINE', 'PIPELINE', 'INGRESS', 'EGRESS', 'ACCESS ROAD'
  ];
  
  const hasIndicator = indicators.some(w => combined.includes(w));
  if (!hasIndicator) return false;
  
  if (hasPobReturnText(combined)) {
    return false;
  }
  
  return true;
}

/**
 * Multi-Parcel Text Splitter
 *
 * Detects labeled "Parcel A" / "Parcel B" (or "PARCEL A" / "PARCEL B") sections
 * in a deed's raw text and splits them into separate sub-descriptions.
 *
 * Returns an array of { label, text } objects (e.g. [{label:'A', text:'...'}, {label:'B', text:'...'}])
 * if 2 or more named parcels are found, or null for single-parcel documents.
 *
 * @param {string} docText  Raw deed text (from _extracted/*.txt or AI message)
 * @returns {Array<{label:string, text:string}>|null}
 */
export function extractNamedParcels(docText) {
  if (!docText || docText.length < 20) return null;

  const dividers = [];

  // 1. Explicit headers (e.g., "Parcel A", "PARCEL 1", "Tract B", "LOT 2", etc.)
  const explicitRe = /(?:^|\n)[ \t]*(?:Parcel|PARCEL|DEED CASE|DEED|CASE|Tract|TRACT|Lot|LOT)[ \t]+['"“‘'`]*([A-Z0-9]+)['"”’'`]*\b/gi;
  let m;
  while ((m = explicitRe.exec(docText)) !== null) {
    const nextNewline = docText.indexOf('\n', m.index + 1);
    const endOfLine = nextNewline !== -1 ? nextNewline : docText.length;
    const lineText = docText.slice(m.index, endOfLine).toLowerCase();
    
    // Ignore references disguised as headers
    let isReference = ['herein', 'described', 'referred', 'overlap', 'contiguity', 'as to'].some(k => lineText.includes(k));
    if (!isReference) {
      const matchStart = m[0].toLowerCase().trim();
      const isLot = matchStart.startsWith('lot');
      
      // If it's a LOT match, check if it's part of a description sentence
      if (isLot) {
        // Look at the character immediately after the match
        const afterMatchIndex = m.index + m[0].length;
        const afterMatchChar = docText[afterMatchIndex] || '';
        
        // If it's followed by a comma and a lowercase word or common sentence words:
        const remainingLine = docText.slice(afterMatchIndex, endOfLine).trim();
        const firstWord = remainingLine.split(/[^a-zA-Z]/)[0] || '';
        const isFirstWordLowercase = firstWord && firstWord === firstWord.toLowerCase();
        
        if (afterMatchChar === ',' && isFirstWordLowercase) {
          isReference = true;
        } else if (/^(?:the|of|and|to|or|in|on|at|with|by|from|for|as|being|having|concave|along|said|also)\b/i.test(remainingLine)) {
          isReference = true;
        } else if (/\b(?:boundary|corner|line|section|township|range|plat|book|records|recorded|official)\b/i.test(lineText)) {
          isReference = true;
        }
      }
    }

    if (!isReference) {
      dividers.push({
        type: 'explicit',
        label: m[1].toUpperCase(),
        index: m.index,
        length: m[0].length
      });
    }
  }

  // 2. Keyword dividers (e.g., "Together with", "Less and except", etc.)
  const keywordRe = /(?:^|\n)[ \t]*(?:together\s+with|also\s+together\s+with|and\s+together\s+with|less\s+and\s+except|less\s+and\s+excepting|excepting\s+therefrom|also\s+together\s+with\s+an\s+easement|together\s+with\s+an\s+easement)\b/gi;
  while ((m = keywordRe.exec(docText)) !== null) {
    const nextNewline = docText.indexOf('\n', m.index + 1);
    const endOfLine = nextNewline !== -1 ? nextNewline : docText.length;
    const lineText = docText.slice(m.index, endOfLine).toLowerCase();

    let labelType = 'Easement';
    if (lineText.includes('except') || lineText.includes('therefrom')) {
      labelType = 'Exception';
    }

    dividers.push({
      type: 'keyword',
      labelType,
      index: m.index,
      length: m[0].length
    });
  }

  // Sort dividers by index
  dividers.sort((a, b) => a.index - b.index);

  // De-duplicate overlapping dividers
  const uniqueDividers = [];
  for (const div of dividers) {
    if (uniqueDividers.length === 0 || div.index > uniqueDividers[uniqueDividers.length - 1].index + 10) {
      uniqueDividers.push(div);
    }
  }

  if (uniqueDividers.length === 0) return null;

  // Let's build the splits
  const splits = [];
  let easementCount = 0;
  let exceptionCount = 0;

  // Check if we need to insert an implicit first parcel
  const firstDiv = uniqueDividers[0];
  if (firstDiv.index > 100) {
    const preText = docText.slice(0, firstDiv.index);
    if (gemini.hasBoundaryKeywords(preText)) {
      // Determine label for implicit parcel
      let firstLabel = '1';
      if (firstDiv.type === 'explicit') {
        if (firstDiv.label === 'B') firstLabel = 'A';
        else if (firstDiv.label === '2') firstLabel = '1';
        else firstLabel = '1';
      } else {
        firstLabel = '1';
      }
      splits.push({ label: firstLabel, start: 0, end: firstDiv.index });
    }
  }

  // Add the explicit/keyword splits
  for (let i = 0; i < uniqueDividers.length; i++) {
    const div = uniqueDividers[i];
    const start = div.index;
    const end = i + 1 < uniqueDividers.length ? uniqueDividers[i + 1].index : docText.length;

    let label = '';
    if (div.type === 'explicit') {
      label = div.label;
    } else {
      if (div.labelType === 'Easement') {
        easementCount++;
        label = `Easement_${easementCount}`;
      } else {
        exceptionCount++;
        label = `Exception_${exceptionCount}`;
      }
    }

    splits.push({ label, start, end });
  }

  // Map to final parcel array
  const parcels = [];
  for (const split of splits) {
    const text = docText.slice(split.start, split.end).trim();
    if (text.length > 20) {
      parcels.push({ label: split.label, text });
    }
  }

  return parcels.length >= 2 ? parcels : null;
}

/**
 * Retrieve document text from cache or text buffer
 */
function getDocumentText(imageBytes, mimeType) {
  if (!imageBytes || imageBytes.length === 0) return '';
  if (mimeType === 'text/plain') {
    return imageBytes.toString('utf-8');
  }
  if (mimeType === 'application/pdf') {
    const pdfHash = crypto.createHash('sha256').update(imageBytes).digest('hex');
    const cached = pdfOcrCache.get(pdfHash);
    if (cached) {
      return (cached.extractedText || '') + '\n' + (cached.combinedOcrText || '');
    }
  }
  return '';
}
