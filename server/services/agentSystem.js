// ─── Hierarchical Multi-Agent System ─────────────────────────────────────────
// Implements a turn-based dialogue loop between Extractor, COGO, and Surveyor agents.

import * as gemini from './geminiVision.js';
import * as traverseSvc from './traverse.js';
import * as bp from './bearingParser.js';
import { tryBowtieAutoFix, trySurveyorShapeCorrection, detectBacktracking, isMeanderDeed, tryScrivenerErrorSolver, applyCompassRuleIfEligible } from './repair.js';

/**
 * Rec 3 helper — produce up to 3 course-set variants by flipping the bearing
 * of a single identified bust course (N↔S, E↔W, both).
 * Caller tests each variant for closure.
 */
function _targetedBearingFlipVariants(courses, bustIdx) {
  const b = courses[bustIdx];
  if (!b?.bearing) return [];
  const bearing = b.bearing;
  const variants = [];

  // N↔S flip
  const ns = bearing.startsWith('N') ? bearing.replace(/^N/, 'S') : bearing.replace(/^S/, 'N');
  // E↔W flip
  const ew = bearing.endsWith('E') ? bearing.replace(/E$/, 'W') : bearing.replace(/W$/, 'E');
  // Both
  const both = ns.endsWith('E') ? ns.replace(/E$/, 'W') : ns.replace(/W$/, 'E');

  for (const flippedBearing of [ns, ew, both]) {
    if (flippedBearing !== bearing) {
      variants.push(courses.map((c, i) => i === bustIdx ? { ...c, bearing: flippedBearing } : c));
    }
  }
  return variants;
}


/**
 * Extraction Agent: Ingests documents and parses them into structured JSON.
 * Supports targeted, context-aware visual re-reading of specific segment coordinates.
 */
export class ExtractionAgent {
  constructor(model = null) {
    this.name = 'Extraction Agent (NLP & Vision)';
    this.model = model;
  }

  async extract(buffer, mimeType, feedback = null) {
    console.log(`[${this.name}] Starting visual extraction. Feedback present: ${!!feedback}`);
    const result = await gemini.extractBoundary(buffer, mimeType, feedback);
    return result;
  }
}

/**
 * COGO Agent: Pure Coordinate Geometry trigonometry engine.
 * Computes loops, closure errors, areas, and solves meander gaps.
 */
export class CogoAgent {
  constructor() {
    this.name = 'COGO Agent (Coordinate Geometry)';
  }

  analyze(courses, pointOfBeginning = { northing: 5000, easting: 5000 }, units = 'Feet', isOpenEnded = false) {
    console.log(`[${this.name}] Computing traverse for ${courses.length} courses...`);
    try {
      const result = traverseSvc.compute({
        pointOfBeginning,
        courses,
        units,
        isOpenEnded
      });
      
      const linearError = result.closure?.linearError || 0;
      const precisionRatio = result.closure?.precisionRatio || '1:0';
      
      // Parse precision number for threshold check
      let precisionVal = 0;
      if (precisionRatio.includes(':')) {
        // Handle '1:∞ (Perfect)' and plain '1:∞' — strip everything after the ratio number
        const cleaned = precisionRatio.split(':')[1].replace(/,/g, '').replace(/[∞∞]/g, '999999999').replace(/\s*\(.*\)/, '').trim();
        precisionVal = parseFloat(cleaned) || 0;
      }

      // Rec 1: linearError === 0 must always pass regardless of precisionVal parsing
      let isPassing = isOpenEnded || linearError === 0 || linearError < 0.30 || precisionVal >= 10000;
      let finalResult = result;
      if (!isPassing) {
        const adjusted = applyCompassRuleIfEligible(result);
        if (adjusted.compassRuleApplied) {
          finalResult = adjusted;
          isPassing = true;
        }
      }
      
      const finalLinearError = finalResult.closure?.linearError || 0;
      const finalPrecisionRatio = finalResult.closure?.precisionRatio || '1:0';
      
      return {
        success: true,
        isPassing,
        linearError: finalLinearError,
        precisionRatio: finalPrecisionRatio,
        errorNorthing: finalResult.closure?.errorNorthing || 0,
        errorEasting: finalResult.closure?.errorEasting || 0,
        perimeter: finalResult.perimeter || 0,
        areaAcres: finalResult.areaAcres || 0,
        stations: finalResult.stations || [],
        adjustedStations: finalResult.adjustedStations || [],
        courses: finalResult.courses || []
      };
    } catch (err) {
      console.warn(`[${this.name}] Traverse analysis failed:`, err.message);
      return {
        success: false,
        isPassing: false,
        linearError: 999,
        errorMsg: err.message
      };
    }
  }

