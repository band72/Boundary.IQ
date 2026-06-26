import * as bp from '../services/Scripting/bearingParser.js';
import { solveFromCourses } from '../services/Scripting/deedTextSolver.js';

function solveFromTextNew(deedText, options = {}) {
  const text = deedText || '';

  let pobNorthing = options.pobNorthing ?? 5000;
  let pobEasting  = options.pobEasting  ?? 5000;
  const pobMatch = text.match(/Northing\s+([\d,]+\.?\d*)[,\s]+Easting\s+([\d,]+\.?\d*)/i);
  if (pobMatch) {
    pobNorthing = parseFloat(pobMatch[1].replace(/,/g, ''));
    pobEasting  = parseFloat(pobMatch[2].replace(/,/g, ''));
  }

  // Normalize spaces and strip breaks
  const normalizedText = text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ');

  // Split into tokens based on COMMENCE or THENCE
  const rawSegments = normalizedText.split(/\b(THENCE|COMMENCE)\b/i);
  
  const courses = [];
  const commencementSegments = [];
  let reachedPob = false;
  let lastMentionedRadius = null;

  for (let i = 1; i < rawSegments.length; i += 2) {
    const keyword = rawSegments[i].toUpperCase();
    const content = rawSegments[i + 1] || '';
    const cleanContent = content.replace(/\(.*?\)/g, ' ').trim();

    // Check if contains POB indicators to mark when we transition from commencement to boundary
    const isPobDest = /\b(TO\s+(?:THE\s+|A\s+)?POINT\s+OF\s+BEGINNING|TO\s+(?:THE\s+)?P\.?\s*O\.?\s*B\.?)\b/i.test(cleanContent);

    // Classification of Segment Type
    const hasToPointOfCurve = /\b(TO\s+(?:THE\s+|A\s+)?POINT\s+OF\s+(?:CURVE|CURVATURE))\b/i.test(cleanContent);
    let type = 'Line';
    if (!hasToPointOfCurve) {
      if (/\b(ALONG\s+THE\s+ARC|ALONG\s+A\s+CURVE|CONTINUE\s+ALONG|ALONG\s+SAID\s+CURVE|WESTERLY\s+ALONG\s+THE\s+ARC|ALONG\s+THE\s+NORTHERLY\s+RIGHT|ALONG\s+SAID\s+NORTHERLY\s+RIGHT)\b/i.test(cleanContent) && /\b(CURVE|ARC)\b/i.test(cleanContent)) {
        type = 'Curve';
      } else if (/\b(CURVE|ARC|RADIUS)\b/i.test(cleanContent) && !/\b(TO\s+AN?\s+INTERSECTION|INTERSECTING)\b/i.test(cleanContent)) {
        type = 'Curve';
      }
    }

    // Distance parsing
    const distMatch = cleanContent.match(/\b([\d,]+\.?\d*)\s*(?:FEET|FT|METERS|M)\b/i);
    const distance = distMatch ? parseFloat(distMatch[1].replace(/,/g, '')) : null;

    // Bearing parsing
    let bearing = null;
    let isUnknown = false;
    const bearingMatch = cleanContent.match(/\b(N|S|NORTH|SOUTH)\s*(\d{1,3}(?:\s*DEGREES?|\s*°|\s*\-)?\s*(?:\d{1,2}\s*(?:MINUTES?|'|\s*\-))?\s*(?:\d{1,2}(?:\.\d+)?\s*(?:SECONDS?|"|\s*\-))?)\s*(E|W|EAST|WEST)\b/i);
    
    if (bearingMatch) {
      try {
        const parsedBrg = bp.parse(bearingMatch[0]);
        bearing = bp.toDisplayString(parsedBrg.azimuthDeg);
      } catch {
        isUnknown = true;
      }
    } else {
      // Look for cardinal words
      const cardMatch = cleanContent.match(/\b(NORTH|SOUTH|EAST|WEST|NORTHERLY|SOUTHERLY|EASTERLY|WESTERLY|NORTHEASTERLY|NORTHWESTERLY|SOUTHEASTERLY|SOUTHWESTERLY|NORTHEAST|NORTHWEST|SOUTHEAST|SOUTHWEST)\b/i);
      if (cardMatch) {
        const az = bp.parseCardinalAzimuth(cardMatch[1]);
        if (az !== null) {
          bearing = bp.toDisplayString(az);
        } else {
          isUnknown = true;
        }
      } else {
        isUnknown = true;
      }
    }

    // Radius tracking
    const radiusMatch = cleanContent.match(/RADIUS\s+OF\s+([\d,]+\.?\d*)/i);
    if (radiusMatch) {
      lastMentionedRadius = parseFloat(radiusMatch[1].replace(/,/g, ''));
    }

    const segmentObj = {
      type,
      description: keyword + ' ' + content.trim(),
    };

    if (type === 'Line') {
      segmentObj.bearing = bearing;
      segmentObj.distance = distance;
      segmentObj.isUnknown = isUnknown || distance === null;
    } else {
      // Curve parsing
      const arcMatch = cleanContent.match(/(?:ARC\s+DISTANCE|ARC\s+LENGTH|ARC)\s+OF\s+([\d,]+\.?\d*)/i);
      const arcLength = arcMatch ? parseFloat(arcMatch[1].replace(/,/g, '')) : distance;
      
      const dirMatch = cleanContent.match(/CURVE\s+TO\s+THE\s+(RIGHT|LEFT)/i);
      const curveDirection = dirMatch ? (dirMatch[1].toUpperCase() === 'RIGHT' ? 'Right' : 'Left') : 'Right';
      
      segmentObj.radius = lastMentionedRadius;
      segmentObj.arcLength = arcLength;
      segmentObj.curveDirection = curveDirection;
      segmentObj.isUnknown = !segmentObj.radius || !segmentObj.arcLength;
    }

    if (reachedPob) {
      courses.push(segmentObj);
    } else {
      commencementSegments.push(segmentObj);
      if (isPobDest) {
        reachedPob = true;
      }
    }
  }

  if (courses.length === 0 && commencementSegments.length > 0) {
    courses.push(...commencementSegments);
    commencementSegments.length = 0;
  }

  const solved = solveFromCourses(courses, {
    pobNorthing,
    pobEasting,
    units: options.units || 'Feet',
    isOpenEnded: options.isOpenEnded,
    commencementSegments
  });
  return {
    ...solved,
    commencementSegments
  };
}

const parcelMText = `A PART OF SECTIONS 13 AND 24, TOWNSHIP 2 SOUTH, RANGE 27 EAST, DUVAL
COUNTY, FLORIDA, MORE PARTICULARLY DESCRIBED AS FOLLOWS: COMMENCE AT
THE NORTHEASTERLY CORNER OF SAID SECTION 24; THENCE SOUTH 89 DEGREES 41
MINUTES 10 SECONDS WEST ALONG THE NORTHERLY LINE OF SAID SECTION 24,
1150.02 FEET TO THE WESTERLY RIGHT OF WAY LINE OF MONUMENT ROAD (AS
ESTABLISHED FOR A WIDTH OF 100 FEET); THENCE SOUTH 00 DEGREES 18 MINUTES
50 SECONDS EAST ALONG SAID WESTERLY RIGHT OF WAY LINE, 431.02 FEET TO ITS
INTERSECTION WITH THE NORTHERLY RIGHT OF WAY LINE OF THE ARLINGTON
EXPRESSWAY; THENCE SOUTH 83 DEGREES 17 MINUTES 50 SECONDS WEST ALONG
SAID NORTHERLY RIGHT OF WAY LINE, 690.41 FEET TO THE POINT OF CURVE TO THE
RIGHT, SAID CURVE BEING CONCAVE NORTHERLY AND HAVING A RADIUS OF 5679.65
FEET; THENCE ALONG THE ARC OF SAID CURVE AND ALONG SAID NORTHERLY RIGHT
OF WAY LINE AN ARC DISTANCE OF 1366.68 FEET TO THE POINT OF BEGINNING;
THENCE CONTINUE ALONG THE ARC OF SAID CURVE AND ALONG SAID NORTHERLY
RIGHT OF WAY LINE AN ARC DISTANCE OF 207.84 FEET; THENCE NORTH 00 DEGREES
18 MINUTES 50 SECONDS WEST ALONG SAID RIGHT OF WAY LINE, 33.45 FEET TO AN
INTERSECTION WITH A CURVE CONCAVE NORTHERLY HAVING A RADIUS OF 5646.65
FEET; THENCE WESTERLY ALONG THE ARC OF SAID CURVE AND ALONG SAID
NORTHERLY RIGHT OF WAY LINE AN ARC DISTANCE OF 521.44 FEET; THENCE NORTH
08 DEGREES 02 MINUTES 40 SECONDS EAST, 438.26 FEET; THENCE NORTH 89
DEGREES 41 MINUTES 23 SECONDS EAST, 146.17 FEET; THENCE NORTH 00 DEGREES
18 MINUTES 37 SECONDS WEST, 2.76 FEET; THENCE NORTH 89 DEGREES 41 MINUTES
23 SECONDS EAST, 99.48 FEET; THENCE NORTH 44 DEGREES 41 MINUTES 23 SECONDS
EAST, 112.89 FEET; THENCE SOUTH 45 DEGREES 18 MINUTES 37 SECONDS EAST, 28.08
FEET; THENCE NORTH 44 DEGREES 41 MINUTES 23 SECONDS EAST, 28 FEET; THENCE
SOUTH 45 DEGREES 18 MINUTES 37 SECONDS EAST, 143.16 FEET; THENCE SOUTH 44
DEGREES 41 MINUTES 23 SECONDS WEST, 28 FEET; THENCE SOUTH 45 DEGREES 18
MINUTES 37 SECONDS EAST, 28 FEET; THENCE SOUTH 44 DEGREES 41 MINUTES 23
SECONDS WEST, 56 FEET; THENCE SOUTH 45 DEGREES 18 MINUTES 37 SECONDS
EAST, 117.96 FEET; THENCE NORTH 89 DEGREES 41 MINUTES 23 SECONDS EAST,
70.80 FEET; THENCE SOUTH 00 DEGREES 18 MINUTES 37 SECONDS EAST, 98.0 FEET;
THENCE NORTH 89 DEGREES 41 MINUTES 23 SECONDS EAST, 70.41 FEET; THENCE
SOUTH 00 DEGREES 18 MINUTES 37 SECONDS EAST, 328.37 FEET TO THE POINT OF
BEGINNING.`;

const result = solveFromTextNew(parcelMText);
console.log('--- ORIGINAL COURSES ---');
result.originalCourses.forEach((c, idx) => console.log(`Orig [${idx+1}] type=${c.type} bearing=${c.bearing} distance=${c.distance} radius=${c.radius} arcLength=${c.arcLength} isUnknown=${c.isUnknown}`));
console.log('--- REPAIRED RUNS ---');
result.repairedCourses.forEach((c, idx) => console.log(`Rep [${idx+1}] type=${c.type} bearing=${c.bearing} distance=${c.distance} radius=${c.radius} arcLength=${c.arcLength}`));
if (result.traverse) {
  console.log('Linear Closure Error:', result.traverse.closure.linearError.toFixed(4));
  console.log('Precision Ratio:', result.traverse.closure.precisionRatio);
} else {
  console.log('No traverse computed (traverse is null)');
}
console.log('Status:', result.status);
