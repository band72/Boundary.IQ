import 'dotenv/config';
import { solveDeedText } from '../services/Scripting/deedTextSolver.js';

const deedText = `COMMENCING AT THE SOUTHEAST CORNER OF LOT 1, BLOCK 2, RIDGECREST, THENCE S.04°12’00”W., 712.80 FEET TO THE SOUTHEAST CORNER OF LOT 12; THENCE N.86°00’00”W., 336.50 FEET (POINT OF BEGINNING); THENCE N.04°49’00”E., 128.01 FEET, THENCE S.86°00’00”E., 56.00 FEET TO THE CENTER LINE OF AN EXISTING STREAM; THENCE SOUTHEASTERLY ALONG SAID CENTER LINE, 130.00 FEET TO ITS INTERSECTION WITH THE SOUTHERLY LINE OF LOT 12; THENCE N.86°00’00”W., 131.00 FEET TO THE POINT OF BEGINNING.`;

async function main() {
  const model = process.env.ACTIVE_MODEL || 'deepseek-r1:14b';
  console.log(`Running solveDeedText with model: ${model}...`);
  try {
    const result = await solveDeedText(deedText, model, {
      pobNorthing: 5000,
      pobEasting: 5000,
      units: 'Feet'
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('Error in solveDeedText:', err);
  }
}

main();