  solveUnknowns(courses, pointOfBeginning = { northing: 5000, easting: 5000 }) {
    console.log(`[${this.name}] Inverse Gap Solver invoked.`);
    return traverseSvc.autoFixUnknownRuns(courses, pointOfBeginning);
  }
}

/**
 * Legal Surveyor Agent: Applies boundary law, the Hierarchy of Evidence,
 * and vector dot-product misclosure diagnostics.
 * Now also leverages parseConfidence flags from bearingParser (Fix #4).
 */
export class LegalSurveyorAgent {
  constructor() {
    this.name = 'Legal Surveyor Agent';
  }

  diagnose(courses, cogoReport, pob = { northing: 5000, easting: 5000 }, units = 'Feet', extraction = null, isOpenEnded = false) {
    console.log(`[${this.name}] Diagnosing traverse misclosure of ${cogoReport.linearError.toFixed(4)} ft.`);
    const diagnoses = [];

    // 1. Hypothesis: 3-Side Meander Loop
    if (courses.length === 3) {
      const isMeander = extraction ? isMeanderDeed(extraction) : false;
      if (isMeander) {
        diagnoses.push({
          type: 'MEANDER_COMPLETION',
          confidence: 0.95,
          message: 'Exactly 3 lines exist. Suggest appending an automated 4th meandering closure segment.',
          apply: () => {
            const extended = [
              ...courses,
              { type: 'Line', bearing: '', distance: null, isUnknown: true, description: 'Meandering line (Agentic Stage 5)' }
            ];
            return traverseSvc.autoFixUnknownRuns(extended, pob);
          }
        });
      }
    }

    // 2. Hypothesis: 4-Course Rectangular alignment scrivener
    if (courses.length === 4) {
      diagnoses.push({
        type: 'RECTANGULAR_ALIGNMENT',
        confidence: 0.85,
        message: 'Exactly 4 courses detected. Evaluating rectangular coordinate alignments.',
        apply: () => {
          const corrected = trySurveyorShapeCorrection({ courses }, pob, units);
          return corrected?.courses || courses;
        }
      });
    }

    // 3. Hypothesis: Backtracking / Riddle Loop
    const hasBacktracking = detectBacktracking(courses);
    if (hasBacktracking) {
      diagnoses.push({
        type: 'BACKTRACK_CORRECTION',
        confidence: 0.90,
        message: 'Backtracking detected. Running box shape alignment corrector.',
        apply: () => {
          const corrected = trySurveyorShapeCorrection({ courses }, pob, units);
          return corrected?.courses || courses;
        }
      });
    }

    // 4. Hypothesis: Bowtie self-intersection
    diagnoses.push({
      type: 'BOWTIE_COMBINATORIAL_FLIP',
      confidence: 0.70,
      message: 'Evaluating combinatoric quadrant bearing flips (N <-> S, E <-> W).',
      apply: () => {
        const corrected = tryBowtieAutoFix({ courses }, pob, units);
        return corrected?.courses || courses;
      }
    });

    // 5. Hypothesis: Specific OCR Transcription Bust (Vector Dot-Product Projection)
    if (cogoReport.linearError > 0.30 && cogoReport.linearError < 500) {
      const errN = cogoReport.errorNorthing;
      const errE = cogoReport.errorEasting;
      const errMag = Math.sqrt(errN * errN + errE * errE);

      if (errMag > 1.0) {
        // Find segment most parallel/aligned with the error vector
        // Fix #4: LOW parseConfidence courses get a score boost as bust candidates
        const alignments = courses.map((course, idx) => {
          if (course.type?.toLowerCase() !== 'line' || !course.bearing || course.distance == null) {
            return { idx, score: 0 };
          }
          
          try {
            const parsed = bp.parse(course.bearing);
            const { azimuthRad, parseConfidence } = parsed;
            const dN = Math.cos(azimuthRad);
            const dE = Math.sin(azimuthRad);

            // Absolute dot product: |V · E| / (||V|| * ||E||)
            const dot = Math.abs(dN * errN + dE * errE);
            const vMag = Math.sqrt(dN * dN + dE * dE); // 1.0
            let score = dot / (vMag * errMag);

            // Boost score for LOW-confidence parsings (Fix #4)
            if (parseConfidence === 'LOW') score = Math.min(1.0, score * 1.20);
            else if (parseConfidence === 'MEDIUM') score = Math.min(1.0, score * 1.08);

            return { idx, score, bearing: course.bearing, distance: course.distance, parseConfidence };
          } catch {
            return { idx, score: 0 };
          }
        });

        // Sort descending by alignment score
        alignments.sort((a, b) => b.score - a.score);
        const bestAlign = alignments[0];

        if (bestAlign && bestAlign.score > 0.82) {
          const errDistRounded = Math.round(errMag * 100) / 100;
          const courseNum = bestAlign.idx + 1;
          const confidenceNote = bestAlign.parseConfidence === 'LOW' ? ' (bearing flagged as LOW parse confidence)' : '';

          // Improvement #3: Detect unidirectional error — strong signal of bearing error vs distance error
          const errRatio = Math.min(Math.abs(errN), Math.abs(errE)) / (errMag || 1);
          const isUnidirectional = errRatio < 0.05;
          let directionalNote = '';
          if (isUnidirectional) {
            const dominantDir = Math.abs(errE) > Math.abs(errN) ? 'East-West' : 'North-South';
            const dominantVal = Math.max(Math.abs(errE), Math.abs(errN));
            const orthogonalVal = Math.min(Math.abs(errE), Math.abs(errN));
            directionalNote = ` IMPORTANT DIAGNOSTIC: The error is almost entirely in the ${dominantDir} direction ` +
              `(dominant component = ${dominantVal.toFixed(2)} ft, orthogonal = ${orthogonalVal.toFixed(2)} ft). ` +
              `This pattern strongly indicates a BEARING error (wrong minutes or seconds) on an approximately ` +
              `${dominantDir} course — NOT a distance error. Check whether Course ${courseNum} or any near-parallel ` +
              `side of the parcel uses a slightly different bearing system (e.g. plat bearing vs deed bearing). ` +
              `Common cause: adjacent parallel sides have mismatched bearings (e.g. S89°21'43"W vs N89°43'05"E) ` +
              `due to different survey control being used for each side.`;
          }

          const visualFeedback = `Our geometry engine detected a linear error of ${errMag.toFixed(2)} ft. ` +
            `This error is highly aligned with Course ${courseNum} (${bestAlign.bearing} at ${bestAlign.distance.toFixed(2)} ft) with a ${Math.round(bestAlign.score * 100)}% match score${confidenceNote}. ` +
            `Please re-read Course ${courseNum} in the document carefully. The distance may contain a transcription shift of ${errDistRounded} ft (e.g. check for missing decimals or transposed digits).` +
            directionalNote;

          diagnoses.push({
            type: 'OCR_TRANSCRIPTION_BUST',
            confidence: bestAlign.score * 0.9,
            message: `MISCLOSURE BUST: High alignment detected with Course ${courseNum}. Generating targeted visual OCR prompt.`,
            feedbackPrompt: visualFeedback,
            bustCourseIndex: bestAlign.idx,   // Fix #1: pass to DXF generator
            apply: () => courses // No automatic math fix for this, requires visual re-read
          });
        }
      }
    }

    // 6. Hypothesis: Commencement Leg Strip (high priority)
    // When the closure error vector matches the cumulative displacement of
    // the first 1-3 courses within 5%, those courses are commencement runs
    // that the extractor mistakenly included in the boundary.
    if (courses.length > 2 && cogoReport.linearError > 5.0) {
      const errN = cogoReport.errorNorthing ?? 0;
      const errE = cogoReport.errorEasting ?? 0;
      const errMag = Math.hypot(errN, errE);

      for (let stripLen = 1; stripLen <= Math.min(3, courses.length - 2); stripLen++) {
        let cumN = 0, cumE = 0, allResolvable = true;
        for (let k = 0; k < stripLen; k++) {
          const c = courses[k];
          if (!c.bearing || c.isUnknown || c.distance == null) { allResolvable = false; break; }
          try {
            const parsed = bp.parse(c.bearing);
            if (!parsed?.azimuthDeg) { allResolvable = false; break; }
            const az = parsed.azimuthDeg * Math.PI / 180;
            cumN += c.distance * Math.cos(az);
            cumE += c.distance * Math.sin(az);
          } catch { allResolvable = false; break; }
        }
        if (!allResolvable) continue;

        const residN = errN + cumN;
        const residE = errE + cumE;
        const residMag = Math.hypot(residN, residE);

        if (residMag < errMag * 0.15) {
          const stripped = courses.slice(stripLen);
          const names = courses.slice(0, stripLen).map((c, k) => `C${k+1}(${c.bearing},${c.distance}ft)`).join('+');
          
          let linErr = Infinity;
          try {
            const testResult = traverseSvc.compute({ pointOfBeginning: pob, courses: stripped, units, isOpenEnded: false });
            linErr = testResult?.closure?.linearError ?? Infinity;
          } catch {}

          const isPassing = linErr < 1.0;
          const confidence = isPassing ? 0.98 : (linErr < 50.0 ? 0.85 : 0.50);

          diagnoses.push({
            type: 'COMMENCEMENT_STRIP',
            confidence,
            message: `Commencement Leg Strip: leading ${stripLen} course(s) [${names}] are reference-point runs, not boundary. Residual: ${linErr.toFixed(2)}ft`,
            apply: () => stripped,
          });
        }
      }
    }
    // 7. Hypothesis: Scrivener error (distance typo, bearing typo, etc.)
    if (courses.length >= 3) {
      diagnoses.push({
        type: 'SCRIVENER_CORRECTION',
        confidence: 0.82,
        message: 'Evaluating deterministic scrivener corrections (single-course bearing/distance flips/typos).',
        apply: () => {
          const sRes = tryScrivenerErrorSolver({ courses }, pob, units, isOpenEnded);
          return sRes?.courses || courses;
        }
      });
    }

    // Sort diagnoses by confidence
    const sortedDiagnoses = diagnoses.sort((a, b) => b.confidence - a.confidence);
    console.log(`[${this.name}] Generated ${sortedDiagnoses.length} hypotheses: ${sortedDiagnoses.map(d => `${d.type}(${(d.confidence*100).toFixed(0)}%)`).join(', ')}`);
    return sortedDiagnoses;


  }
}

