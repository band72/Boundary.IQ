/**
 * Render Jacksonville Heights — Tract 13, Block 4 sketch.
 * As-stated courses with closure analysis and discrepancy notes.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { renderSketchPages } from './services/sketchRenderer.js';
import { compute as computeTraverse } from './services/traverse.js';

const OUT_DIR = '/home/artwalk/Downloads/tract13_output';
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// As-stated courses from the legal description
const courses = [
  { type: 'Line', bearing: "S00°14'51\"W", distance: 1283.77, description: 'East line Tract 13 → SE corner' },
  { type: 'Line', bearing: "S89°21'43\"W", distance: 332.00,  description: 'South line Tract 13' },
  { type: 'Line', bearing: "N00°14'47\"W", distance: 801.84,  description: 'West line Tract 13' },
  { type: 'Line', bearing: "N89°43'05\"E", distance: 180.00,  description: 'Depart west line' },
  { type: 'Line', bearing: "N00°14'47\"E", distance: 484.00,  description: 'North to Riddle Rd ROW' },
  { type: 'Line', bearing: "N89°43'05\"E", distance: 152.00,  description: 'Along Riddle Rd ROW to POB' },
];

const legalDescription =
`A PART OF TRACT 13, BLOCK 4, JACKSONVILLE HEIGHTS AS RECORDED IN PLAT BOOK 5, PAGE 93 OF THE CURRENT PUBLIC RECORDS OF DUVAL COUNTY, FLORIDA, LYING WITHIN SECTION 17, TOWNSHIP 2 SOUTH, RANGE 25 EAST AND BEING MORE PARTICULARLY DESCRIBED AS FOLLOWS:

FOR A POINT OF REFERENCE COMMENCE AT THE CENTERLINE INTERSECTION OF MAPLE AVENUE WITH THE CENTERLINE OF RIDDLE ROAD; THENCE S.89°43'05"W. ALONG THE CENTERLINE OF RIDDLE ROAD A DISTANCE OF 986.72 FEET TO A POINT; THENCE S.00°14'51"W. A DISTANCE OF 30.00 FEET TO AN INTERSECTION WITH THE SOUTHERLY RIGHT OF WAY LINE OF RIDDLE ROAD AND THE NORTHEAST CORNER OF SAID TRACT 13 AND THE POINT OF BEGINNING;

THENCE S.00°14'51"W. ALONG THE EAST LINE OF TRACT 13 A DISTANCE OF 1283.77 FEET TO THE SOUTHEAST CORNER OF SAID TRACT 13; THENCE S.89°21'43"W. ALONG THE SOUTH LINE OF TRACT 13, A DISTANCE OF 332.00 FEET; THENCE N.00°14'47"W. ALONG THE WEST LINE OF TRACT 13, A DISTANCE OF 801.84 FEET; THENCE N.89°43'05"E. DEPARTING SAID WEST LINE A DISTANCE OF 180.00 FEET; THENCE N.00°14'47"E. A DISTANCE OF 484.00 FEET TO AN INTERSECTION WITH THE SOUTHERLY RIGHT OF WAY LINE OF RIDDLE ROAD; THENCE N.89°43'05"E. ALONG SAID RIGHT OF WAY LINE A DISTANCE OF 152.00 FEET TO THE POINT OF BEGINNING.

CONTAINING 7.79 ACRES MORE OR LESS. FILE NO. C-50. MARVIN R. BANKS SURVEYORS, INC., DATED JANUARY 23, 2003.`;

async function main() {
  try {
    console.log('Computing traverse (as-stated)...');
    const trav = computeTraverse({
      pointOfBeginning: { northing: 5000, easting: 5000 },
      courses, units: 'Feet', isOpenEnded: false
    });

    console.log('Closure:', trav.closure?.status);
    console.log('Linear error:', trav.closure?.linearError?.toFixed(4) + ' ft');
    console.log('Error Northing:', trav.closure?.errorNorthing?.toFixed(4) + ' ft');
    console.log('Error Easting:', trav.closure?.errorEasting?.toFixed(4) + ' ft');
    console.log('Area:', trav.areaAcres?.toFixed(4) + ' acres  (stated: 7.79 ac)');
    console.log('Precision:', trav.closure?.precisionRatio);

    const meta = {
      parcel: 'Tract 13, Block 4 — Jacksonville Heights, Sec 17, T2S R25E',
      county: 'Duval County',
      state: 'Florida',
      status: 'FAIL',
      areaAcres: trav.areaAcres,
      perimeter: trav.perimeter,
      units: 'Feet',
      isOpenEnded: false,
      legalDescription,
      basisOfBearings: 'Plat Book 5, Page 93, Duval Co., FL — File No. C-50 (Marvin R. Banks Surveyors)',
    };

    console.log('\nRendering sketch pages...');
    const pages = renderSketchPages(
      trav.stations,
      trav.adjustedStations,
      courses,
      meta,
      trav.closure,
      legalDescription,
      legalDescription,
      courses,
      false
    );

    let savedCount = 0;
    for (const [pageName, buffer] of Object.entries(pages)) {
      const outPath = path.join(OUT_DIR, `tract13_${pageName}.png`);
      fs.writeFileSync(outPath, buffer);
      console.log(`✓ Saved: ${path.basename(outPath)} (${Math.round(buffer.length / 1024)} KB)`);
      savedCount++;
    }

    console.log(`\nDone — ${savedCount} page(s) written to: ${OUT_DIR}`);
  } catch (err) {
    console.error('Error:', err.message);
    console.error(err.stack);
  }
}

main();
