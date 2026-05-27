// ─── PLSS Parser ─────────────────────────────────────────────────────────────
// Parses Public Land Survey System (PLSS) descriptions from deed text.
// Extracts: Township, Range, Section number, aliquot fractions, Government Lot.
//
// Examples handled:
//   "NW¼ of the SW¼ of Section 12, T3S, R25E"
//   "Government Lot 4, Section 8, Township 7 North, Range 7 East"
//   "GL 3, Sec. 8, T7N, R7E"
//   "The NW 1/4 of Section 22, T.4N., R.2W."
//   "That part of the N½ of the SE¼ of Section 5..."

/**
 * Parse a PLSS description from deed text.
 * @param {string} text - Raw deed text or AI-extracted description
 * @returns {{ township, range, section, fractions, governmentLot, confidence } | null}
 */
export function parsePlss(text) {
  if (!text) return null;
  const t = text.replace(/\n/g, ' ').replace(/\s+/g, ' ');

  // ── Section number ────────────────────────────────────────────────────────
  const secMatch = t.match(/\bSec(?:tion)?\s*\.?\s*(\d{1,2})\b/i);
  if (!secMatch) return null;
  const section = parseInt(secMatch[1]);
  if (section < 1 || section > 36) return null;

  // ── Township ──────────────────────────────────────────────────────────────
  // Matches: T3S, T7N, T.3S., T 3 S, Township 3 South
  const tMatch = t.match(/\bT(?:ownship)?\s*\.?\s*(\d{1,3})\s*\.?\s*([NS](?:orth|outh)?)\b/i) ||
                 t.match(/\bT\.?(\d{1,3})\s*([NS])\.?\b/i);
  if (!tMatch) return null;
  const tNum = parseInt(tMatch[1]);
  const tDir = tMatch[2][0].toUpperCase(); // N or S
  const township = `${tNum}${tDir}`;

  // ── Range ─────────────────────────────────────────────────────────────────
  // Matches: R7E, R25W, R.7E., Range 7 East
  const rMatch = t.match(/\bR(?:ange)?\s*\.?\s*(\d{1,3})\s*\.?\s*([EW](?:ast|est)?)\b/i) ||
                 t.match(/\bR\.?(\d{1,3})\s*([EW])\.?\b/i);
  if (!rMatch) return null;
  const rNum = parseInt(rMatch[1]);
  const rDir = rMatch[2][0].toUpperCase(); // E or W
  const range = `${rNum}${rDir}`;

  // ── Government Lot ────────────────────────────────────────────────────────
  const governmentLot = detectGovernmentLot(t);

  // ── Aliquot fractions ─────────────────────────────────────────────────────
  const fractions = extractFractions(t, secMatch.index);

  const confidence = (fractions.length > 0 || governmentLot) ? 0.9 : 0.6;

  return { township, range, section, fractions, governmentLot, confidence };
}

/**
 * Detect Government Lot number from fraction text.
 * Matches: "Government Lot 3", "Govt. Lot 3", "GL 3", "Lot 3" (when only fraction).
 * @param {string} text
 * @returns {number | null}
 */
export function detectGovernmentLot(text) {
  // "Government Lot N" / "Govt. Lot N"
  const m1 = text.match(/\bGov(?:ernment|t\.?)\s+Lot\s+(\d+)\b/i);
  if (m1) return parseInt(m1[1]);
  // "GL N" (abbreviation)
  const m2 = text.match(/\bGL\.?\s*(\d+)\b/i);
  if (m2) return parseInt(m2[1]);
  // Bare "Lot N" — only accept when it appears before "Section" (not a subdivision lot)
  const m3 = text.match(/\bLot\s+(\d+)\b.*\bSection\b/i);
  if (m3) return parseInt(m3[1]);
  return null;
}

/**
 * Extract aliquot fraction labels from the deed text.
 * Returns strings like ["NW¼", "SW¼"] or ["N½", "SE¼"]
 */
function extractFractions(text, beforeIndex = text.length) {
  // Work on text before the "Section N" mention
  const pre = text.slice(0, beforeIndex + 30).toUpperCase();

  const results = [];
  // Match ¼, ½, 1/4, 1/2 with compass prefix
  const patterns = [
    /\b([NSEW]{1,2})\s*[¼½](?:\s+OF\s+THE\s+[NSEW]{1,2}\s*[¼½])*/gi,
    /\b([NSEW]{1,2})\s+(?:1\/4|1\/2)\b/gi,
    /\b([NSEW]{1,2})\s*\d\/\d/gi,
  ];

  for (const p of patterns) {
    let m;
    const re = new RegExp(p.source, p.flags);
    while ((m = re.exec(pre)) !== null) {
      const frac = m[0].trim();
      if (frac.length >= 2) results.push(frac);
    }
  }

  // Deduplicate
  return [...new Set(results)];
}

/**
 * Convert aliquot fractions to a sub-section bounding box (approximate).
 * Used as fallback when BLM API fails. Assumes a standard 5280×5280 ft section.
 * @param {string[]} fractions - e.g. ["NW¼", "SW¼"] (nested, inner first)
 * @param {{ minN, maxN, minE, maxE }} sectionBounds - section bounding box in local ft
 * @returns {{ vertices: [{northing, easting}], areaSqFt, areaAcres }}
 */
export function fractionsToBounds(fractions, sectionBounds) {
  let { minN, maxN, minE, maxE } = sectionBounds;

  for (const frac of fractions) {
    const upper = frac.toUpperCase();
    const midN = (minN + maxN) / 2;
    const midE = (minE + maxE) / 2;

    if (upper.includes('N½') || upper.includes('N 1/2')) {
      minN = midN;
    } else if (upper.includes('S½') || upper.includes('S 1/2')) {
      maxN = midN;
    } else if (upper.includes('E½') || upper.includes('E 1/2')) {
      minE = midE;
    } else if (upper.includes('W½') || upper.includes('W 1/2')) {
      maxE = midE;
    }

    const q = upper.match(/^([NSEW]{2})[¼\s]/);
    if (q) {
      const dir = q[1];
      if (dir.includes('N')) minN = midN; else maxN = midN;
      if (dir.includes('E')) minE = midE; else maxE = midE;
    }
  }

  const vertices = [
    { northing: minN, easting: minE },
    { northing: maxN, easting: minE },
    { northing: maxN, easting: maxE },
    { northing: minN, easting: maxE },
    { northing: minN, easting: minE },
  ];
  const w = maxE - minE, h = maxN - minN;
  const areaSqFt = w * h;
  return { vertices, areaSqFt, areaAcres: areaSqFt / 43560 };
}