/**
 * Confidence Scorer Agent (Fix #11)
 * After COGO achieves passing closure, evaluates result plausibility.
 * Returns trustScore 0-100 and a list of trustFlags explaining deductions.
 */
export class ConfidenceScorerAgent {
  constructor() {
    this.name = 'Confidence Scorer Agent';
  }

  score(courses, cogoReport) {
    console.log(`[${this.name}] Evaluating result plausibility...`);
    let trustScore = 100;
    const trustFlags = [];

    // ── Check 1: Shape ratio (isoperimetric) ─────────────────────────────────
    // For a circle (most efficient shape), 4π * area / perimeter² ≈ 1.0
    // Real parcels sit between 0.05 and 0.95. Near 0 = very elongated / degenerate.
    if (cogoReport.areaAcres > 0 && cogoReport.perimeter > 0) {
      const areaSqFt = cogoReport.areaAcres * 43560;
      const isoRatio = (4 * Math.PI * areaSqFt) / (cogoReport.perimeter * cogoReport.perimeter);
      if (isoRatio < 0.01) {
        trustScore -= 30;
        trustFlags.push(`DEGENERATE_SHAPE: Isoperimetric ratio ${isoRatio.toFixed(4)} is extremely low — parcel may be a line or collapsed polygon.`);
      } else if (isoRatio < 0.04) {
        trustScore -= 15;
        trustFlags.push(`NARROW_PARCEL: Isoperimetric ratio ${isoRatio.toFixed(4)} suggests a very narrow strip parcel.`);
      }
    }

    // ── Check 2: Round number saturation ─────────────────────────────────────
    // Suspicious if >60% of bearings have exactly 0 seconds and 0 or round minutes
    const lineCourses = courses.filter(c => c.type?.toLowerCase() === 'line' && c.bearing);
    if (lineCourses.length >= 3) {
      let roundCount = 0;
      for (const c of lineCourses) {
        try {
          const parsed = bp.parse(c.bearing);
          if (parsed.parseConfidence === 'LOW') roundCount++;
        } catch {}
      }
      const roundFraction = roundCount / lineCourses.length;
      if (roundFraction >= 0.7) {
        trustScore -= 20;
        trustFlags.push(`ROUND_NUMBER_SATURATION: ${Math.round(roundFraction * 100)}% of bearings have cardinal/round DMS values — possible systematic OCR substitution.`);
      } else if (roundFraction >= 0.5) {
        trustScore -= 8;
        trustFlags.push(`ELEVATED_ROUND_BEARINGS: ${Math.round(roundFraction * 100)}% of bearings are round/cardinal.`);
      }
    }

    // ── Check 3: Same-hemisphere bias ────────────────────────────────────────
    // If ALL line courses point N or all point S, likely a systematic quadrant flip
    if (lineCourses.length >= 4) {
      let northCount = 0, southCount = 0;
      for (const c of lineCourses) {
        try {
          const { azimuthDeg } = bp.parse(c.bearing);
          if (azimuthDeg <= 180) northCount++;
          else southCount++;
        } catch {}
      }
      const dominantFraction = Math.max(northCount, southCount) / lineCourses.length;
      if (dominantFraction >= 0.90) {
        trustScore -= 20;
        trustFlags.push(`SAME_HEMISPHERE_BIAS: ${Math.round(dominantFraction * 100)}% of courses point in the same N/S hemisphere — possible systematic bearing inversion.`);
      }
    }

    // ── Check 4: Suspiciously uniform distances ───────────────────────────────
    const dists = courses
      .filter(c => c.type?.toLowerCase() === 'line' && c.distance != null)
      .map(c => c.distance);
    if (dists.length >= 3) {
      const mean = dists.reduce((a, b) => a + b, 0) / dists.length;
      const stddev = Math.sqrt(dists.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / dists.length);
      const cv = mean > 0 ? stddev / mean : 0;
      if (cv < 0.02 && dists.length >= 4) {
        trustScore -= 15;
        trustFlags.push(`UNIFORM_DISTANCES: Coefficient of variation ${(cv * 100).toFixed(1)}% — all distances nearly identical, possible placeholder or error.`);
      }
    }

    trustScore = Math.max(0, Math.min(100, Math.round(trustScore)));
    const trustLevel = trustScore >= 80 ? 'HIGH' : trustScore >= 55 ? 'MEDIUM' : 'LOW';

    console.log(`[${this.name}] Trust score: ${trustScore}/100 (${trustLevel}). Flags: ${trustFlags.length}`);
    return { trustScore, trustLevel, trustFlags };
  }
}

