// ─── OCR Post-Processing & Text Helpers ──────────────────────────────────────
// Extracted from geminiVision.js. No LLM or I/O dependencies.

// ── Unicode & OCR artifact normalization ─────────────────────────────────────

export function normalizeOcrText(text) {
  if (!text) return '';
  return text
    .replace(/\bTHENCII\b/gi, 'THENCE')
    .replace(/\bTHENCEE\b/gi, 'THENCE')
    .replace(/\bTHENC\b/gi, 'THENCE')
    .replace(/\bNO\s+RTH\b/gi, 'NORTH')
    .replace(/\bNARTH\b/gi, 'NORTH')
    .replace(/\bNORT['1]H\b/gi, 'NORTH')
    .replace(/\bSAUTH\b/gi, 'SOUTH')
    .replace(/\bSOU['1]H\b/gi, 'SOUTH')
    .replace(/\bENST\b/gi, 'EAST')
    .replace(/\bEAS['1]\b/gi, 'EAST')
    .replace(/\bWES['1]\b/gi, 'WEST')
    .replace(/\bALANG\b/gi, 'ALONG')
    .replace(/\bAIONG\b/gi, 'ALONG')
    .replace(/\bSALD\b/gi, 'SAID')
    .replace(/\bUNE\b/gi, 'LINE')
    .replace(/\bIINLL\b/gi, 'LINE')
    .replace(/\bMINUTLLS\b/gi, 'MINUTES')
    .replace(/\bROI\\?D\b/gi, 'ROAD')
    .replace(/\bFOAT\b/gi, 'FOOT')
    .replace(/\bDEJ\.'1"EES\b/gi, 'DEGREES')
    .replace(/([NSEW]\.)([Oo]+)(°|\()/gi, (_, prefix, zeros, sep) => prefix + zeros.replace(/[Oo]/g, '0') + sep)
    .replace(/\b(NORTH|SOUTH|EAST|WEST)\s+J\s+(\d)/gi, (_, dir, d) => `${dir} 3${d}`)
    .replace(/(\d)\s+J\s+(\d+)\s+(DEGREES|DEG\.?|°)/gi, (_, a, b, unit) => `${a}3${b} ${unit}`);
}

export function postProcessOcrText(text) {
  if (!text) return '';
  let cleaned = text;

  // Unicode prime marks → standard DMS punctuation
  cleaned = cleaned.replace(/\u2032/g, "'");   // PRIME → minutes
  cleaned = cleaned.replace(/\u2033/g, '"');   // DOUBLE PRIME → seconds
  cleaned = cleaned.replace(/\u2034/g, '"');   // TRIPLE PRIME → seconds
  cleaned = cleaned.replace(/\u02B9/g, "'");   // MODIFIER LETTER PRIME
  cleaned = cleaned.replace(/\u02BA/g, '"');   // MODIFIER LETTER DOUBLE PRIME
  // Smart quotes → ASCII
  cleaned = cleaned.replace(/[\u2018\u2019\u201A\u02BC\u00B4]/g, "'");
  cleaned = cleaned.replace(/[\u201C\u201D\u201E]/g, '"');
  // Greek lookalikes → ASCII (appear in OCR of all-caps Word docs)
  cleaned = cleaned.replace(/\u039D/g, 'N');
  cleaned = cleaned.replace(/\u0391/g, 'A');
  cleaned = cleaned.replace(/\u039F/g, 'O');
  cleaned = cleaned.replace(/\u0395/g, 'E');
  cleaned = cleaned.replace(/\u0397/g, 'H');
  cleaned = cleaned.replace(/\u039A/g, 'K');
  cleaned = cleaned.replace(/\u039C/g, 'M');
  cleaned = cleaned.replace(/\u03A1/g, 'R');
  cleaned = cleaned.replace(/\u03A4/g, 'T');
  cleaned = cleaned.replace(/\u03A5/g, 'Y');
  cleaned = cleaned.replace(/\u03A7/g, 'X');
  cleaned = cleaned.replace(/\u03A9/g, 'W');

  cleaned = cleaned.replace(/'\\s*'/g, '"');
  cleaned = cleaned.replace(/''/g, '"');
  cleaned = cleaned.replace(/(\d{1,3})\s*\*/g, '$1°');
  cleaned = cleaned.replace(/([NSns])\s*(\d{1,2})\s*-\s*(\d{1,2})\s*-\s*(\d{1,2})\s*([EWew])/g, "$1 $2° $3' $4\" $5");
  cleaned = cleaned.replace(/([Nn]orth|[Ss]outh)\s*(\d{1,2})\s*-\s*(\d{1,2})\s*-\s*(\d{1,2})\s*([Ee]ast|[Ww]est)/g, "$1 $2° $3' $4\" $5");
  cleaned = cleaned.replace(/([NSns])\s*(\d{1,2})\s*-\s*(\d{1,2})\s*([EWew])/g, "$1 $2° $3' $4");
  cleaned = cleaned.replace(/([Nn]orth|[Ss]outh)\s*(\d{1,2})\s*-\s*(\d{1,2})\s*([Ee]ast|[Ww]est)/g, "$1 $2° $3' $4");
  cleaned = cleaned.replace(/([NSns])\s*(\d{1,2})0\s+(\d{1,2})['"]/, "$1 $2° $3'");
  cleaned = cleaned.replace(/([NSns])\s*(\d{1,2})[oO-]\s*(\d{1,2})['"]/, "$1 $2° $3'");
  cleaned = cleaned.replace(/([Nn]orth|[Ss]outh|[Ee]ast|[Ww]est)\s*(\d{1,2})[oO0-]\s*(\d{1,2})['"]/, "$1 $2° $3'");

  cleaned = normalizeOcrText(cleaned);
  return cleaned;
}

// ── Boundary keyword detection ────────────────────────────────────────────────

export function hasBoundaryKeywords(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  const hasDegrees = lower.includes('°') || lower.includes('*') || lower.includes('deg') || lower.includes('degree');
  const hasThence  = lower.includes('thence');
  const hasPob     = lower.includes('point of beginning') || lower.includes('p.o.b.') || lower.includes('pob') || lower.includes('commence');
  const hasFeet    = lower.includes('feet') || lower.includes('foot') || lower.includes(' ft') || lower.includes('chs') || lower.includes('chains');
  const hasChords  = lower.includes('chord') || lower.includes('curve') || lower.includes('radius');
  return (hasThence && (hasFeet || hasDegrees)) || hasPob || (hasChords && hasFeet);
}

// ── Long-text pruner ─────────────────────────────────────────────────────────

export function pruneLongText(text) {
  if (!text || text.length < 6000) return text;
  const lower = text.toLowerCase();
  let earliestIdx = -1;

  const thenceMatch = text.match(/\bthence\b/i);
  if (thenceMatch) earliestIdx = thenceMatch.index;

  for (const ind of ['commencing at', 'commence at', 'beginning at', 'begin at']) {
    const idx = lower.indexOf(ind);
    if (idx !== -1 && (earliestIdx === -1 || idx < earliestIdx)) earliestIdx = idx;
  }

  for (const regex of [/\b(?:lot|tract|parcel)\s+\d+/i, /\bblock\s+[a-z0-9]\b/i, /\bsubdivision\b/i, /\breplat\s+of\b/i, /\bplat\s+book\b/i]) {
    const match = text.match(regex);
    if (match && (earliestIdx === -1 || match.index < earliestIdx)) earliestIdx = match.index;
  }

  let startIdx = earliestIdx !== -1 ? Math.max(0, earliestIdx - 1200) : 0;

  let endIdx = text.length;
  const searchAreaStart = earliestIdx !== -1 ? earliestIdx : 0;
  const searchArea = lower.substring(searchAreaStart);
  let earliestEndIdx = -1;
  for (const regex of [
    /^\s*schedule\s+b/im, /^\s*requirements/im, /^\s*exceptions\s+from\s+coverage/im,
    /^\s*exceptions:/im, /^\s*limitations\s+on\s+coverage/im, /^\s*exhibit\s+b/im,
  ]) {
    const match = searchArea.match(regex);
    if (match && (earliestEndIdx === -1 || match.index < earliestEndIdx)) earliestEndIdx = match.index;
  }
  if (earliestEndIdx !== -1) endIdx = Math.min(text.length, searchAreaStart + earliestEndIdx + 100);

  if (startIdx > 0 || endIdx < text.length) {
    return text.substring(startIdx, endIdx);
  }
  return text;
}

// ── State name / abbreviation lookup ─────────────────────────────────────────

const STATE_ABBREVS = {
  AL:'Alabama', AK:'Alaska', AZ:'Arizona', AR:'Arkansas', CA:'California',
  CO:'Colorado', CT:'Connecticut', DE:'Delaware', FL:'Florida', GA:'Georgia',
  HI:'Hawaii', ID:'Idaho', IL:'Illinois', IN:'Indiana', IA:'Iowa',
  KS:'Kansas', KY:'Kentucky', LA:'Louisiana', ME:'Maine', MD:'Maryland',
  MA:'Massachusetts', MI:'Michigan', MN:'Minnesota', MS:'Mississippi',
  MO:'Missouri', MT:'Montana', NE:'Nebraska', NV:'Nevada', NH:'New Hampshire',
  NJ:'New Jersey', NM:'New Mexico', NY:'New York', NC:'North Carolina',
  ND:'North Dakota', OH:'Ohio', OK:'Oklahoma', OR:'Oregon', PA:'Pennsylvania',
  RI:'Rhode Island', SC:'South Carolina', SD:'South Dakota', TN:'Tennessee',
  TX:'Texas', UT:'Utah', VT:'Vermont', VA:'Virginia', WA:'Washington',
  WV:'West Virginia', WI:'Wisconsin', WY:'Wyoming', DC:'District of Columbia',
};
const STATE_NAMES_UPPER = new Set(Object.values(STATE_ABBREVS).map(s => s.toUpperCase()));

export function inferCountyStateFromText(text) {
  if (!text || typeof text !== 'string') return { county: null, state: null };
  let county = null;
  let state  = null;

  const countyA = text.match(/\b([A-Z][a-zA-Z]{1,25}(?:\s+[A-Z][a-zA-Z]{1,25})?)\s+County\b/);
  if (countyA) {
    const raw = countyA[1].trim();
    if (!/^(this|said|the|a|an|each|any|that|such|my|our|your|their|which|what|above|following)$/i.test(raw)) {
      county = raw + ' County';
    }
  }
  if (!county) {
    const countyB = text.match(/\bCounty\s+of\s+([A-Z][a-zA-Z]{2,25}(?:\s+[A-Z][a-zA-Z]{2,25})?)\b/);
    if (countyB) county = countyB[1].trim() + ' County';
  }

  const stateC = text.match(/\bState\s+of\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\b/);
  if (stateC && STATE_NAMES_UPPER.has(stateC[1].trim().toUpperCase())) state = stateC[1].trim();

  if (!state) {
    const stateD = text.match(/\bCounty\s*,\s*([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\b/);
    if (stateD && STATE_NAMES_UPPER.has(stateD[1].trim().toUpperCase())) state = stateD[1].trim();
  }
  if (!state) {
    const stateE = text.match(/(?:County|Survey|Township|Section|Range|Tract|Parcel)[^A-Z]{0,30}\b([A-Z]{2})\b/);
    if (stateE && STATE_ABBREVS[stateE[1]]) state = STATE_ABBREVS[stateE[1]];
  }

  return { county: county || null, state: state || null };
}
