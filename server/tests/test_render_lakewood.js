import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { solveDeedText } from '../services/Scripting/deedTextSolver.js';
import { renderSketchPages } from '../services/sketchRenderer.js';

const deedText = `COMMENCING AT THE INTERSECTION OF THE EASTERLY RIGHT-OF-WAY LINE OF SAN JOSE BOULEVARD, WITH THE NORTHERLY LINE OF BLOCK 1, SAID LAKEWOOD UNIT 9; THENCE N.51°04'7"E ALONG SAID NORTHERLY LINE OF BLOCK 1 AND ALONG THAT PORTION OF THE NORTHERLY LINE OF SAID TRACT 'A' WHICH IS AN EASTERLY PROLONGATION OF SAID NORTHERLY LINE OF BLOCK 1, 747.68 FEET; THENCE CONTINUING N.51°04'7"E ALONG SAID NORTHERLY LINE OF SAID TRACT 'A', 747.68 FEET; THENCE AT A DEFLECTION ANGLE TO THE LEFT OF 90 DEGREES, 0.00 FEET; THENCE CONTINUING N.51°04'7"E ALONG SAID NORTHERLY LINE OF SAID TRACT 'A', 747.68 FEET; THENCE AT A DEFLECTION ANGLE TO THE RIGHT OF 90 DEGREES, 0.00 FEET.`;

async function main() {
  const model = process.argv[2] || 'llama3.2:3b';
  console.log(`Solving Lakewood traverse using model ${model}...`);
  try {
    const solveResult = await solveDeedText(deedText, model, {
      pobNorthing: 5000,
      pobEasting: 5000,
      units: 'Feet'
    });

    console.log('Solve Result:', JSON.stringify(solveResult, null, 2));

    console.log('Rendering sketch pages...');
    const meta = {
      parcel: 'LAKEWOOD TRACT A',
      county: 'DUVAL COUNTY',
      state: 'FLORIDA',
      status: solveResult.status,
      areaAcres: solveResult.traverse?.areaAcres ?? 0,
      perimeter: solveResult.traverse?.perimeter ?? 0,
      units: 'Feet',
      isOpenEnded: solveResult.isOpenEnded,
      legalDescription: solveResult.legalDescription
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
      true // showConceptualDetail
    );

    const outputDir = process.argv[2] || '/home/artwalk/.gemini/antigravity-ide/brain/9db23561-e29f-410a-84f3-49e41ff5981e/scratch/lakewood_sketch';
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    for (const [pageName, buffer] of Object.entries(pages)) {
      const outputPath = path.join(outputDir, `${pageName}.png`);
      fs.writeFileSync(outputPath, buffer);
      console.log(`Saved ${pageName} to ${outputPath}`);
    }

    console.log('Successfully platted and saved Lakewood survey pages!');
  } catch (err) {
    console.error('Error in Lakewood rendering test:', err);
  }
}

main();
