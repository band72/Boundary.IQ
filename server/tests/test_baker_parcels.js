import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { solveDeedText } from '../services/Scripting/deedTextSolver.js';
import { renderSketchPages } from '../services/sketchRenderer.js';

const parcelHText = `PARCEL "H"
A part of Government Lots 4 and 5, Section 36, Township 2 South, Range 20 East, Baker County, Florida and being more particularly described as follows: Commence at the Southeast corner of said lot 5; hence South 85 degrees, 54 minutes, 23 seconds West and along the South line of said lot 5, 59.65 feet to the East right of way line of County Road #127; thence North 3 degrees, 29 minutes, 08 seconds West and along said right of way, 867.79 feet to the Point of Beginning; thence continue North 3 degrees, 29 minutes, 08 seconds West and along said right of way, 277.79 feet; thence North 85 degrees, 54 minutes, 23 seconds East, 791.63 feet; thence South 0 degrees, 22 minutes, 46 seconds East, 278.36 feet; thence South 85 degrees, 54 minutes, 23 seconds West, 776.55 feet to the Point of Beginning. Containing 5.0 acres more or less.

Subject to that certain drainage easement as shown on County Road No. 127 dated, June, 1950.`;

const parcelIText = `PARCEL "I"
A part of Government Lots 4 and 5, Section 36, Township 2 South, Range 20 East, Baker County, Florida and being more particularly described as follows: Commence at the Southeast corner of said lot 5; hence South 85 degrees, 54 minutes, 23 seconds West and along the South line of said lot 5, 59.65 feet to the East right of way line of County Road #127; thence North 3 degrees, 29 minutes, 08 seconds West and along said right of way, 584.5 feet to the Point of Beginning; thence continue North 3 degrees, 29 minutes, 08 seconds West and along said right of way, 283.29 feet; thence North 85 degrees, 54 minutes, 23 seconds East, 776.55 feet; thence South 0 degrees, 22 minutes, 46 seconds East, 283.87 feet; thence South 85 degrees, 54 minutes, 23 seconds West, 761.17 feet to the Point of Beginning. Containing 5.0 acres more or less.

Street Address: 10697 County Road 127, Sanderson, FL 32087`;

async function testParcel(name, text) {
  const model = 'deepseek-r1:14b';
  console.log(`\n==========================================`);
  console.log(`Processing ${name} using model: ${model}...`);
  console.log(`==========================================`);
  try {
    const result = await solveDeedText(text, model, {
      pobNorthing: 5000,
      pobEasting: 5000,
      units: 'Feet'
    });

    console.log(`Status: ${result.status}`);
    console.log(`Linear Closure Error: ${result.traverse?.closure?.linearError?.toFixed(6)} ft`);
    console.log(`Precision: ${result.traverse?.closure?.precisionRatio}`);
    console.log(`Perimeter: ${result.traverse?.perimeter?.toFixed(2)} ft`);
    console.log(`Area: ${result.traverse?.areaAcres?.toFixed(4)} Acres`);
    console.log(`Original course count: ${result.originalCourses?.length}`);
    console.log(`Repaired course count: ${result.repairedCourses?.length}`);
    console.log(`Commencement segment count: ${result.commencementSegments?.length}`);

    console.log('\n--- Original Courses ---');
    result.originalCourses.forEach((c, idx) => {
      console.log(`[${idx+1}] type=${c.type} bearing=${c.bearing} distance=${c.distance}`);
    });

    console.log('\n--- Repaired Courses ---');
    result.repairedCourses.forEach((c, idx) => {
      console.log(`[${idx+1}] type=${c.type} bearing=${c.bearing} distance=${c.distance}`);
    });

    console.log('\n--- Commencement Segments ---');
    result.commencementSegments.forEach((c, idx) => {
      console.log(`[${idx+1}] type=${c.type} bearing=${c.bearing} distance=${c.distance}`);
    });

    // Render sketches
    console.log(`\nRendering sketch pages for ${name}...`);
    const meta = {
      parcel: name,
      county: 'BAKER COUNTY',
      state: 'FLORIDA',
      status: result.status,
      areaAcres: result.traverse?.areaAcres,
      perimeter: result.traverse?.perimeter,
      units: 'Feet',
      legalDescription: result.legalDescription,
      basisOfBearings: 'DEED OF RECORD',
      theme: 'blueprint'
    };

    const pages = renderSketchPages(
      result.traverse.stations,
      result.traverse.adjustedStations,
      result.repairedCourses,
      meta,
      result.traverse.closure,
      result.legalDescription,
      text,
      result.originalCourses,
      true, // showConceptualDetail
      true, // blueprintTheme
      text // rawOcrText
    );

    const outputDir = '/home/artwalk/.gemini/antigravity-ide/brain/aa9cff52-2679-49d0-b685-1554f7ad3410';
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    for (const [pageName, buffer] of Object.entries(pages)) {
      const outputPath = path.join(outputDir, `${name.replace(/\s+/g, '_')}_${pageName}.png`);
      fs.writeFileSync(outputPath, buffer);
      console.log(`Saved page ${pageName} to ${outputPath}`);
    }

  } catch (err) {
    console.error(`Error in solving ${name}:`, err);
  }
}

async function main() {
  await testParcel('PARCEL H', parcelHText);
  await testParcel('PARCEL I', parcelIText);
}

main();
