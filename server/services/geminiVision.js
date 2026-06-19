// ─── geminiVision.js ─────────────────────────────────────────────────────────
// Public API surface — all implementations delegated to services/llm/* modules.
// Import from HERE, not from the sub-modules, to maintain a stable interface.

import * as ollama from './ollamaVision.js';
import crypto from 'crypto';
import { createChildLogger } from '../logger.js';

// Re-export helpers consumed by repair.js and other callers
export { postProcessOcrText, hasBoundaryKeywords, pruneLongText, inferCountyStateFromText }
  from './llm/ocrPostProcess.js';

// Re-export dispatcher public API
export { init, getActiveProvider, getActiveModel, getOpenAiBaseUrl, setProvider, extractRaw }
  from './llm/dispatcher.js';

// PDF cache access (needed by extractBoundary for LOT_BLOCK fallback)
import { pdfOcrCache, computePdfHash } from './llm/pdfProcessor.js';
import { pruneLongText } from './llm/ocrPostProcess.js';
import { extractRaw, getActiveProvider, getActiveModel } from './llm/dispatcher.js';
import { createChildLogger as _cl } from '../logger.js';

const log = _cl('geminiVision');

// Inline re-imports for internal use by extractViaOllama in dispatcher
// (dispatcher.js handles the full provider routing — no duplicated code here)

async function generateConceptualAnalysisFallback(docText) {
  const { getActiveProvider, getActiveModel } = await import('./llm/dispatcher.js');
  const { extractViaOpenAI } = await import('./llm/openaiProvider.js');
  const { extractViaGemini, isGeminiQuotaError, isNetworkOrTimeoutError } = await import('./llm/geminiProvider.js');


  const provider = getActiveProvider();
  const model    = getActiveModel();

  const fallbackPrompt = `You are an expert Professional Land Surveyor. Analyze the following legal description text and extract a concise summary.
1. Identify the Lot number, Block number, and Subdivision name (if present).
2. Note standard lot size assumptions: standard residential lots are typically 0.15 acres (6,500 sq ft); commercial/subdivision tracts (e.g. Tract 1) are 1-5+ acres; government lots are 10-50 acres.
3. Estimate the size of any described easement/parcel/corridor and compare it to the standard lot size.

LEGAL DESCRIPTION TEXT:
${pruneLongText(docText)}

Return your response in this EXACT JSON format:
{
  "Description": "Detailed textual breakdown of the lots, blocks, or tracts mentioned.",
  "ParentTractSizeEstimate": "Estimated parent tract size (e.g. '3.2 acres')",
  "LotSizeEstimate": "Standard lot size assumption (e.g. '0.15 acres')",
  "RelativeComparison": "Comparison of relative sizes (e.g. 'The 1.098 acre road easement is equivalent to about 7 standard residential lots')"
}
Return ONLY valid JSON. No conversational text or markdown fences.`;

  log.info({ provider, model }, 'Running fallback conceptual analysis LLM call');
  let rawText = '';
  try {
    if (provider === 'ollama') {
      const { rawText: ot } = await ollama.generate(Buffer.alloc(0), 'text/plain', model, fallbackPrompt);
      rawText = ot;
    } else if (provider === 'openai') {
      rawText = await extractViaOpenAI(Buffer.alloc(0), 'text/plain', fallbackPrompt, model);
    } else {
      try {
        rawText = await extractViaGemini(Buffer.alloc(0), 'text/plain', fallbackPrompt, model);
      } catch (err) {
        const allowFallback = process.env.ALLOW_API_FALLBACK !== 'false';
        const isQuota = isGeminiQuotaError(err);
        const isNetOrTimeout = isNetworkOrTimeoutError(err);
        if (allowFallback && (isQuota || isNetOrTimeout)) {
          const fallbackModel = process.env.OLLAMA_FALLBACK_MODEL || 'gemma4:26b';
          const reason = isQuota ? 'quota' : 'timeout/network error';
          log.warn({ err: err.message.slice(0, 80), fallback: fallbackModel, reason }, `Gemini API call failed (${reason}) — routing conceptual fallback to Ollama`);
          const { rawText: ot } = await ollama.generate(Buffer.alloc(0), 'text/plain', fallbackModel, fallbackPrompt);
          rawText = ot;
        } else throw err;
      }
    }

    const cleanText = rawText.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    const start = cleanText.indexOf('{');
    const end   = cleanText.lastIndexOf('}');
    if (start !== -1 && end !== -1) return JSON.parse(cleanText.substring(start, end + 1));
  } catch (err) {
    log.warn({ err: err.message }, 'Failed to parse fallback conceptual analysis');
  }
  return {
    Description: rawText.substring(0, 500) || 'Unable to extract description.',
    ParentTractSizeEstimate: 'unknown',
    LotSizeEstimate: '0.15 acres',
    RelativeComparison: 'unknown',
  };
}

