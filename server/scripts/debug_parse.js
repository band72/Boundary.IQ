import 'dotenv/config';
import fs from 'fs';
import { solveFromText } from '../services/Scripting/deedTextSolver.js';
import * as bp from '../services/Scripting/bearingParser.js';

const DEED_FILE = '/home/artwalk/Downloads/training-20260530T124201Z-3-001/training/Legal Descriptions/_extracted/REGENCY_2525.894 - Monument Road.txt';
const text = fs.readFileSync(DEED_FILE, 'utf8');

let normalizedText = text
  .replace(/[\r\n]+/g, ' ')
  .replace(/\s+/g, ' ')
  .replace(/[\u2018\u2019\u201A\u02BC\u00B4]/g, "'")
  .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
  .replace(/\u2032/g, "'")
  .replace(/\u2034/g, '"')
  .replace(/\uF0B0/g, '°')
  .replace(/\u00BA/g, '°')
  .replace(/\u02DA/g, '°')
  .replace(/\uFEFF/g, '');

normalizedText = normalizedText
  .replace(/\b([NSns])\.([0-9])/g, '$1$2')
  .replace(/([0-9"])\s*\.([EWew])\b/g, '$1$2')
  .replace(/([EWew])\.(?=\s|,|;|$)/g, '$1')
  .replace(/°'/g, '°');

const preparedText = normalizedText
  .replace(/\bTHENCE\s+CONTINUE(?:ING)?\b/gi, 'THENCE')
  .replace(/\bRUN\s+THENCE\b/gi, 'THENCE')
  .replace(/\bTHEN\s+(?=(?:NORTH|SOUTH|[NSns])\b\s*[.\d])/gi, 'THENCE ')
  .replace(/\bCONTINU(?:ING|E)\s+(?:ALONG\s+[^,;.]{0,40}\s+)?(?=(?:NORTH|SOUTH|[NSns])\b\s*[.\d°])/gi, 'THENCE ')
  .replace(/\bRUN\s+(?=(?:NORTH|SOUTH|[NSns])\b\s*[.\d°])/gi, 'THENCE ');

const rawSegments = preparedText.split(/\b(THENCE|COMMENCE)\b/i);

const courses = [];
const commencementSegments = [];
let reachedPob = false;

for (let i = 1; i < rawSegments.length; i += 2) {
  const keyword = rawSegments[i].toUpperCase();
  const content = rawSegments[i + 1] || '';
  const cleanContent = content.replace(/\(.*?\)/g, ' ').trim();

  const isPobDest = /\b(TO\s+(?:THE\s+|A\s+)?(Point of Beginning|P\.?O\.?B\.?)|SAID\s+POINT\s+OF\s+BEGINNING|FOR\s+(?:THE\s+|A\s+)?POINT\s+OF\s+BEGINNING)\b/i.test(cleanContent);
  const isFromPob = /\bFROM\s+(?:THE\s+)?POINT\s+OF\s+BEGINNING\b/i.test(cleanContent);

  console.log(`\nLoop i=${i} keyword=${keyword} reachedPob=${reachedPob}`);
  console.log(`cleanContent: "${cleanContent}"`);
  console.log(`isPobDest: ${isPobDest}, isFromPob: ${isFromPob}`);

  let type = 'Line';
  const allDistMatches = [...cleanContent.matchAll(/\b([\d,]+\.?\d*)\s*(?:FEET|FT\.?|METERS|M\.)\b/gi)];
  const allDistValues  = allDistMatches.map(m => parseFloat(m[1].replace(/,/g, '')));
  let distance = allDistValues[0] ?? null;

  const bearingContent = cleanContent
    .replace(/\b([NSns])\.([0-9])/g, '$1$2')
    .replace(/([0-9"])\s*\.([EWew])\b/g, '$1$2');

  const bearingMatch = bearingContent.match(
    /\b(N|S|NORTH|SOUTH)\s*\.?\s*(\d{1,6}\s*(?:DEGREES?|°|-)?\s*(?:\d{1,2}\s*(?:MINUTES?|'|-)?\s*(?:\d{1,2}(?:\.\d+)?\s*(?:SECONDS?|"))?)?(?:\d{1,2}(?:\.\d+)?)?)\s*\.?\s*(E|W|EAST|WEST)\b/i
  );

  let bearing = null;
  if (bearingMatch) {
    try {
      const parsedBrg = bp.parse(bearingMatch[0]);
      bearing = bp.toDisplayString(parsedBrg.azimuthDeg);
    } catch (e) {
      console.log('bearing parse fail:', e.message);
    }
  }

  const segmentObj = { type, bearing, distance };
  console.log(`parsed segment:`, segmentObj);

  if (keyword === 'COMMENCE') {
    commencementSegments.push(segmentObj);
    if (isPobDest || isFromPob) reachedPob = true;
  } else if (reachedPob) {
    courses.push(segmentObj);
  } else {
    commencementSegments.push(segmentObj);
    if (isPobDest || isFromPob) reachedPob = true;
  }
}

console.log('\n--- FINAL RESULT ---');
console.log('commencementSegments:', commencementSegments);
console.log('courses:', courses);
