import fs from 'fs';
import path from 'path';
import { renderConceptualPages } from './services/sketchRenderer.js';

const conceptualAnalysis = {
  Description: "LOT 12, BLOCK 2, RIDGECREST SUBDIVISION ESTIMATED AT 0.27 ACRES.",
  ParentTractSizeEstimate: "15.5 acres based on Block 2 perimeter",
  LotSizeEstimate: "0.27 acres",
  RelativeComparison: "Lot 12 is roughly 1.8 times the size of a standard 0.15 acre residential subdivision lot in this county."
};

const legalDesc = `COMMENCING AT THE SOUTHEAST CORNER OF LOT 1, BLOCK 2, RIDGECREST, THENCE S.04°12’00”W., 712.80 FEET TO THE SOUTHEAST CORNER OF LOT 12; THENCE N.86°00’00”W., 336.50 FEET (POINT OF BEGINNING); THENCE N.04°49’00”E., 128.01 FEET, THENCE S.86°00’00”E., 56.00 FEET TO THE CENTER LINE OF AN EXISTING STREAM; THENCE SOUTHEASTERLY ALONG SAID CENTER LINE, 130.00 FEET TO ITS INTERSECTION WITH THE SOUTHERLY LINE OF LOT 12; THENCE N.86°00’00”W., 131.00 FEET TO THE POINT OF BEGINNING.`;

function main() {
  console.log('Rendering conceptual pages in blueprint style...');
  const meta = {
    parcel: 'LOT 12 (RIDGECREST)',
    county: '______ COUNTY',
    state: '______',
    status: 'SKIPPED'
  };

  const pages = renderConceptualPages(
    conceptualAnalysis,
    legalDesc,
    meta,
    true // blueprintTheme
  );

  const outputDir = '/home/artwalk/.gemini/antigravity-ide/brain/9db23561-e29f-410a-84f3-49e41ff5981e/scratch/conceptual_blueprint';
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  for (const [pageName, buffer] of Object.entries(pages)) {
    const outputPath = path.join(outputDir, `${pageName}.png`);
    fs.writeFileSync(outputPath, buffer);
    console.log(`Saved ${pageName} to ${outputPath}`);
  }
  
  console.log('Successfully completed conceptual blueprint page generation!');
}

main();