export async function extractBoundary(buffer, mimeType, feedback = null) {
  let prompt = getActiveProvider() === 'ollama' ? buildOllamaExtractionPrompt() : buildExtractionPrompt();
  if (feedback) {
    prompt += `\n\n=========================================\nCRITICAL RE-READ DIRECTIONS FROM THE SUPERVISOR / GEOMETRY ENGINE:\n=========================================\n${feedback}\n\nRe-read the original document and correct the segments list carefully based on this feedback.`;
  }
  const rawText = await extractRaw(buffer, mimeType, prompt);

  console.log(`${getActiveProvider()} raw extraction:`, rawText.substring(0, 200) + '...');

  let { courses, classification, preambleFound, isOpenEnded, cleanJson, mentalMapSummary, conceptualAnalysis, referencePointName, commencementSegments, originalLegalDesc } = parseStructuredResponse(rawText);

  // Fallback: if LOT_BLOCK or courses is empty, and conceptualAnalysis is missing, run the targeted fallback LLM parser
  if ((classification === 'LOT_BLOCK' || courses.length === 0) && !conceptualAnalysis) {
    console.log('💡 ConceptualAnalysis is missing in raw JSON response. Executing lightweight fallback generator...');
    try {
      let docText = '';
      if (mimeType === 'text/plain') {
        docText = buffer.toString('utf-8');
      } else if (mimeType === 'application/pdf') {
        const pdfHash = crypto.createHash('sha256').update(buffer).digest('hex');
        const cached = pdfOcrCache.get(pdfHash);
        if (cached) {
          docText = (cached.extractedText || '') + '\n' + (cached.combinedOcrText || '');
        }
      }
      if (docText && docText.trim().length > 15) {
        conceptualAnalysis = await generateConceptualAnalysisFallback(docText);
      } else {
        conceptualAnalysis = "Insufficient text for conceptual analysis.";
      }
    } catch (fallbackErr) {
      console.warn('⚠️ Conceptual analysis fallback generation failed:', fallbackErr.message);
    }
  }

  return {
    rawJson: cleanJson,
    courses,
    message: `Extracted ${courses.length} courses using ${getActiveProvider()}/${getActiveModel()}. Classification: ${classification}.`,
    classification,
    preambleFound,
    isOpenEnded: !!isOpenEnded,
    mentalMapSummary: mentalMapSummary || null,
    conceptualAnalysis: conceptualAnalysis || null,
    referencePointName: referencePointName || null,
    commencementSegments: commencementSegments || [],
    originalLegalDesc: originalLegalDesc || null
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

  let repairPrompt = `You are an elite Professional Land Surveyor performing a MISCLOSURE REPAIR operation.
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

  if (getActiveProvider() === 'ollama') {
    repairPrompt += `\n\nIMPORTANT: Keep your thought process extremely brief (under 5 sentences). Do not repeat rules or explain your steps. Output the corrected JSON object immediately after your thoughts.`;
  }

  const rawText = await extractRaw(buffer, mimeType, repairPrompt);

  console.log('Stage 3 Repair raw output:', rawText.substring(0, 200) + '...');
  const { courses, classification, preambleFound, isOpenEnded, cleanJson, originalLegalDesc } = parseStructuredResponse(rawText);
  return {
    rawJson: cleanJson, courses,
    message: `Stage 3 AI Repair (${getActiveProvider()}/${getActiveModel()}): ${courses.length} courses. Classification: ${classification}.`,
    classification, preambleFound, isOpenEnded: !!isOpenEnded,
    originalLegalDesc: originalLegalDesc || badExtraction.originalLegalDesc || null
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  JSON Parser (unchanged)
// ═══════════════════════════════════════════════════════════════════════════

function findDescriptionsRecursive(val, results = new Set()) {
  if (!val) return;
  if (typeof val === 'object') {
    const descKeys = ['description', 'Description', 'extracted_description', 'extractedDescription', 'text', 'Text', 'legal_description', 'legalDescription'];
    for (const k of descKeys) {
      if (typeof val[k] === 'string' && val[k].trim().length > 10) {
        results.add(val[k].trim());
      }
    }
    for (const k of Object.keys(val)) {
      if (typeof val[k] === 'object' && val[k] !== null) {
        findDescriptionsRecursive(val[k], results);
      }
    }
  }
}

export function parseFromTextFallback(text) {
  if (!text) return null;
  // Strip backslashes and collapse whitespace
  const normalizedText = text.replace(/\\/g, '').replace(/\s+/g, ' ');
  const parts = normalizedText.split(/\bthence\b/i);
  if (parts.length < 2) return null;

  const courses = [];
  // Skip parts[0] as it is the commencement/POB preamble
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i].trim();
    if (part.length < 8) continue;

    // Skip commencement course if it returns to POB before the final segment
    const isCommencement = (i < parts.length - 1) && 
      /to\s+(?:the\s+)?(?:point\s+of\s+beginning|p\.?\s*o\.?\s*b\.?)/i.test(part);
    if (isCommencement) {
      console.log(`Skipping commencement course: "${part.slice(0, 60)}..."`);
      continue;
    }

    // Clean part to remove next segment curve introduction keywords (like "to the point of curvature of a curve...")
    const cleanPart = part.replace(/\bto\s+(?:a|the)\s+(?:point\s+of\s+curvature|point\s+of\s+curve|pc|p\.c\.|beginning\s+of\s+(?:a|the)\s+curve)\b.*/is, '').trim();

    let bearing = null;
    const bearingMatch = cleanPart.match(/([NSns]\s*\d{1,3}\s*[\u00B0°\-]?\s*\d{1,2}\s*['\-]?\s*\d{1,2}(?:\.\d+)?\s*["\s]*[EWew])/)
      || cleanPart.match(/\b(North|South|East|West|N|S|E|W)\s*(\d{1,3})\s*[\u00B0°\-]?\s*(\d{1,2})\s*['\-]?\s*(\d{1,2}(?:\.\d+)?)\s*["\s]*(East|West|E|W)\b/i)
      || cleanPart.match(/\b(NORTHERLY|SOUTHERLY|EASTERLY|WESTERLY|NORTHEASTERLY|NORTHWESTERLY|SOUTHEASTERLY|SOUTHWESTERLY)\b/i);

    let remaining = cleanPart;
    if (bearingMatch) {
      bearing = bearingMatch[0].trim();
      remaining = cleanPart.replace(bearingMatch[0], '');
    }

    const distMatch = remaining.match(/([\d,]+\.\d+)/)
      || remaining.match(/([\d,]+\.?\d*)\s*(?:feet|foot|ft|meters|m)\b/i)
      || remaining.match(/([\d,]+\.?\d*)/);

    let distance = distMatch ? parseFloat(distMatch[1].replace(/,/g, '')) : null;

    if (bearing) {
      bearing = bearing
        .replace(/\bNorth\b/gi, 'N')
        .replace(/\bSouth\b/gi, 'S')
        .replace(/\bEast\b/gi, 'E')
        .replace(/\bWest\b/gi, 'W')
        .replace(/\s+/g, '');
    }

    // Detect if curve with flexible pattern support
    const radiusMatch = cleanPart.match(/radius\s+(?:of\s+)?([\d,]+\.?\d*)/i);
    const arcMatch = cleanPart.match(/(?:arc\s+distance|arc\s+length|arc|length|distance)\s+(?:of\s+)?([\d,]+\.?\d*)/i);
    const chordBrgMatch = cleanPart.match(/chord\s*bearing\s+(?:and\s+distance\s+)?(?:of\s+)?((?:[NSns]|North|South)\s*\d{1,3}[\d°\-\s'"\.\u00B0]+(?:[EWew]|East|West)\b|\b[A-Za-z]+\b)/i)
      || cleanPart.match(/bearing\s+(?:of\s+)?((?:[NSns]|North|South)\s*\d{1,3}[\d°\-\s'"\.\u00B0]+(?:[EWew]|East|West)\b|\b[A-Za-z]+\b)/i);
    const chordDistMatch = cleanPart.match(/chord\s*(?:bearing\s+and\s+)?distance\s+(?:of\s+)?(?:[NSns]|North|South|East|West)?[^,]{1,50}?,?\s*([\d,]+\.?\d*)\s*(?:feet|foot|ft)?/i)
      || cleanPart.match(/chord\s*(?:bearing\s+and\s+)?distance\s+(?:of\s+)?([\d,]+\.?\d*)/i)
      || cleanPart.match(/chord\s+(?:of\s+)?([\d,]+\.?\d*)/i);
    const dirMatch = cleanPart.match(/(?:curve\s+to\s+the|concave|direction)\s*([A-Za-z]+)/i);

    const isCurve = /curve|arc|radius/i.test(cleanPart) && (radiusMatch || arcMatch || chordBrgMatch);

    if (isCurve) {
      let chordBearing = chordBrgMatch ? chordBrgMatch[1].trim() : null;
      if (chordBearing && /^[a-z]+$/i.test(chordBearing) && !/^(north|south|east|west|northerly|southerly|easterly|westerly|northeasterly|northwesterly|southeasterly|southwesterly|ne|se|sw|nw)$/i.test(chordBearing)) {
        chordBearing = null;
      }
      if (chordBearing) {
        chordBearing = chordBearing
          .replace(/\bNorth\b/gi, 'N')
          .replace(/\bSouth\b/gi, 'S')
          .replace(/\bEast\b/gi, 'E')
          .replace(/\bWest\b/gi, 'W')
          .replace(/\s+/g, '');
      } else {
        chordBearing = bearing;
      }

      let chordDistance = chordDistMatch ? parseFloat(chordDistMatch[1].replace(/,/g, '')) : null;
      if (chordDistance == null) {
        chordDistance = distance;
      }

      courses.push({
        type: 'Curve',
        bearing: null,
        distance: null,
        delta: null,
        radius: radiusMatch ? parseFloat(radiusMatch[1].replace(/,/g, '')) : null,
        arcLength: arcMatch ? parseFloat(arcMatch[1].replace(/,/g, '')) : null,
        curveDirection: dirMatch ? dirMatch[1].trim() : null,
        chordBearing,
        chordDistance,
        isUnknown: !radiusMatch && !arcMatch && !chordBearing,
      });
    } else {
      courses.push({
        type: 'Line',
        bearing,
        distance,
        isUnknown: !bearing || distance == null,
      });
    }
  }

  return courses.length >= 2 ? {
    courses,
    classification: 'METES_BOUNDS',
    preambleFound: false,
    isOpenEnded: false,
    cleanJson: text,
    mentalMapSummary: null,
    referencePointName: null,
    commencementSegments: []
  } : null;
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
    let finalVal = val;

    if (isNumber) {
      finalVal = val.replace(/^(-?)0+(?=\d)/, '$1');
    }

    if (isConstant || isNumber) {
      return `${indent}"${key}": ${finalVal}${comma}`;
    }

    // Escape any unescaped double quotes in the value, then wrap in double quotes
    let cleanVal = val;
    cleanVal = cleanVal.replace(/(?<!\\)"/g, '\\"');

    return `${indent}"${key}": "${cleanVal}"${comma}`;
  });

  return cleanedLines.join('\n');
}

function tryParseJsonAndGetStructure(jsonStr) {
  let root = null;
  let cleanStr = jsonStr.trim();
  try {
    root = JSON.parse(cleanStr);
  } catch (err) {
    // Check if it's a comma-separated list of objects
    if (cleanStr.startsWith('{') && cleanStr.endsWith('}')) {
      try {
        const wrapped = `[${cleanStr}]`;
        root = JSON.parse(wrapped);
        cleanStr = wrapped;
      } catch (err2) {
        throw err; // throw original error
      }
    } else {
      throw err;
    }
  }

  if (root) {
    const resultSet = new Set();
    try {
      return getStructureFromRoot(root, cleanStr);
    } catch (structErr) {
      findDescriptionsRecursive(root, resultSet);
      const descs = Array.from(resultSet);
      if (descs.length > 0) {
        const fallbackResult = parseFromTextFallback(descs[0]);
        if (fallbackResult) {
          return fallbackResult;
        }
      }
      throw structErr;
    }
  }
  throw new Error('Parsed root is null');
}

function sanitizeJsonStringValues(jsonStr) {
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
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
      if (ch.charCodeAt(0) < 0x20) {
        out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
        continue;
      }
    }

    out += ch;
  }
  return out;
}

function parseStructuredResponse(raw) {
  let cleanJson = raw.trim();
  
  // Find the first index of '<think', '<thought', '{', or '['
  const startMatch = cleanJson.match(/<(?:think|thought)|[{\[]/);
  if (startMatch && startMatch.index > 0) {
    cleanJson = cleanJson.substring(startMatch.index);
  }
  
  // Strip Ollama/DeepSeek reasoning think tags if present
  if (cleanJson.includes('<think>')) {
    cleanJson = cleanJson.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  }
  if (cleanJson.includes('<thought>')) {
    cleanJson = cleanJson.replace(/<thought>[\s\S]*?<\/thought>/g, '').trim();
  }
  
  // Clean JSON comments and trailing commas (DeepSeek-R1 / local LLM output sanitization)
  cleanJson = cleanJson.replace(/\/\/[^\n]*/g, '');
  cleanJson = cleanJson.replace(/\/\*[\s\S]*?\*\//g, '');
  cleanJson = cleanJson.trim();

  // Escape literal control chars / newlines inside string values
  cleanJson = sanitizeJsonStringValues(cleanJson);

  // Clean trailing commas
  cleanJson = cleanJson.replace(/,\s*([}\]])/g, '$1');

  // Robustly quote any unquoted property values
  cleanJson = cleanInvalidJsonValues(cleanJson);

  // 1. Try parsing cleanJson directly using our helper
  try {
    return tryParseJsonAndGetStructure(cleanJson);
  } catch (err) {
    // 2. Try to extract from markdown code blocks
    let m = cleanJson.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (m) {
      const extracted = m[1].trim();
      try {
        return tryParseJsonAndGetStructure(extracted);
      } catch (err2) {}
    }
    
    // 3. Try to locate the first '{' or '[' and last '}' or ']'
    const firstBrace = cleanJson.indexOf('{');
    const firstBracket = cleanJson.indexOf('[');
    const lastBrace = cleanJson.lastIndexOf('}');
    const lastBracket = cleanJson.lastIndexOf(']');

    let startIdx = -1;
    let endIdx = -1;

    if (firstBrace !== -1 && firstBracket !== -1) {
      startIdx = Math.min(firstBrace, firstBracket);
    } else {
      startIdx = firstBrace !== -1 ? firstBrace : firstBracket;
    }

    if (lastBrace !== -1 && lastBracket !== -1) {
      endIdx = Math.max(lastBrace, lastBracket);
    } else {
      endIdx = lastBrace !== -1 ? lastBrace : lastBracket;
    }

    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      const extractedPos = cleanJson.substring(startIdx, endIdx + 1);
      try {
        return tryParseJsonAndGetStructure(extractedPos);
      } catch (err3) {}
    }
  }

  // 4. Fallback parsing logic
  try {
    let fallbackJson = cleanJson;
    if (fallbackJson.startsWith('```')) fallbackJson = fallbackJson.split('\n').slice(1).join('\n');
    if (fallbackJson.endsWith('```')) fallbackJson = fallbackJson.substring(0, fallbackJson.lastIndexOf('```'));
    fallbackJson = fallbackJson.trim();
    return tryParseJsonAndGetStructure(fallbackJson);
  } catch (finalErr) {
    try {
      const fallbackResult = parseFromTextFallback(raw);
      if (fallbackResult) {
        console.log(`💡 JSON parsing failed completely, but extracted ${fallbackResult.courses.length} courses via paragraph parser fallback on raw text.`);
        return fallbackResult;
      }
    } catch (err) {
      console.warn('Paragraph parser fallback failed:', err.message);
    }

    console.error('======================================================');
    console.error('🚨 JSON PARSING FAILED FOR RAW TEXT:');
    console.error('------------------------------------------------------');
    console.error(raw);
    console.error('======================================================');
    throw finalErr;
  }
}

