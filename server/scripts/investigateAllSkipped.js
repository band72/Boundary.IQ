import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, '..');
const DEED_DIR = '/home/artwalk/Downloads/training-20260530T124201Z-3-001/training/Legal Descriptions';
const EXTRACT_DIR = path.join(DEED_DIR, '_extracted');
const REPORT_FILE = path.resolve(SERVER_DIR, '../deed_batch_report.json');

if (!fs.existsSync(REPORT_FILE)) {
  console.error(`Report file not found at ${REPORT_FILE}`);
  process.exit(1);
}

const report = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8'));
const skipped = report.results.filter(r => r.status === 'SKIPPED');

console.log(`🔍 Detailed investigation of ${skipped.length} skipped deeds...\n`);

// 1. Regexes for bearings:
// a. Standard DMS bearing (with or without degrees/minutes symbols, supporting spelling)
const dmsBearing = /\b(?:NORTH|SOUTH|[NS])\b\s*\d+(?:[\s°\-d:]+\d+)?(?:[\s'\-m:]+\d+)?[\s"\-s:]*\b(?:EAST|WEST|[EW])\b/i;
// b. Simplified bearing like "N 45 E" or "South 89 West"
const simpleBearing = /\b(?:NORTH|SOUTH|[NS])\b\s*\d+\s*\b(?:EAST|WEST|[EW])\b/i;
// c. Due directions: "due North", "due South"
const dueDirection = /\bdue\s+(?:North|South|East|West)\b/i;

// 2. Regexes for distances:
// Support feet, ft, chains, ch, rods, poles, links, meters
const distanceRegex = /\b\d+(?:\.\d+)?\s*(?:FEET|FT|CHAINS?|CH|RODS?|POLES?|LINKS?|METERS|M\b)/i;

// 3. Regexes for curves:
const curveKeywords = /\b(?:radius|arc\s+length|tangent\s+bearing|concave)\b/i;

const potentialTraverses = [];

for (const item of skipped) {
  const ext = path.extname(item.fileName).toLowerCase();
  const base = path.basename(item.fileName, ext);
  const textPath = path.join(EXTRACT_DIR, base + '.txt');

  if (!fs.existsSync(textPath)) continue;

  const text = fs.readFileSync(textPath, 'utf8');

  // Skip lines from OCR header/metadata to avoid false matches on filename/dates
  const bodyText = text
    .split('\n')
    .filter(line => !line.startsWith('SOURCE:') && !line.startsWith('FOLDER:') && !line.includes('==='))
    .join('\n');

  const matchesDms = bodyText.match(dmsBearing);
  const matchesSimple = bodyText.match(simpleBearing);
  const matchesDue = bodyText.match(dueDirection);
  const matchesDistance = bodyText.match(distanceRegex);
  const matchesCurve = bodyText.match(curveKeywords);

  const hasBearing = matchesDms || matchesSimple || matchesDue;
  const hasDistance = matchesDistance;
  const hasCurve = matchesCurve;

  // A file is highly likely to be traversable if it has:
  // (bearing and distance) OR (curve and distance) OR (explicit traverse words like POB / thence / commence and any bearing/distance)
  const hasTraverseKeywords = /\b(?:thence|commence|p\.?o\.?b\.?|point\s+of\s+beginning)\b/i.test(bodyText);

  let isCandidate = false;
  let reason = '';

  if (hasBearing && hasDistance) {
    isCandidate = true;
    reason = `Bearing ("${(matchesDms || matchesSimple || matchesDue)[0]}") & Distance ("${matchesDistance[0]}")`;
  } else if (hasCurve && hasDistance) {
    isCandidate = true;
    reason = `Curve keyword ("${matchesCurve[0]}") & Distance ("${matchesDistance[0]}")`;
  } else if (hasTraverseKeywords && (hasBearing || hasDistance)) {
    isCandidate = true;
    reason = `Traverse keywords & ${(hasBearing ? 'Bearing' : 'Distance')}`;
  }

  // Check if it's Lot & Block: if it's already classified as lot/block or contains lots/blocks, we don't want false positives
  const isLotBlock = /\b(?:lot|block|plat|subdivision)\b/i.test(bodyText) && !bodyText.includes('described as follows');

  if (isCandidate) {
    potentialTraverses.push({
      fileName: item.fileName,
      reason,
      isLotBlock,
      snippet: bodyText.replace(/\s+/g, ' ').slice(0, 300)
    });
  }
}

console.log(`📋 Total skipped analyzed: ${skipped.length}`);
console.log(`🚨 Found ${potentialTraverses.length} files matching metes-and-bounds signatures:\n`);

for (const p of potentialTraverses) {
  console.log(`📄 File: ${p.fileName}`);
  console.log(`   Classification: ${p.isLotBlock ? 'Lot & Block (Possible false positive)' : 'Metes & Bounds'}`);
  console.log(`   Detection Reason: ${p.reason}`);
  console.log(`   Snippet: ${p.snippet}`);
  console.log('-'.repeat(80));
}
