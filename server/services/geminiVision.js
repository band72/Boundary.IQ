import { fetch } from 'undici';
import * as ollama from './ollamaVision.js';
import pdfParse from 'pdf-parse';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { v4 as uuidv4 } from 'uuid';

const execFileAsync = promisify(execFile);

/**
 * Extract digital text from a PDF buffer.
 */
async function extractTextFromPdf(buffer) {
  try {
    const data = await pdfParse(buffer);
    return data.text ? data.text.trim() : '';
  } catch (err) {
    console.warn('PDF text extraction failed, falling back to image conversion:', err.message);
    return '';
  }
}

/**
 * Convert a PDF page to a PNG buffer using pdftoppm.
 */
async function convertPdfToPng(buffer) {
  const tempDir = path.join(os.tmpdir(), `biq_pdf_conv_${uuidv4().replace(/-/g, '')}`);
  await fs.mkdir(tempDir, { recursive: true });
  
  const tempPdfPath = path.join(tempDir, 'input.pdf');
  const tempPngPrefix = path.join(tempDir, 'output');
  const tempPngPath = tempPngPrefix + '.png';
  
  try {
    await fs.writeFile(tempPdfPath, buffer);
    
    console.log(`Converting PDF page to PNG via pdftoppm...`);
    await execFileAsync('pdftoppm', [
      '-png', '-singlefile', '-r', '150', tempPdfPath, tempPngPrefix
    ], { timeout: 300000 });
    
    const pngBytes = await fs.readFile(tempPngPath);
    console.log(`Successfully converted PDF to PNG image buffer (${(pngBytes.length / 1024).toFixed(1)} KB)`);
    return pngBytes;
  } finally {
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch {}
  }
}

// ── Provider Config (mutable at runtime via /api/settings/model) ────────────
let activeProvider = 'gemini';     // 'gemini' | 'ollama' | 'openai'
let activeModel = 'gemini-3.5-flash';
let geminiApiKey = null;
let activeOpenAiBaseUrl = process.env.OPENAI_BASE_URL || 'http://127.0.0.1:11434/v1';

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000;

// ── Public Config API ───────────────────────────────────────────────────────

export function init(key) { geminiApiKey = key; }

export function getActiveProvider() { return activeProvider; }
export function getActiveModel() { return activeModel; }
export function getOpenAiBaseUrl() { return activeOpenAiBaseUrl; }

export function setProvider(provider, model, baseUrl) {
  if (!['gemini', 'ollama', 'openai'].includes(provider))
    throw new Error(`Invalid provider "${provider}". Use "gemini", "ollama", or "openai".`);
  activeProvider = provider;
  if (provider === 'gemini') {
    activeModel = model || 'gemini-3.5-flash';
  } else if (provider === 'ollama') {
    activeModel = model || 'gemma3:4b';
  } else {
    // openai-compatible
    activeModel = model || 'llama3';
    if (baseUrl) activeOpenAiBaseUrl = baseUrl;
  }
  console.log(`🔄 AI Provider switched to: ${activeProvider} / ${activeModel}${provider === 'openai' ? ` (${activeOpenAiBaseUrl})` : ''}`);
}

// ── Retry-aware POST (Gemini only) ──────────────────────────────────────────
async function postWithRetry(url, payload) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.text();

    if (res.ok) return { status: res.status, body };

    if (res.status === 429 && attempt < MAX_RETRIES) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 500;
      console.warn(`Gemini 429 rate-limit on attempt ${attempt + 1}/${MAX_RETRIES}. Retrying in ${delay.toFixed(0)} ms.`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    return { status: res.status, body };
  }
  throw new Error('Exceeded maximum retry attempts.');
}