export function isPlaceholderHallucination(courses) {
  if (!courses || courses.length === 0) return false;

  let matchCount = 0;
  for (const c of courses) {
    const bearingStr = (c.bearing || c.chordBearing || '').toString().toUpperCase();
    const cleanBrg = bearingStr.replace(/[^A-Z0-9]/g, '');
    const dist = c.distance ?? c.chordDistance ?? 0;

    // Check 1: 150.25 and 45°22'10"
    if (Math.abs(dist - 150.25) < 0.01 && (cleanBrg.includes("4522") || cleanBrg.includes("4537"))) {
      matchCount++;
    }
    // Check 2: 57.84 and Northerly/00°00'00"
    if (Math.abs(dist - 57.84) < 0.01 && (bearingStr.includes("NORTHERLY") || cleanBrg.includes("0000") || cleanBrg.includes("000"))) {
      matchCount++;
    }
    // Check 3: 89.02 and 13°22'54" or deflection 13.3819
    if (Math.abs(dist - 89.02) < 0.01 && (cleanBrg.includes("1322") || c.deflectionAngle === 13.3819)) {
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

function constructFullBearing(bearing, direction) {
  if (!bearing || typeof bearing !== 'string') return bearing;
  let cleanBrg = bearing.trim();
  // If the bearing already starts with N/S/E/W/North/South/East/West, don't prepend direction
  if (/^[NSnsEWew]|^North|^South|^East|^West/i.test(cleanBrg)) {
    return cleanBrg;
  }
  if (direction && typeof direction === 'string') {
    const dir = direction.trim();
    if (/^(North|South|East|West|N|S|E|W)/i.test(dir)) {
      return dir + ' ' + cleanBrg;
    }
  }
  return cleanBrg;
}

function getStructureFromRoot(root, cleanJson) {
  // Container format: { "Classification": "...", "Segments": [...] }
  if (root && typeof root === 'object' && !Array.isArray(root)) {
    let segments = root.Segments || root.segments || root.boundary || root.Boundary || root.legs || root.Legs || root.courses || root.Courses;
    let isOpenEnded = root.IsOpenEnded === true || root.isOpenEnded === true || root.isOpenEnded === 'true';

    // Support case where segments is an array of parcels instead of flat segments
    if (Array.isArray(segments) && segments.length > 0 && 
        (segments[0].Segments || segments[0].segments || segments[0].boundary || segments[0].Boundary || segments[0].legs || segments[0].Legs || segments[0].courses || segments[0].Courses)) {
      console.log(`💡 Detected multi-parcel structure mapped to "segments" array key.`);
      const firstParcel = segments[0];
      segments = firstParcel.Segments || firstParcel.segments || firstParcel.boundary || firstParcel.Boundary || firstParcel.legs || firstParcel.Legs || firstParcel.courses || firstParcel.Courses;
      if (firstParcel.IsOpenEnded !== undefined || firstParcel.isOpenEnded !== undefined) {
        isOpenEnded = (firstParcel.IsOpenEnded === true || firstParcel.isOpenEnded === true);
      }
    }

    // Support multi-parcel results from advanced models where Segments is null but Parcels array exists
    const parcels = root.Parcels || root.parcels;
    if ((!segments || segments.length === 0) && parcels && Array.isArray(parcels) && parcels.length > 0) {
      console.log(`💡 Detected "Parcels" array in root. Extracting first parcel: "${parcels[0].ParcelId || parcels[0].parcelId || 'unnamed'}"`);
      segments = parcels[0].Segments || parcels[0].segments || parcels[0].boundary || parcels[0].Boundary || parcels[0].legs || parcels[0].Legs || parcels[0].courses || parcels[0].Courses;
      if (parcels[0].IsOpenEnded !== undefined || parcels[0].isOpenEnded !== undefined) {
        isOpenEnded = parcels[0].IsOpenEnded === true || parcels[0].isOpenEnded === true;
      }
    }

    const referencePointName = root.ReferencePointName || root.referencePointName || null;
    const rawCommSegments = root.CommencementSegments || root.commencementSegments || [];
    const commencementSegments = parseSegmentArray(rawCommSegments);

    const classification = root.Classification || root.classification || 'LOT_BLOCK';
    const preambleFound = root.PreambleFound === true || root.preambleFound === true;
    const mentalMapSummary = root.MentalMapSummary || root.mentalMapSummary || null;
    const conceptualAnalysis = root.ConceptualAnalysis || root.conceptualAnalysis || null;
    const originalLegalDesc = root.OriginalLegalDescription || root.originalLegalDescription || root.originalDeedText || root.OriginalDeedText || null;
    let courses = segments ? parseSegmentArray(segments) : [];

    if (isPlaceholderHallucination(courses)) {
      console.warn('⚠️ DETECTED PLACEHOLDER HALLUCINATION IN AI EXTRACTION! Clearing courses.');
      courses = [];
    }

    return { courses, classification, preambleFound, isOpenEnded, cleanJson, mentalMapSummary, conceptualAnalysis, referencePointName, commencementSegments, originalLegalDesc };
  }

  // Legacy flat array
  if (Array.isArray(root)) {
    if (root.length > 0 && (root[0].legs || root[0].segments || root[0].Legs || root[0].Segments || root[0].boundary || root[0].Boundary || root[0].courses || root[0].Courses)) {
      console.log(`💡 Detected array of parcels in root array. Extracting first parcel: "${root[0].name || root[0].ParcelId || 'unnamed'}"`);
      const firstParcel = root[0];
      const segments = firstParcel.legs || firstParcel.segments || firstParcel.Legs || firstParcel.Segments || firstParcel.boundary || firstParcel.Boundary || firstParcel.courses || firstParcel.Courses;
      let courses = parseSegmentArray(segments);
      if (isPlaceholderHallucination(courses)) {
        console.warn('⚠️ DETECTED PLACEHOLDER HALLUCINATION IN AI EXTRACTION! Clearing courses.');
        courses = [];
      }
      return { courses, classification: 'METES_BOUNDS', preambleFound: false, isOpenEnded: false, cleanJson, mentalMapSummary: null, conceptualAnalysis: null, originalLegalDesc: null };
    }

    let courses = parseSegmentArray(root);

    if (isPlaceholderHallucination(courses)) {
      console.warn('⚠️ DETECTED PLACEHOLDER HALLUCINATION IN AI EXTRACTION! Clearing courses.');
      courses = [];
    }

    return { courses, classification: 'METES_BOUNDS', preambleFound: false, isOpenEnded: false, cleanJson, mentalMapSummary: null, conceptualAnalysis: null, originalLegalDesc: null };
  }

  throw new Error('Response root is neither an object with Segments nor an array.');
}

function parseSegmentArray(arr) {
  if (typeof arr === 'string') {
    try {
      const parsed = JSON.parse(arr.trim());
      if (Array.isArray(parsed)) {
        arr = parsed;
      }
    } catch (e) {
      // Ignore and fall through to standard error handling
    }
  }
  if (!arr || !Array.isArray(arr)) {
    console.warn('⚠️ parseSegmentArray received a non-array:', typeof arr, arr);
    return [];
  }
  return arr.map(el => {
    const type = el.Type || el.type || 'Line';
    const isUnknown = el.IsUnknown === true || el.isUnknown === true;

    if (type.toLowerCase() === 'curve' || type.toLowerCase() === 'arc') {
      let chordBearing = el.chordBearing || el.ChordBearing || el.chord_bearing || null;
      let curveDirection = el.curveDirection || el.Direction || el.CurveDirection || el.curve_direction || el.direction || el.Direction || null;
      chordBearing = constructFullBearing(chordBearing, curveDirection);
      if (chordBearing && typeof chordBearing === 'string') {
        chordBearing = chordBearing.trim()
          .replace(/\bNorth\b/gi, 'N')
          .replace(/\bSouth\b/gi, 'S')
          .replace(/\bEast\b/gi, 'E')
          .replace(/\bWest\b/gi, 'W')
          .replace(/\s+/g, '');
      }
      const deltaVal = getNum(el, 'delta', 'Delta');
      const radiusVal = getNum(el, 'radius', 'Radius');
      const arcLengthVal = getNum(el, 'arcLength', 'ArcLength', 'arc_length', 'arcLength', 'arc_distance', 'arcDistance');
      const chordDistanceVal = getNum(el, 'chordDistance', 'ChordDistance', 'chord_distance', 'chordDistance');
      const hasChord = chordBearing && chordDistanceVal != null && chordDistanceVal !== 0;
      const hasParams = radiusVal != null && (deltaVal != null || arcLengthVal != null);
      const isUnknownReal = (hasChord || hasParams) ? false : isUnknown;

      return {
        type: 'Curve',
        bearing: null,
        distance: null,
        delta: deltaVal,
        radius: radiusVal,
        arcLength: arcLengthVal,
        curveDirection,
        chordBearing,
        chordDistance: chordDistanceVal,
        isUnknown: isUnknownReal,
      };
    }

    // Line / Leg
    let bearing = el.bearing || el.Bearing || null;
    let direction = el.direction || el.Direction || null;
    bearing = constructFullBearing(bearing, direction);
    if (bearing && typeof bearing === 'string') {
      bearing = bearing.trim()
        .replace(/\bNorth\b/gi, 'N')
        .replace(/\bSouth\b/gi, 'S')
        .replace(/\bEast\b/gi, 'E')
        .replace(/\bWest\b/gi, 'W')
        .replace(/\s+/g, '');
    }
    if (!bearing && el.Quad) {
      const deg = el.Degrees ?? 0;
      const min = el.Minutes ?? 0;
      const sec = el.Seconds ?? 0;
      bearing = `${el.Quad[0]}${Math.floor(deg)}°${Math.floor(min)}'${(sec || 0).toFixed(1)}"${el.Quad.length > 1 ? el.Quad[1] : ''}`;
    }

    // Deflection angle courses — preserve the two deflection fields for resolveDeflectionAngles()
    const deflectionAngle     = getNum(el, 'deflectionAngle', 'DeflectionAngle') ?? null;
    const deflectionDirection = el.deflectionDirection || el.DeflectionDirection || null;

    const distanceVal = getNum(el, 'distance', 'Distance');
    const hasLineProps = bearing && distanceVal != null && distanceVal !== 0;
    const hasDeflectProps = deflectionAngle != null && distanceVal != null && distanceVal !== 0;
    const isUnknownReal = (hasLineProps || hasDeflectProps) ? false : isUnknown;

    const course = {
      type: 'Line',
      bearing,
      distance: distanceVal,
      delta: null, radius: null, arcLength: null,
      curveDirection: null, chordBearing: null, chordDistance: null,
      isUnknown: isUnknownReal,
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
export function buildExtractionPrompt() {
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
  b) Count the number of "thence" calls in the boundary description (excluding commencement). Every "thence" call in the boundary description MUST correspond to exactly one segment in your JSON Segments list. Do not omit, skip, or merge courses.
  c) Describe the general shape: "East side runs ~N, North side runs ~W," etc.
  d) Confirm path does NOT cross itself (no bow-tie). If it does, correct it now.
  e) Identify the Point of Beginning (POB) and confirm your last segment closes back to it.

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
  If a segment follows a meandering waterway, creek, river boundary, shoreline, road
  centerline, or other irregular line with no defined bearing and/or distance, set
  "IsUnknown": true and set bearing/distance to null. Do NOT fabricate or guess a bearing
  or distance. The system will mathematically solve the straight-line tie vector using
  inverse gap computation.

RULE 7 — DECOY ELIMINATION:
  IGNORE: dashed easement lines, setback lines, radial tie lines to circle centers,
  curve tables belonging to adjacent parcels. Only trace the HEAVY outer boundary.
  Before generating JSON, physically count boundary lines and state each quadrant direction
  to avoid transcribing decoy tables from adjacent lots.

RULE 7b — COMMENCEMENT RUNS & REFERENCES:
  IDENTIFY the Point of Reference (POR) (e.g., the section corner, subdivision corner, or benchmark mentioned in the text) and any commencement/reference runs leading from that Reference Point (POR) to the Point of Beginning (POB).
  - Populate the "ReferencePointName" field with the name or description of the Point of Reference (e.g. "the Southeast corner of Section 12"). If none is mentioned, set it to null.
  - Extract any commencement courses (bearings + distances) leading from the Reference Point (POR) to the Point of Beginning (POB) and populate them in the "CommencementSegments" array.
  - Do NOT include these commencement courses in the main "Segments" array. The main "Segments" array MUST only contain the property boundary courses starting FROM the Point of Beginning (POB) to keep the closure calculation correct.
  TIP: If a boundary course refers to a bearing from a commencement run (e.g. "continue the aforementioned bearing" or "along said Westerly boundary line"), resolve and extract that bearing for the boundary course, even though the commencement run itself is ignored in the JSON Segments list.

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

RULE 12 — DUAL DESCRIPTION / SAME PROPERTY REDESCRIBED:
  Some deeds contain TWO complete descriptions of the same property — e.g., an original
  deed description followed by "THIS IS THE SAME PROPERTY AS DESCRIBED IN [SURVEY]..." or
  "DESCRIBED AS FOLLOWS: FROM THE [point]..." (a second set of traverse calls).
  Signals to watch for:
    - "THIS IS THE SAME PROPERTY AS DESCRIBED IN..."
    - "BEING THE SAME LANDS AS DESCRIBED IN..."
    - A second "FROM THE [CORNER]" commence + "POINT OF BEGINNING" traverse after
      the first one has already closed.
    - "DESCRIBED AS FOLLOWS:" appearing twice in the document.
  When you detect this pattern:
    → Extract ONLY the SECOND (most recent, usually more precise) description.
    → The second description typically follows a surveyor's job reference (e.g., "Job No. 110750").
    → Ignore the first description entirely — it is superseded.
  WHY: The two descriptions are for the same parcel. Extracting both or mixing them
  will produce phantom extra courses that do not close.

RULE 13 — MULTI-PARCEL DEED (PARCEL 1, PARCEL 2, etc.):
  Some deeds describe multiple separate parcels under "PARCEL 1:", "PARCEL 2:", etc.
  Each parcel is a separate closed traverse.
  → Extract ONLY "PARCEL 1" (the first labeled parcel) unless the file explicitly
    asks for a different parcel.
  → Set Classification to "METES_BOUNDS" or "HYBRID" as appropriate for that parcel.
  → Set MentalMapSummary to describe only Parcel 1's shape.
  WHY: Concatenating two separate traverses creates an uncloseable polygon.

=========================================
OUTPUT JSON SCHEMA
=========================================
Return ONLY a valid JSON object in this EXACT format. No markdown fences, no explanation.

{
  "Classification": "METES_BOUNDS",
  "PreambleFound": false,
  "IsOpenEnded": false,
  "MentalMapSummary": "8 segments: East side runs NW, North side runs SW...",
  "OriginalLegalDescription": "The exact original, uncorrected legal description text isolated from the document (excluding title commitment headers, page numbers, and unrelated boilerplate, but keeping the exact metes-and-bounds text word-for-word).",
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
  "ReferencePointName": "Southeast corner of Section 12",
  "CommencementSegments": [
    {
      "Type": "Line",
      "Bearing": "N00°02'10\\"W",
      "Distance": 330.15,
      "IsUnknown": false
    }
  ],
  "ReferencedParcelName": null,
  "Parcels": null,
  "ConceptualAnalysis": {
    "Description": "Thorough text analysis of the lots, blocks, or tracts mentioned in the deed, identifying the parent tract and subdivision lot/block hierarchy.",
    "ParentTractSizeEstimate": "Estimated or calculated size of the parent tract (e.g. '3.2 acres', '40 acres', or 'unknown').",
    "LotSizeEstimate": "Standard lot size assumption based on location/context (e.g. '0.15 acres' or 'unknown').",
    "RelativeComparison": "Comparison of the size of the subject parcel/easement to standard lots (e.g. 'The 1.098 acre easement is equivalent to about 7 standard residential lots')."
  }
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
Under no circumstances should you ever return the exact example segments (e.g., N45°22'10"E, 150.25', etc.) shown in the output schema. If you cannot find any valid boundary courses or metes-and-bounds traverse calls in the document, you MUST return an empty segments array ("Segments": []) and set the classification to "LOT_BLOCK" or "PLAT" as appropriate. In this case, you MUST also populate the "ConceptualAnalysis" field with a thorough analysis of the subdivision lot/block hierarchy, estimating parent tract and lot sizes to provide relative perspective.

RULE 13 — TITLE COMMITMENTS & EXHIBITS:
If the text contains title commitment headers, commitment numbers, or references to "Exhibit A" or "Schedule A" (e.g. "OLD REPUBLIC INSURANCE", "Commitment Number", "Exhibit A"), you MUST ignore the document metadata (do not return "See Exhibit A"). Instead, locate the metes-and-bounds description starting with "more particularly described as follows" or "Begin at" on that page, and extract the bearings and distances into the Segments array.`;
}

export function buildOllamaExtractionPrompt() {
  return `You are a legal description parser. Convert the following unstructured legal description text into a clean, structured JSON object.

RULES:
1. Extract the document classification: METES_BOUNDS, SECTION_BREAKDOWN, QUALIFIED_PLSS, HYBRID, LOT_BLOCK, or PLAT.
2. Extract the Point of Reference (POR) name into "ReferencePointName".
3. Extract any commencement runs leading from POR to POB into the "CommencementSegments" array. If the description begins directly at the Point of Beginning (POB) and traces the boundary returning to the POB (e.g. 'Begin at the intersection... to the Point of Beginning'), there is NO commencement run. In this case, place all courses in the "Segments" array, and leave "CommencementSegments" empty.
4. Extract the main property boundary courses starting from the POB into the "Segments" array. Every course in the description MUST be extracted. Do not skip or merge courses. If the description lists numbered courses (e.g., '(1) South 84°53'36" East, 308.19 feet... (2) thence around a curve...'), you MUST extract each numbered course as a separate segment in the array.
5. For Line courses, specify: Type ("Line"), Bearing, Distance.
6. For Curve courses, specify: Type ("Curve"), Radius, Delta, ArcLength, CurveDirection ("Left" or "Right"), ChordBearing, ChordDistance.
7. If a bearing/distance is missing, set to null and set IsUnknown to true.
8. Set IsOpenEnded to true if it is an open-ended survey line or easement centerline, or false if it is a closed loop boundary.
9. Keep your thought process brief and go directly to outputting the JSON object. Do not repeat the rules in your thoughts.

JSON OUTPUT FORMAT:
{
  "Classification": "METES_BOUNDS",
  "PreambleFound": true,
  "IsOpenEnded": false,
  "MentalMapSummary": "Brief description of the boundary shape (e.g. 5-sided polygon)",
  "OriginalLegalDescription": "The exact metes-and-bounds text isolated from the document.",
  "ReferencePointName": "Reference corner name, or null",
  "CommencementSegments": [
    { "Type": "Line", "Bearing": "N00°02'10\\"W", "Distance": 330.15, "IsUnknown": false }
  ],
  "Segments": [
    { "Type": "Line", "Bearing": "N45°22'10\\"E", "Distance": 150.25, "IsUnknown": false }
  ],
  "ReferencedParcelName": null,
  "Parcels": null,
  "ConceptualAnalysis": {
    "Description": "Analysis of the tracts/lots mentioned.",
    "ParentTractSizeEstimate": "unknown",
    "LotSizeEstimate": "0.15 acres",
    "RelativeComparison": "unknown"
  }
}

IMPORTANT: Keep your thought process extremely brief (under 5 sentences). Do not repeat rules or explain your steps. Output the JSON object immediately after your thoughts.`;
}
