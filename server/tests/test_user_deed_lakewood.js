import 'dotenv/config';
import { solveDeedText } from '../services/Scripting/deedTextSolver.js';

const deedText = `COMMENCING AT THE INTERSECTION OF THE EASTERLY RIGHT-OF-WAY LINE OF SAN JOSE BOULEVARD, WITH THE NORTHERLY LINE OF BLOCK 1, SAID LAKEWOOD UNIT 9; THENCE N.51°04'7"E ALONG SAID NORTHERLY LINE OF BLOCK 1 AND ALONG THAT PORTION OF THE NORTHERLY LINE OF SAID TRACT 'A' WHICH IS AN EASTERLY PROLONGATION OF SAID NORTHERLY LINE OF BLOCK 1, 747.68 FEET; THENCE CONTINUING N.51°04'7"E ALONG SAID NORTHERLY LINE OF SAID TRACT 'A', 747.68 FEET; THENCE AT A DEFLECTION ANGLE TO THE LEFT OF 90 DEGREES, 0.00 FEET; THENCE CONTINUING N.51°04'7"E ALONG SAID NORTHERLY LINE OF SAID TRACT 'A', 747.68 FEET; THENCE AT A DEFLECTION ANGLE TO THE RIGHT OF 90 DEGREES, 0.00 FEET.`;

async function main() {
  const model = 'deepseek-r1:14b';
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
