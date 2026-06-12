import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { solveFromCourses } from './services/deedTextSolver.js';
import { renderSketchPages } from './services/sketchRenderer.js';

const deedText = `A PART OF TRACT 13, BLOCK 4, JACKSONVILLE HEIGHTS AS RECORDED IN PLAT BOOK 5, PAGE 93 OF THE CURRENT PUBLIC RECORDS OF DUVAL COUNTY, FLORIDA, LYING WITHIN SECTION 17, TOWNSHIP 2 SOUTH, RANGE 25 EAST AND BEING MORE PARTICULARLY DESCRIBED AS FOLLOWS:  FOR A POINT OF REFERENCE COMMENCE AT THE CENTERLINE INTERSECTION OF MAPLE AVENUE ( AS NOW ESTABLISHED AS A 60 FOOT RIGHT OF WAY) WITH THE CENTERLINE  OF RIDDLE ROAD ( AS NOW ESTABLISHED FOR A WIDTH OF 60 FEET; THENCE S.8943’05 “W. ALONG THE CENTERLINE OF RIDDLE ROAD A DISTANCE OF 1318.72 FEET TO A POINT; THENCE S.0014’47”W. A DISTANCE OF 30.00 FEET TO AN INTERSECTION WITH THE SOUTHERLY RIGHT OF WAY LINE OF RIDDLE ROAD AND A POINT ON THE WEST LINE OF SAID TRACT 13 AND THE POINT OF BEGINNING; THENCE N.8943’05”E. ALONG SAID RIGHT OF WAY LINE A DISTANCE OF 180.00 FEET; THENCE S.0014’47”W. A DISTANCE OF 242.00 FEET; THENCE S.8943’05”W. A DISTANCE OF 180.00 FEET TO AN INTERSECTION WITH THE WEST LINE OF SAID TRACT 13; THENCE N.0014’47”E. ALONG SAID WEST LINE A DISTANCE OF 242.00 FEET TO THE POINT OF BEGINNING. CONTAINING 1.0 ACRES MORE OR LESS AND BEING SHOWN ON A BOUNDARY SURVEY PREPARED BY MARVIN R. BANKS SURVEYORS, INC, DATED JANUARY 23, 2003, HAVING FILE NO. A-849E. THE ABOVE DESCRIBED BEING TOGETER WITH AND SUBJECT TO AN EASEMENT FOR INGRESS , EGRESS AND UTILITIES OVER THE WESTERLY 30 FEET THEREOF.`;

// The boundary courses start at the Point of Beginning (POB).
const courses = [
  {
    type: 'Line',
    bearing: 'N89°43\'05"E',
    distance: 180.00,
    isUnknown: false,
    description: 'THENCE N.8943’05”E. ALONG SAID RIGHT OF WAY LINE A DISTANCE OF 180.00 FEET'
  },
  {
    type: 'Line',
    bearing: 'S00°14\'47"W',
    distance: 242.00,
    isUnknown: false,
    description: 'THENCE S.0014’47”W. A DISTANCE OF 242.00 FEET'
  },
  {
    type: 'Line',
    bearing: 'S89°43\'05"W',
    distance: 180.00,
    isUnknown: false,
    description: 'THENCE S.8943’05”W. A DISTANCE OF 180.00 FEET TO AN INTERSECTION WITH THE WEST LINE OF SAID TRACT 13'
  },
  {
    type: 'Line',
    bearing: 'N00°14\'47"E',
    distance: 242.00,
    isUnknown: false,
    description: 'THENCE N.0014’47”E. ALONG SAID WEST LINE A DISTANCE OF 242.00 FEET TO THE POINT OF BEGINNING'
  }
];

const commencementSegments = [
  {
    type: 'Line',
    bearing: 'S89°43\'05"W',
    distance: 1318.72,
    isUnknown: false,
    description: 'THENCE S.8943’05 “W. ALONG THE CENTERLINE OF RIDDLE ROAD A DISTANCE OF 1318.72 FEET TO A POINT'
  },
  {
    type: 'Line',
    bearing: 'S00°14\'47"W',
    distance: 30.00,
    isUnknown: false,
    description: 'THENCE S.0014’47”W. A DISTANCE OF 30.00 FEET TO AN INTERSECTION WITH THE SOUTHERLY RIGHT OF WAY LINE OF RIDDLE ROAD AND A POINT ON THE WEST LINE OF SAID TRACT 13 AND THE POINT OF BEGINNING'
  }
];

async function main() {
  console.log('Solving traverse from courses...');
  const solveResult = solveFromCourses(courses, {
    pobNorthing: 5000,
    pobEasting: 5000,
    units: 'Feet'
  });

  console.log('Rendering sketch pages...');
  const meta = {
    parcel: 'TRACT 13, BLOCK 4, JACKSONVILLE HEIGHTS',
    county: 'DUVAL COUNTY',
    state: 'FLORIDA',
    status: solveResult.status,
    areaAcres: solveResult.traverse.areaAcres,
    perimeter: solveResult.traverse.perimeter,
    units: 'Feet',
    legalDescription: solveResult.legalDescription,
    basisOfBearings: 'DEED OF RECORD',
    theme: 'blueprint'
  };

  const pages = renderSketchPages(
    solveResult.traverse.stations,
    solveResult.traverse.adjustedStations,
    solveResult.repairedCourses,
    meta,
    solveResult.traverse.closure,
    solveResult.legalDescription,
    deedText,
    solveResult.originalCourses,
    true, // showConceptualDetail
    true, // blueprintTheme
    deedText // rawOcrText
  );

  const outputDir = '/home/artwalk/.gemini/antigravity/brain/8e464ea5-6cce-48df-9696-01380ebee599/artifacts';
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  for (const [pageName, buffer] of Object.entries(pages)) {
    const outputPath = path.join(outputDir, `${pageName}.png`);
    fs.writeFileSync(outputPath, buffer);
    console.log(`Saved ${pageName} to ${outputPath}`);
  }
  
  console.log('Successfully completed sketch generation!');
}

main();