// ── Gemini Extraction ───────────────────────────────────────────────────────
async function extractViaGemini(buffer, mimeType, prompt, model) {
  if (!geminiApiKey) throw new Error('Gemini API key not configured.');

  const parts = [{ text: prompt }];
  if (mimeType !== 'text/plain') {
    const b64 = buffer.toString('base64');
    parts.push({ inlineData: { mimeType, data: b64 } });
  }

  const payload = {
    contents: [{
      parts,
    }],
    generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`;
  const { status, body } = await postWithRetry(url, payload);

  if (status < 200 || status >= 300) {
    console.error(`Gemini API error ${status}: ${body}`);
    throw new Error(`Gemini API returned ${status}: ${body}`);
  }

  const doc = JSON.parse(body);
  const rawText = doc?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) throw new Error('Unexpected Gemini response structure.');
  return rawText;
}

// ── Ollama Extraction ───────────────────────────────────────────────────────
async function extractViaOllama(buffer, mimeType, prompt, model) {
  let activeBuffer = buffer;
  let activeMime = mimeType;
  let activePrompt = prompt;

  // Detect whether this model can process images
  const modelIsVision = ollama.isVisionCapable(model);

  if (mimeType === 'text/plain') {
    activeBuffer = Buffer.alloc(0);
    activeMime = 'image/png';
  } else if (mimeType === 'application/pdf') {
    // 1. Try to extract digital text first
    const extractedText = await extractTextFromPdf(buffer);

    if (extractedText && extractedText.length > 50) {
      if (modelIsVision) {
        // Vision model: inject text into prompt AND send the PNG so it can cross-reference
        // bearing/distance details that text-extraction might garble.
        console.log(`Ollama PDF: vision model "${model}" — injecting text + PNG (${extractedText.length} chars).`);
        activePrompt = `${prompt}\n\n=========================================\nLEGAL DESCRIPTION TEXT (extracted from PDF — use as primary source):\n=========================================\n${extractedText}`;
        try {
          activeBuffer = await convertPdfToPng(buffer);
          activeMime = 'image/png';
        } catch {
          console.warn('Ollama PDF: PNG conversion failed for vision model — falling back to text-only.');
          activeBuffer = Buffer.alloc(0);
        }
      } else {
        // Text-only model: inject extracted text, send no image
        console.log(`Ollama PDF: text-only model "${model}" — text injection (${extractedText.length} chars).`);
        activePrompt = `${prompt}\n\n=========================================\nLEGAL DESCRIPTION TEXT TO PARSE:\n=========================================\n${extractedText}`;
        activeBuffer = Buffer.alloc(0);
        activeMime = 'image/png';
      }
    } else {
      // Scanned/image-based PDF — no usable digital text
      console.log(`Ollama PDF: no digital text (${extractedText?.length ?? 0} chars) — converting to PNG.`);
      activeBuffer = await convertPdfToPng(buffer);
      activeMime = 'image/png';
      if (!modelIsVision) {
        console.warn(`Ollama PDF: text-only model "${model}" receiving a scanned PDF image — results may be poor.`);
      }
    }
  }

  const { rawText } = await ollama.generate(activeBuffer, activeMime, model, activePrompt);
  if (!rawText) throw new Error('Ollama returned empty response.');
  return rawText;
}

// ── OpenAI-Compatible Extraction ─────────────────────────────────────────
async function extractViaOpenAI(buffer, mimeType, prompt, model, baseUrl) {
  let userContent;

  if (mimeType === 'text/plain') {
    userContent = [
      { type: 'text', text: prompt },
    ];
  } else if (mimeType === 'application/pdf') {
    // Try text extraction first (same as Ollama path)
    const extractedText = await extractTextFromPdf(buffer);
    if (extractedText && extractedText.length > 50) {
      console.log(`OpenAI-compat PDF: extracted ${extractedText.length} chars, using text-only mode.`);
      userContent = [
        { type: 'text', text: `${prompt}\n\n=========================================\nLEGAL DESCRIPTION TEXT TO PARSE:\n=========================================\n${extractedText}` },
      ];
    } else {
      console.log(`OpenAI-compat PDF: no digital text, converting to PNG.`);
      const pngBuffer = await convertPdfToPng(buffer);
      const b64 = pngBuffer.toString('base64');
      userContent = [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
      ];
    }
  } else {
    // Image (PNG, JPEG, TIFF, etc.)
    const b64 = buffer.toString('base64');
    userContent = [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: `data:${mimeType};base64,${b64}` } },
    ];
  }

  const payload = {
    model,
    messages: [{ role: 'user', content: userContent }],
    temperature: 0.1,
    response_format: { type: 'json_object' },
  };

  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  console.log(`OpenAI-compat request → ${url} [${model}]`);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const bodyText = await res.text();

    if (!res.ok) {
      if (attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 500;
        console.warn(`OpenAI-compat ${res.status} on attempt ${attempt + 1}. Retrying in ${delay.toFixed(0)} ms.`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw new Error(`OpenAI-compatible endpoint returned ${res.status}: ${bodyText}`);
    }

    const doc = JSON.parse(bodyText);
    const rawText = doc?.choices?.[0]?.message?.content;
    if (!rawText) throw new Error('Unexpected OpenAI-compatible response structure.');
    console.log(`OpenAI-compat [${model}] returned ${rawText.length} chars.`);
    return rawText;
  }
  throw new Error('Exceeded maximum retry attempts for OpenAI-compatible endpoint.');
}

// ── Unified Dispatcher ──────────────────────────────────────────────────────
async function extractRaw(buffer, mimeType, prompt) {
  const provider = activeProvider;
  const model = activeModel;

  let activePrompt = prompt;
  if (mimeType === 'text/plain') {
    const textContent = buffer.toString('utf-8');
    activePrompt = `${prompt}\n\n=========================================\nLEGAL DESCRIPTION TEXT TO PARSE:\n=========================================\n${textContent}`;
  }

  console.log(`AI Extract → provider=${provider}, model=${model}, bufferSize=${(buffer.length / 1024).toFixed(0)} KB`);

  if (provider === 'ollama') {
    return extractViaOllama(buffer, mimeType, activePrompt, model);
  }
  if (provider === 'openai') {
    return extractViaOpenAI(buffer, mimeType, activePrompt, model, activeOpenAiBaseUrl);
  }
  return extractViaGemini(buffer, mimeType, activePrompt, model);
}

// ═══════════════════════════════════════════════════════════════════════════
//  PUBLIC API — identical signatures as before
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extract boundary courses from an image/PDF buffer.
 * @param {Buffer} buffer
 * @param {string} mimeType
 * @returns {Promise<object>} PlatExtractResult
 */
export async function extractBoundary(buffer, mimeType, feedback = null) {
  let prompt = buildExtractionPrompt();
  if (feedback) {
    prompt += `\n\n=========================================\nCRITICAL RE-READ DIRECTIONS FROM THE SUPERVISOR / GEOMETRY ENGINE:\n=========================================\n${feedback}\n\nRe-read the original document and correct the segments list carefully based on this feedback.`;
  }
  const rawText = await extractRaw(buffer, mimeType, prompt);

  console.log(`${activeProvider} raw extraction:`, rawText.substring(0, 200) + '...');

  const { courses, classification, preambleFound, isOpenEnded, cleanJson, mentalMapSummary } = parseStructuredResponse(rawText);
  return {
    rawJson: cleanJson,
    courses,
    message: `Extracted ${courses.length} courses using ${activeProvider}/${activeModel}. Classification: ${classification}.`,
    classification,
    preambleFound,
    isOpenEnded: !!isOpenEnded,
    mentalMapSummary: mentalMapSummary || null,
  };
}

/**
 * Stage 3: AI Misclosure Repair.
 */
export async function extractMisclosureRepair(buffer, mimeType, badExtraction, badTraverse) {
  const errorVector = `LinearError=${badTraverse.closure.linearError.toFixed(4)}ft, ` +
    `ErrorN=${badTraverse.closure.errorNorthing.toFixed(4)}, ` +
    `ErrorE=${badTraverse.closure.errorEasting.toFixed(4)}, ` +
    `Precision=${badTraverse.closure.precisionRatio}`;

  const repairPrompt = `You are an elite Professional Land Surveyor performing a MISCLOSURE REPAIR operation.
The boundary traverse below FAILED to close with the following error:
${errorVector}

The current extracted JSON segments are:
${badExtraction.rawJson}

Your task:
1. Study the original plat image carefully.
2. Identify which specific segment(s) contain transcription errors causing the closure failure.
3. Apply Quadrant Inversion (flip N↔S or E↔W) to any reversed bearings.
4. Correct any distances that appear to have OCR transcription errors (e.g., 1234.56 transcribed as 134.56).
5. Return the COMPLETE corrected segment list — same format as the input but with corrections applied.

Return ONLY the corrected JSON object (same schema as original extraction).`;

  const rawText = await extractRaw(buffer, mimeType, repairPrompt);

  console.log('Stage 3 Repair raw output:', rawText.substring(0, 200) + '...');
  const { courses, classification, preambleFound, isOpenEnded, cleanJson } = parseStructuredResponse(rawText);
  return {
    rawJson: cleanJson, courses,
    message: `Stage 3 AI Repair (${activeProvider}/${activeModel}): ${courses.length} courses. Classification: ${classification}.`,
    classification, preambleFound, isOpenEnded: !!isOpenEnded,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  JSON Parser (unchanged)
// ═══════════════════════════════════════════════════════════════════════════

function parseStructuredResponse(raw) {
  let cleanJson = raw.trim();
  
  // Strip Ollama/DeepSeek reasoning think tags if present
  if (cleanJson.includes('<think>')) {
    cleanJson = cleanJson.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  }
  
  // Try direct parsing first
  try {
    const root = JSON.parse(cleanJson);
    if (root) {
      return getStructureFromRoot(root, cleanJson);
    }
  } catch (err) {
    // If direct parse fails, try to extract from markdown code blocks
    let m = cleanJson.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (m) {
      const extracted = m[1].trim();
      try {
        const root = JSON.parse(extracted);
        if (root) return getStructureFromRoot(root, extracted);
      } catch (err2) {}
    }
    
    // If still fails, locate the first '{' and last '}'
    const startIdx = cleanJson.indexOf('{');
    const endIdx = cleanJson.lastIndexOf('}');
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      const extractedPos = cleanJson.substring(startIdx, endIdx + 1);
      try {
        const root = JSON.parse(extractedPos);
        if (root) return getStructureFromRoot(root, extractedPos);
      } catch (err3) {}
    }
  }

  // Original fallback parsing logic if all robust methods fail
  if (cleanJson.startsWith('```')) cleanJson = cleanJson.split('\n').slice(1).join('\n');
  if (cleanJson.endsWith('```')) cleanJson = cleanJson.substring(0, cleanJson.lastIndexOf('```'));
  cleanJson = cleanJson.trim();

  const root = JSON.parse(cleanJson);
  return getStructureFromRoot(root, cleanJson);
}

export function isPlaceholderHallucination(courses) {
  if (!courses || courses.length === 0) return false;

  let matchCount = 0;
  for (const c of courses) {
    const bearingStr = (c.bearing || c.chordBearing || '').toString().toUpperCase();
    const dist = c.distance ?? c.chordDistance ?? 0;

    // Check 1: 150.25 and 45°22'10"
    if (Math.abs(dist - 150.25) < 0.01 && (bearingStr.includes("45°22") || bearingStr.includes("45D22") || bearingStr.includes("45.37") || bearingStr.includes("45°22'10\""))) {
      matchCount++;
    }
    // Check 2: 57.84 and Northerly/00°00'00"
    if (Math.abs(dist - 57.84) < 0.01 && (bearingStr.includes("NORTHERLY") || bearingStr.includes("00°00") || bearingStr.includes("0°00") || bearingStr.includes("00.00"))) {
      matchCount++;
    }
    // Check 3: 89.02 and 13°22'54" or deflection 13.3819
    if (Math.abs(dist - 89.02) < 0.01 && (bearingStr.includes("13°22") || bearingStr.includes("13D22") || c.deflectionAngle === 13.3819)) {
      matchCount++;
    }
    // Check 4: Curve R=200 and Delta=12.3015 or radius=150/100/80 and delta=10.3015/8.3015/6.3015
    if (c.type === 'Curve' &&
        (Math.abs((c.radius || 0) - 200) < 0.01 || Math.abs((c.radius || 0) - 150) < 0.01 || Math.abs((c.radius || 0) - 100) < 0.01 || Math.abs((c.radius || 0) - 80) < 0.01) &&
        (Math.abs((c.delta || 0) - 12.3015) < 0.001 || Math.abs((c.delta || 0) - 10.3015) < 0.001 || Math.abs((c.delta || 0) - 8.3015) < 0.001 || Math.abs((c.delta || 0) - 6.3015) < 0.001)) {
      matchCount++;
    }
    // Check 5: Curve chord distance 42.88 or 38.88/30.88/20.88/10.88
    if (c.type === 'Curve' &&
        (Math.abs((c.chordDistance || 0) - 42.88) < 0.01 || Math.abs((c.chordDistance || 0) - 38.88) < 0.01 || Math.abs((c.chordDistance || 0) - 30.88) < 0.01 || Math.abs((c.chordDistance || 0) - 20.88) < 0.01 || Math.abs((c.chordDistance || 0) - 10.88) < 0.01)) {
      matchCount++;
    }
  }

  return matchCount >= 2;
}

function getStructureFromRoot(root, cleanJson) {
  // Container format: { "Classification": "...", "Segments": [...] }
  if (root && typeof root === 'object' && !Array.isArray(root) && root.Segments) {
    const classification = root.Classification || 'METES_BOUNDS';
    const preambleFound = root.PreambleFound === true;
    const isOpenEnded = root.IsOpenEnded === true || root.isOpenEnded === true;
    const mentalMapSummary = root.MentalMapSummary || root.mentalMapSummary || null;
    let courses = parseSegmentArray(root.Segments);

    if (isPlaceholderHallucination(courses)) {
      console.warn('⚠️ DETECTED PLACEHOLDER HALLUCINATION IN AI EXTRACTION! Clearing courses.');
      courses = [];
    }

    return { courses, classification, preambleFound, isOpenEnded, cleanJson, mentalMapSummary };
  }

  // Legacy flat array
  if (Array.isArray(root)) {
    let courses = parseSegmentArray(root);

    if (isPlaceholderHallucination(courses)) {
      console.warn('⚠️ DETECTED PLACEHOLDER HALLUCINATION IN AI EXTRACTION! Clearing courses.');
      courses = [];
    }

    return { courses, classification: 'METES_BOUNDS', preambleFound: false, isOpenEnded: false, cleanJson, mentalMapSummary: null };
  }

  throw new Error('Response root is neither an object with Segments nor an array.');
}

function parseSegmentArray(arr) {
  return arr.map(el => {
    const type = el.Type || el.type || 'Line';
    const isUnknown = el.IsUnknown === true || el.isUnknown === true;

    if (type.toLowerCase() === 'curve') {
      return {
        type: 'Curve',
        bearing: null,
        distance: null,
        delta: getNum(el, 'delta', 'Delta'),
        radius: getNum(el, 'radius', 'Radius'),
        arcLength: getNum(el, 'arcLength', 'ArcLength'),
        curveDirection: el.curveDirection || el.Direction || el.CurveDirection || null,
        chordBearing: el.chordBearing || el.ChordBearing || null,
        chordDistance: getNum(el, 'chordDistance', 'ChordDistance'),
        isUnknown,
      };
    }

    // Line
    let bearing = el.bearing || el.Bearing || null;
    if (!bearing && el.Quad) {
      const deg = el.Degrees ?? 0;
      const min = el.Minutes ?? 0;
      const sec = el.Seconds ?? 0;
      bearing = `${el.Quad[0]}${Math.floor(deg)}°${Math.floor(min)}'${(sec || 0).toFixed(1)}"${el.Quad.length > 1 ? el.Quad[1] : ''}`;
    }

    // Deflection angle courses — preserve the two deflection fields for resolveDeflectionAngles()
    const deflectionAngle     = getNum(el, 'deflectionAngle', 'DeflectionAngle') ?? null;
    const deflectionDirection = el.deflectionDirection || el.DeflectionDirection || null;

    const course = {
      type: 'Line',
      bearing,
      distance: getNum(el, 'distance', 'Distance'),
      delta: null, radius: null, arcLength: null,
      curveDirection: null, chordBearing: null, chordDistance: null,
      isUnknown,
    };

    if (deflectionAngle !== null && deflectionDirection) {
      course.deflectionAngle     = deflectionAngle;
      course.deflectionDirection = deflectionDirection.toString().toUpperCase();
      course.bearing             = null; // will be resolved by resolveDeflectionAngles()
    }

    return course;
  });
}


function getNum(el, ...keys) {
  for (const k of keys) {
    if (el[k] != null) {
      const v = el[k];
      if (typeof v === 'number') return v;
      if (typeof v === 'string') { const n = parseFloat(v); if (!isNaN(n)) return n; }
    }
  }
  return null;
}

// ── Extraction Prompt ───────────────────────────────────────────────────────
function buildExtractionPrompt() {
  return `You are an elite, highly experienced Professional Land Surveyor and Computational Geometer.
Your core directive is to translate this unstructured land document (deed, map, or plat image)
into a mathematically perfect, logically sequential boundary traverse formatted as JSON.

=========================================
STEP 0 — DOCUMENT CLASSIFICATION
=========================================
First, classify the document into EXACTLY ONE of:
  - METES_BOUNDS     : Contains bearing + distance traverse calls (standard deed).
  - SECTION_BREAKDOWN: Pure PLSS aliquot description, no custom bearings.
  - QUALIFIED_PLSS   : Aliquot + road/line clip offset ("that part of...").
  - HYBRID           : PLSS location context + custom metes-and-bounds perimeter calls.
  - LOT_BLOCK        : Subdivision lot reference (Lot X, Block Y, Plat Name).
  - PLAT             : Full recorded plat image with multiple lots.

Also detect if a preamble is present (ends with "more particularly described" or similar).
Strip preamble text — extract ONLY the geometric boundary calls.

Also identify if the legal description represents an open-ended linear feature (such as an easement centerline, road right-of-way, or standard corridor strip) rather than a closed parcel loop. Set IsOpenEnded to true if it is an open-ended path, or false if it is a closed loop property boundary (even if there are small closure errors).

=========================================
STEP 1 — MENTAL MAP PRE-ANALYSIS
=========================================
Before generating JSON, perform these checks:
  a) Count the total number of segments (lines + curves) forming the PRIMARY boundary.
  b) Describe the general shape: "East side runs ~N, North side runs ~W," etc.
  c) Confirm path does NOT cross itself (no bow-tie). If it does, correct it now.
  d) Identify the Point of Beginning (POB) and confirm your last segment closes back to it.

=========================================
CORE MATHEMATICAL & DRAFTING RULES
=========================================

RULE 1 — TOPOLOGICAL SEQUENCE (Head-to-Tail):
  Physically re-trace the perimeter CLOCKWISE from POB. Verify Segment[N].endpoint
  geometrically touches Segment[N+1].startpoint. If a gap or backtrack is detected,
  automatically re-order the segment array until the path is continuous and returns to POB.

RULE 2 — BOW-TIE (Self-Intersection) PREVENTION:
  A property boundary can NEVER cross its own path. Project coordinate geometry using
  vector cross-products. If lines cross, flip the N/S or E/W quadrant of the offending
  bearing using Quadrant Inversion until no crossings exist.

RULE 3 — QUADRANT INVERSION:
  Place a mental crosshair at your current node. If the printed bearing points 180° AWAY
  from the actual line progression direction, invert both quadrants: N↔S and E↔W.
  Example: "N 45°22'10" E" becomes "S 45°22'10" W". Do NOT double-reverse.

RULE 4 — CURVE DIRECTION (Left vs. Right):
  Imagine driving a vehicle CLOCKWISE along the chord bearing:
  - Arc bows OUT to the LEFT of the driver (away from lot center) → "Left"
  - Arc bows OUT to the RIGHT of the driver (toward lot center) → "Right"
  Standard exterior rounded corners in a clockwise traverse are always Right turns.
  Cuts into the property interior are Left turns.

RULE 5 — EXPLICIT CHORD DATA (No Pixel Estimation):
  For ALL curve segments, you MUST extract the explicit CHORD BEARING and CHORD DISTANCE
  from the plat's curve table. NEVER estimate distances from pixel dimensions.
  Also extract: Delta (central angle), Radius, Arc Length.
  Hunt for hidden L-tag deflection curves (L1, L2, etc.) between straight segments.

RULE 6 — MEANDER BOUNDARIES:
  If a segment follows a meandering waterway or irregular line with no bearing given,
  set "IsUnknown": true. Do NOT fabricate a bearing. The system will mathematically
  solve the straight-line tie vector using inverse gap computation.

RULE 7 — DECOY ELIMINATION:
  IGNORE: dashed easement lines, setback lines, radial tie lines to circle centers,
  curve tables belonging to adjacent parcels. Only trace the HEAVY outer boundary.
  Before generating JSON, physically count boundary lines and state each quadrant direction
  to avoid transcribing decoy tables from adjacent lots.

RULE 7b — COMMENCEMENT RUNS ELIMINATION:
  IGNORE any "THENCE" clauses or course descriptions that occur BEFORE the actual "POINT OF BEGINNING" or "TO THE POINT OF BEGINNING" (these are commencement or reference runs leading TO the POB, not boundary lines). Only extract courses that describe the actual property boundary starting FROM the Point of Beginning.

RULE 8 — STRICT JSON FORMATTING:
  No leading zeros on integers. No unescaped newlines inside strings.
  No trailing commas. Bearing strings must use degree symbol (°), apostrophe ('), and
  quote (") for DMS. Format: "N45°30'00\\\"E".

RULE 9 — STRIP DEED / OPEN-ENDED SURVEY LINE:
  BEFORE extracting segments, scan the text for these definitive signals:
    Signal A: "a strip of land" or "strip of land X feet in width"
    Signal B: "point of termination" (the line terminates; it does NOT close back to POB)
    Signal C: "herein described survey line"
  If Signal A + Signal B are both present (or Signal C alone):
    \u2192 Set "IsOpenEnded": true
    \u2192 Set "Classification": "OPEN_ENDED"
    \u2192 Extract only the CENTERLINE courses (bearing + distance from POB to termination)
    \u2192 Set MentalMapSummary to describe the corridor width and direction
    \u2192 Do NOT include a closing course back to POB
  WHY: Strip parcels define a corridor of specified WIDTH along a centerline. The centerline
  runs point-to-point and never closes. Forcing closure produces a false linear error.

RULE 10 — DEFLECTION ANGLE COURSES:
  Some older deeds describe a change in direction as a DEFLECTION ANGLE rather than a compass bearing.
  These look like: "THENCE AT A DEFLECTION ANGLE TO THE LEFT OF 13°22'55\", a distance of 89.02 feet"
  or: "THENCE DEFLECTING RIGHT 45°00'00\", 200.00 feet to..."
  A deflection angle is a RELATIVE turn from the current direction of travel:
    LEFT  = counter-clockwise turn (the street or line bends to the left)
    RIGHT = clockwise turn (the street or line bends to the right)
  For these courses you MUST:
    \u2192 Set "Bearing": null (DO NOT guess a compass bearing)
    \u2192 Set "DeflectionAngle": the angle in decimal degrees (e.g. 13.3819 for 13°22'55")
    \u2192 Set "DeflectionDirection": "LEFT" or "RIGHT"
    \u2192 Set "Distance": the stated distance as usual
    \u2192 Set "IsUnknown": false
  The COGO engine will compute the correct absolute bearing automatically using the incoming course direction.
  WARNING: Do NOT convert deflection angles to compass bearings yourself — the relative/absolute
  transformation requires knowing the prior course direction, which only the COGO engine has.

RULE 11 — CARDINAL DIRECTION COURSES:
  Some older deeds use direction words without a precise bearing: "THENCE NORTHERLY 150 feet"
  or "THENCE WESTERLY AND ALONG OAK STREET 57.08 feet".
  For these courses:
    \u2192 Set "Bearing": the cardinal word as a string, e.g. "NORTHERLY", "WESTERLY", "SOUTHEASTERLY"
    \u2192 The COGO engine will resolve these to exact cardinal azimuths (N=0°, W=270°, etc.)
  Do NOT fabricate a precise DMS bearing (like N00°00'00"E) when the deed only says "northerly".

=========================================
OUTPUT JSON SCHEMA
=========================================
Return ONLY a valid JSON object in this EXACT format. No markdown fences, no explanation.

{
  "Classification": "METES_BOUNDS",
  "PreambleFound": false,
  "IsOpenEnded": false,
  "MentalMapSummary": "8 segments: East side runs NW, North side runs SW...",
  "Segments": [
    {
      "Type": "Line",
      "Bearing": "N45°22'10\\"E",
      "Distance": 150.25,
      "IsUnknown": false
    },
    {
      "Type": "Line",
      "Bearing": "NORTHERLY",
      "Distance": 57.84,
      "IsUnknown": false
    },
    {
      "Type": "Line",
      "Bearing": null,
      "DeflectionAngle": 13.3819,
      "DeflectionDirection": "LEFT",
      "Distance": 89.02,
      "IsUnknown": false
    },
    {
      "Type": "Curve",
      "Direction": "Right",
      "Radius": 200.00,
      "Delta": 12.3015,
      "ArcLength": 43.02,
      "ChordBearing": "N51°15'30\\"E",
      "ChordDistance": 42.88,
      "IsUnknown": false
    }
  ],
  "ReferencedParcelName": null,
  "Parcels": null
}

IMPORTANT: Segments array must be in CLOCKWISE order starting with the first course
AFTER the POB, ending with the last course that returns TO the POB.
Do NOT include the POB itself as a segment.

REFERENCED PARCEL: If the boundary calls reference an ADJACENT or EXCEPTION parcel
(e.g. "LESS AND EXCEPT Lot 5", "along the boundary of Parcel B", "as described in Book 12, Page 34"),
set ReferencedParcelName to the name/reference of that parcel (e.g. "Lot 5, Block 2, Plat Book 12").
Otherwise set it to null.

MULTI-PARCEL: If the document contains MULTIPLE separate boundary loops
(e.g. "PARCEL A:...PARCEL B:...", or multiple BEGINNING AT blocks), set Parcels to an array:
[
  { "ParcelId": "A", "IsOpenEnded": false, "Segments": [...] },
  { "ParcelId": "B", "IsOpenEnded": true,  "Segments": [...] }
]
For strip deed parcels within a multi-parcel doc, set IsOpenEnded=true on that parcel entry.
and set Segments to the first parcel's segments only.
Otherwise set Parcels to null.

RULE 12 — NO PLACEHOLDER HALLUCINATION:
Under no circumstances should you ever return the exact example segments (e.g., N45°22'10"E, 150.25', etc.) shown in the output schema. If you cannot find any valid boundary courses or metes-and-bounds traverse calls in the document, you MUST return an empty segments array ("Segments": []) and set the classification to "LOT_BLOCK" or "PLAT" as appropriate.`;
}
