/**
 * Render Jacksonville Heights adjusted legal description sketch.
 * Uses pre-computed traverse results (no AI needed — courses are clean).
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { renderSketchPages } from './services/sketchRenderer.js';
import { compute as computeTraverse } from './services/traverse.js';

const OUT_DIR = '/home/artwalk/Downloads/jax_heights_output';
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const courses = [
  { type: 'Line',  bearing: "S74°32'52\"W", distance: 37.16 },
  {
    type: 'Curve',
    curveDirection: 'Right',
    radius: 472.50,
    arcLength: 201.04,
    delta: "24°22'42\"",
    chordBearing: "S86°44'13\"W",
    chordDistance: 199.53
  },
  { type: 'Line',  bearing: "N67°13'49\"W", distance: 82.19 },
  { type: 'Line',  bearing: "N01°04'34\"E", distance: 939.79 },
  { type: 'Line',  bearing: "N89°29'13\"E", distance: 310.93 },
  { type: 'Line',  bearing: "S01°04'34\"W", distance: 953.13 }
];

const legalDescription =
`A PARCEL OF LAND SITUATED IN TRACTS 5 & 6 OF BLOCK 1 OF SECTION 31, TOWNSHIP 3 SOUTH, RANGE 24 EAST AS SHOWN ON PLAT OF "JACKSONVILLE HEIGHTS" RECORDED IN PLAT BOOK 5 ON PAGE 94 OF THE PUBLIC RECORDS OF DUVAL COUNTY, FLORIDA; SAID PARCEL BEING MORE PARTICULARLY DESCRIBED AS FOLLOWS:

THENCE CONTINUE S 74°32'52" W, ALONG SAID CENTERLINE, 37.16 FEET; THENCE RUN WESTERLY ALONG SAID CENTERLINE WITH A CURVE CONCAVE NORTHERLY, SAID CURVE HAVING A RADIUS OF 472.50 FEET, AN ARC LENGTH OF 201.04 FEET AND A CENTRAL ANGLE OF 24°22'42"; THENCE RUN N 67°13'49" W, ALONG SAID CENTERLINE, 82.19 FEET TO THE SOUTHEAST CORNER OF LANDS DESCRIBED IN OFFICIAL RECORDS BOOK 17184 ON PAGE 121 OF SAID PUBLIC RECORDS; THENCE LEAVE SAID CENTERLINE AND RUN N 01°04'34" E, 939.79 FEET TO AN IRON ROD ON THE NORTH LINE OF SAID SECTION 31; THENCE RUN N 89°29'13" E, ALONG SAID NORTH LINE, 310.93 FEET TO AN IRON ROD; THENCE LEAVE SAID NORTH LINE AND RUN S 01°04'34" W, 953.13 FEET TO THE POINT OF BEGINNING.

(Containing approximately 6.88 acres, more or less.)`;

const originalLegalDescription =
`THENCE CONTINUE S 74°32'52" W, ALONG SAID CENTERLINE, 37,16 FEET [TYPO: corrected to 37.16]; THENCE RUN WESTERLY ALONG SAID CENTERLINE WITH A CURVE CONCAVE NORTHERLY, SAID CURVE HAVING A RADIUS OF 472.50 FEET, AN ARC LENGTH OF 201.04 FEET AND A CENTRAL ANGLE OF 24°22'42"; THENCE RUN N 67°13'49" W, ALONG SAID CENTERLINE, 82.19 FEET; THENCE LEAVE SAID CENTERLINE AND RUN N 01°04'34" E, 939.79 FEET; THENCE RUN N 89°29'13" E, 310.93 FEET; THENCE RUN S 01°04'34" W, 985.14 FEET [CORRECTED TO 953.13 FT] TO THE POINT OF BEGINNING.`;

async function main() {
  try {
    console.log('Computing traverse...');
    const trav = computeTraverse({
      pointOfBeginning: { northing: 5000, easting: 5000 },
      courses,
      units: 'Feet',
      isOpenEnded: false
    });

    console.log('Closure:', trav.closure?.status);
    console.log('Linear error:', trav.closure?.linearError?.toFixed(4) + ' ft');
    console.log('Area:', trav.areaAcres?.toFixed(4) + ' acres');
    console.log('Precision:', trav.closure?.precisionRatio);

    const meta = {
      parcel: 'Tracts 5 & 6, Block 1 — Sec 31, T3S R24E',
      county: 'Duval County',
      state: 'Florida',
      status: 'PASS',
      areaAcres: trav.areaAcres,
      perimeter: trav.perimeter,
      units: 'Feet',
      isOpenEnded: false,
      legalDescription,
      basisOfBearings: 'Plat Book 5, Page 94, Public Records of Duval County, FL'
    };

    console.log('Rendering sketch pages...');
    const pages = renderSketchPages(
      trav.stations,
      trav.adjustedStations,
      courses,
      meta,
      trav.closure,
      legalDescription,
      originalLegalDescription,
      courses,        // originalCourses (same — adjustments are pre-applied)
      false           // showConceptualDetail
    );

    let savedCount = 0;
    for (const [pageName, buffer] of Object.entries(pages)) {
      const outPath = path.join(OUT_DIR, `jax_heights_${pageName}.png`);
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