/**
 * Supervisor Agent: Central Orchestrator managing turn-based conversational turns.
 * Fix #5: maxTurns is now configurable (default 3, cap 5).
 * Fix #12: Emits agentTurns telemetry array for persistence in diagnosticsDb.
 */
export class SupervisorAgent {
  constructor() {
    this.name = 'Supervisor Agent (Central Orchestrator)';
    this.extractor = new ExtractionAgent();
    this.cogo = new CogoAgent();
    this.surveyor = new LegalSurveyorAgent();
    this.scorer = new ConfidenceScorerAgent();
  }

  async solve(buffer, mimeType, pob = { northing: 5000, easting: 5000 }, units = 'Feet', isOpenEnded = false, fileName = '', maxTurns = 3) {
    // Fix #5: Clamp maxTurns to a safe range
    maxTurns = Math.max(1, Math.min(5, maxTurns));

    console.log(`\n======================================================`);
    console.log(`[${this.name}] Commencing Multi-Agent Deed Error Resolution for: ${fileName}`);
    console.log(`[${this.name}] Max turns: ${maxTurns}`);
    console.log(`======================================================`);

    let currentFeedback = null;
    let turn = 1;
    let lastExtraction = null;
    let lastTraverseReport = null;

    // Fix #12: Accumulate per-turn telemetry
    const agentTurns = [];

    while (turn <= maxTurns) {
      console.log(`\n--- Conversational Agent Loop: Turn ${turn} ---`);
      const turnRecord = { turn, timestamp: new Date().toISOString(), feedbackSent: currentFeedback, diagnoses: [], outcome: null, linearError: null };

      // Turn A: Call Extraction Agent (Visual / OCR text parsing)
      const extraction = await this.extractor.extract(buffer, mimeType, currentFeedback);
      lastExtraction = extraction;

      if (!extraction.courses || extraction.courses.length === 0) {
        console.warn(`[${this.name}] Extraction Agent returned zero segments. Non-traversable file.`);
        turnRecord.outcome = 'EMPTY_EXTRACTION';
        agentTurns.push(turnRecord);
        return {
          status: 'FAIL',
          extraction,
          traverse: null,
          error: 'Document contains no traversable geometry.',
          repairStageUsed: 'Stage 5: Hierarchical Agent (Empty courses)',
          agentTurns,
          trustScore: null,
          trustFlags: [],
          bustCourseIndex: null,
        };
      }

      // Turn B: Call COGO Agent to check mathematically perfect closure
      const cogoReport = this.cogo.analyze(extraction.courses, pob, units, isOpenEnded);
      lastTraverseReport = cogoReport;
      turnRecord.linearError = cogoReport.linearError ?? null;

      // Rec 5: Early exit if error has stalled (< 5% improvement) for 2 consecutive turns
      // Avoids burning all remaining AI calls on a deed that's clearly not converging
      if (agentTurns.length >= 2 && cogoReport.linearError > 5) {
        const prevErr1 = agentTurns.at(-1)?.linearError ?? Infinity;
        const prevErr2 = agentTurns.at(-2)?.linearError ?? Infinity;
        const recentlyStalled = Math.abs(prevErr1 - prevErr2) < Math.max(prevErr2 * 0.05, 0.5)
                             && Math.abs(cogoReport.linearError - prevErr1) < Math.max(prevErr1 * 0.05, 0.5);
        if (recentlyStalled) {
          console.warn(`[${this.name}] Error stalled at ~${cogoReport.linearError.toFixed(2)} ft for 2 turns — early exit (Rec 5).`);
          turnRecord.outcome = 'STALL_EXIT';
          agentTurns.push(turnRecord);
          break;
        }
      }

      if (cogoReport.success && cogoReport.isPassing) {
        console.log(`[${this.name}] SUCCESS: COGO Agent achieved passing closure on Turn ${turn}! Ratio: ${cogoReport.precisionRatio}`);
        extraction.courses = cogoReport.courses;
        extraction.rawJson = JSON.stringify(cogoReport.courses);

        // Fix #11: Score the passing result
        const { trustScore, trustLevel, trustFlags } = this.scorer.score(extraction.courses, cogoReport);

        turnRecord.outcome = 'PASS';
        agentTurns.push(turnRecord);

        return {
          status: 'PASS',
          extraction,
          traverse: cogoReport,
          error: null,
          repairStageUsed: `Stage 5: Agentic System (Turn ${turn} - solved)`,
          agentTurns,
          trustScore,
          trustLevel,
          trustFlags,
          bustCourseIndex: null,
        };
      }

      // Turn C: Call Legal Surveyor Agent to diagnose misclosure error
      const diagnoses = this.surveyor.diagnose(extraction.courses, cogoReport, pob, units, extraction, isOpenEnded);
      turnRecord.diagnoses = diagnoses.map(d => ({ type: d.type, confidence: d.confidence, message: d.message }));

      let solvedWithMath = false;

      // Attempt math/survey-heuristic hypotheses first
      for (const diag of diagnoses) {
        if (diag.type === 'OCR_TRANSCRIPTION_BUST') continue; // requires visual re-read

        console.log(`[${this.name}] Testing surveyor hypothesis: "${diag.message}" (Confidence: ${(diag.confidence * 100).toFixed(0)}%)`);
        const candidateCourses = diag.apply();

        const testReport = this.cogo.analyze(candidateCourses, pob, units, isOpenEnded);
        if (testReport.success && testReport.isPassing) {
          console.log(`[${this.name}] SUCCESS: Surveyor hypothesis "${diag.type}" resolved closure!`);
          extraction.courses = testReport.courses;
          extraction.rawJson = JSON.stringify(testReport.courses);

          // Fix #11: Score the passing result
          const { trustScore, trustLevel, trustFlags } = this.scorer.score(extraction.courses, testReport);

          turnRecord.outcome = `PASS_VIA_${diag.type}`;
          agentTurns.push(turnRecord);

          return {
            status: 'PASS',
            extraction,
            traverse: testReport,
            error: null,
            repairStageUsed: `Stage 5: Agentic Surveyor Repair (${diag.type})`,
            agentTurns,
            trustScore,
            trustLevel,
            trustFlags,
            bustCourseIndex: null,
          };
        }
      }

      // If mathematical / structural corrections failed, check if we have a visual feedback candidate
      const ocrBustDiag = diagnoses.find(d => d.type === 'OCR_TRANSCRIPTION_BUST');
      if (ocrBustDiag && ocrBustDiag.feedbackPrompt) {
        // Rec 3: If model has re-read the same bust course ≥2 turns without improvement,
        // try a targeted single-course N↔S/E↔W bearing flip instead of asking again.
        const bustIdx = ocrBustDiag.bustCourseIndex ?? -1;
        const turnsOnSameCourse = bustIdx >= 0
          ? agentTurns.filter(t => t.bustCourseIndex === bustIdx).length
          : 0;

        if (turnsOnSameCourse >= 2 && bustIdx >= 0) {
          console.log(`[${this.name}] Bust course ${bustIdx} re-read failed ${turnsOnSameCourse}x — trying targeted bearing flip (Rec 3).`);
          const flippedVariants = _targetedBearingFlipVariants(extraction.courses, bustIdx);
          let flipSolved = false;
          for (const flippedCourses of flippedVariants) {
            const flipReport = this.cogo.analyze(flippedCourses, pob, units, isOpenEnded);
            if (flipReport.success && flipReport.isPassing) {
              console.log(`[${this.name}] SUCCESS: Targeted bearing flip on course ${bustIdx} resolved closure!`);
              extraction.courses = flipReport.courses;
              extraction.rawJson = JSON.stringify(flipReport.courses);
              const { trustScore, trustLevel, trustFlags } = this.scorer.score(extraction.courses, flipReport);
              turnRecord.outcome = 'PASS_VIA_TARGETED_FLIP';
              agentTurns.push(turnRecord);
              return {
                status: 'PASS',
                extraction,
                traverse: flipReport,
                error: null,
                repairStageUsed: `Stage 5: Targeted Bearing Flip (course ${bustIdx + 1})`,
                agentTurns, trustScore, trustLevel, trustFlags, bustCourseIndex: bustIdx,
              };
            }
          }
        }

        console.log(`[${this.name}] Escalating OCR bust to Extractor: "${ocrBustDiag.feedbackPrompt}"`);
        currentFeedback = ocrBustDiag.feedbackPrompt;
        turnRecord.bustCourseIndex = ocrBustDiag.bustCourseIndex ?? null;
      } else {
        // Fallback generic feedback if no direct dot-product alignment exists
        const errLinear = cogoReport.linearError ?? 999;
        const errN = cogoReport.errorNorthing ?? 0;
        const errE = cogoReport.errorEasting ?? 0;
        currentFeedback = `The traverse fails to close by ${errLinear.toFixed(2)} ft (Error Northing: ${errN.toFixed(2)}, Easting: ${errE.toFixed(2)}). ` +
          `Please re-read the boundary document carefully and verify all bearings and distances.`;
      }

      turnRecord.outcome = 'FAIL_CONTINUE';
      agentTurns.push(turnRecord);
      turn++;
    }

    console.warn(`[${this.name}] Conversational loop ended without achieving passing closure.`);

    // Attempt a final confidence score on the best-effort result
    let finalTrustScore = null;
    let finalTrustFlags = [];
    if (lastTraverseReport?.success && lastExtraction?.courses) {
      try {
        const scored = this.scorer.score(lastExtraction.courses, lastTraverseReport);
        finalTrustScore = scored.trustScore;
        finalTrustFlags = scored.trustFlags;
      } catch {}
    }

    // Determine the bust course index from the last OCR bust diagnosis if any
    const lastTurn = agentTurns[agentTurns.length - 1];
    const lastBustIdx = lastTurn?.bustCourseIndex ?? null;

    // Return final unclosed state for downstream standard stage-fallbacks to review
    return {
      status: 'FAIL',
      extraction: lastExtraction,
      traverse: lastTraverseReport,
      error: `Deed remains unclosed (${lastTraverseReport?.linearError?.toFixed(4) || 'N/A'} ft) after all agent conversational turns.`,
      repairStageUsed: 'Stage 5: Hierarchical Agent System Unresolved',
      agentTurns,
      trustScore: finalTrustScore,
      trustFlags: finalTrustFlags,
      bustCourseIndex: lastBustIdx,
    };
  }
}
