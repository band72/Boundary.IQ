import 'dotenv/config';
import * as geminiVision from '../services/geminiVision.js';
import { solveFromCourses } from '../services/Scripting/deedTextSolver.js';

const deedText = `A parcel of land being a parcel of land, situated in ______ County, ______, more particularly described as follows: BEGINNING at a point, said point being the Point of Beginning (POB), having coordinates of Northing 5000.00, Easting 5000.00; THENCE South 54°40'00" West, a distance of 458.10 feet; THENCE along a curve to the Left, having a radius of 424.73 feet, a central angle of 93°62'00.00", an arc length of 93.43 feet, a chord bearing of South 16°38'52" East, and a chord distance of 93.43 feet; THENCE South 22°57'45" East, a distance of 36.10 feet; THENCE along a curve to the Left, having a radius of 710.48 feet, a central angle of 87°32'100.00", an arc length of 87.28 feet, a chord bearing of South 63°30'55" West, and a chord distance of 87.28 feet; THENCE South 64°40'00" West, a distance of 51.39 feet; THENCE South 14°58'30" East, a distance of 636.00 feet; THENCE North 52°46'44.44" East, a distance of 602.68 feet; THENCE North 14°58'30" West, a distance of 723.00 feetto the Point of Beginning. Said parcel containing 9.0340 acres, more or less, and having a perimeter of 2687.98 feet. Bearings are based on the deed`;

async function main() {
  const apiKey = process.env.GEMINI_API_KEY || process.env.Gemini__ApiKey;
  if (!apiKey) {
    console.error('Error: GEMINI_API_KEY is not defined in .env');
    process.exit(1);
  }
  
  // Initialize and set provider
  geminiVision.init(apiKey);
  geminiVision.setProvider('gemini', 'gemini-3.5-flash');
  
  console.log(`Initialized Gemini with model: ${geminiVision.getActiveModel()}`);
  console.log('Sending deed text to Gemini for boundary extraction...');
  
  const buffer = Buffer.from(deedText, 'utf-8');
  try {
    const extractResult = await geminiVision.extractBoundary(buffer, 'text/plain');
    console.log('Extraction successfully parsed. Metadata:');
    console.log(`- Classification: ${extractResult.classification}`);
    console.log(`- Preamble Found: ${extractResult.preambleFound}`);
    console.log(`- Is Open Ended: ${extractResult.isOpenEnded}`);
    console.log(`- Courses Count: ${extractResult.courses.length}`);
    console.log('Raw Courses JSON:');
    console.log(JSON.stringify(extractResult.courses, null, 2));
    
    console.log('\nRunning deterministic COGO solver and repair...');
    const solveResult = solveFromCourses(extractResult.courses, {
      pobNorthing: 5000,
      pobEasting: 5000,
      units: 'Feet'
    });
    
    console.log('\n=========================================');
    console.log('             SOLVER RESULTS              ');
    console.log('=========================================');
    console.log(`Status: ${solveResult.status}`);
    console.log(`Trust Level: ${solveResult.trustLevel} (Score: ${solveResult.trustScore}/100)`);
    console.log(`Linear Error: ${solveResult.traverse?.closure?.linearError?.toFixed(4)} feet`);
    console.log(`Precision Ratio: ${solveResult.traverse?.closure?.precisionRatio}`);
    console.log(`Perimeter: ${solveResult.traverse?.perimeter?.toFixed(2)} feet`);
    console.log(`Area: ${solveResult.traverse?.areaAcres?.toFixed(4)} acres (${solveResult.traverse?.areaSqFt?.toFixed(2)} sq ft)`);
    
    console.log('\nCorrection Table:');
    console.table(solveResult.correctionTable.map(c => ({
      '#': c.courseNumber,
      'Type': c.originalBearing ? 'Line' : 'Curve',
      'Original Bearing': c.originalBearing || 'N/A',
      'Original Distance': c.originalDistance || 'N/A',
      'Repaired Bearing': c.bearing || 'N/A',
      'Repaired Distance': c.distance || 'N/A',
      'Status': c.status,
      'Hypothesis': c.hypothesis || 'None'
    })));
    
    console.log('\nRepaired Legal Description:');
    console.log(solveResult.legalDescription);
    
  } catch (err) {
    console.error('Error in processing:', err);
  }
}

main();
