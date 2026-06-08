import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { solveDeedText } from './services/deedTextSolver.js';
import { renderSketchPages } from './services/sketchRenderer.js';

const deedText = `COMMENCING AT THE SOUTHEAST CORNER OF LOT 1, BLOCK 2, RIDGECREST, THENCE S.04°12’00”W., 712.80 FEET TO THE SOUTHEAST CORNER OF LOT 12; THENCE N.86°00’00”W., 336.50 FEET (POINT OF BEGINNING); THENCE N.04°49’00”E., 128.01 FEET, THENCE S.86°00’00”E., 56.00 FEET TO THE CENTER LINE OF AN EXISTING STREAM; THENCE SOUTHEASTERLY ALONG SAID CENTER LINE, 130.00 FEET TO ITS INTERSECTION WITH THE SOUTHERLY LINE OF LOT 12; THENCE N.86°00’00”W., 131.00 FEET TO THE POINT OF BEGINNING.`;

async function main() {
  const model = process.env.ACTIVE_MODEL || 'deepseek-r1:14b';
  console.log(`Solving Ridgecrest deed with model: ${model}...`);
  
  const result = await solveDeedText(deedText, model, {
    pobNorthing: 5000,
    pobEasting: 5000,
    units: 'Feet'
  });

  console.log('Rendering Ridgecrest sketch pages in blueprint style...');
  const meta = {
    parcel: 'LOT 12 (RIDGECREST)',
    county: '______ COUNTY',
    state: '______',
    status: result.status,
    areaAcres: result.traverse.areaAcres,
    perimeter: result.traverse.perimeter,
    units: 'Feet',
    legalDescription: result.legalDescription
  };

  const pages = renderSketchPages(
    result.traverse.stations,
    result.traverse.adjustedStations,
    result.repairedCourses,
    meta,
    result.traverse.closure,
    result.legalDescription,
    deedText,
    result.originalCourses,
    true, // showConceptualDetail
    true  // blueprintTheme
  );

  const outputDir = '/home/artwalk/.gemini/antigravity-ide/brain/9db23561-e29f-410a-84f3-49e41ff5981e/scratch/ridgecrest_blueprint';
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  for (const [pageName, buffer] of Object.entries(pages)) {
    const outputPath = path.join(outputDir, `${pageName}.png`);
    fs.writeFileSync(outputPath, buffer);
    console.log(`Saved ${pageName} to ${outputPath}`);
  }
  
  console.log('Successfully completed Ridgecrest blueprint sketch generation!');
}

main().catch(console.error);
