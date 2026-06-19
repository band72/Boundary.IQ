import 'dotenv/config';
import fs from 'fs';
import * as geminiVision from '../services/geminiVision.js';
import * as traverseSvc from '../services/traverse.js';

// Initialize the model settings
geminiVision.setProvider('ollama', 'gemma3:4b');
console.log('Using provider:', geminiVision.getActiveProvider(), '/', geminiVision.getActiveModel());

// Read the raw text file
const rawText = fs.readFileSync(process.argv[2] || '/home/artwalk/.gemini/antigravity-ide/brain/03ace395-7d9d-43bc-a328-273543ada6f5/scratch/24000500748_text.txt', 'utf8');
const lines = rawText.split('\n');

// Extract lines 245 to 293 (1-indexed, so index 244 to 293)
const parcel1Text = lines.slice(244, 293).join('\n');

// Extract lines 294 to 331 (1-indexed, so index 293 to 331)
// We need to handle page header/footer lines that might be inside the less and except block
const lessExceptLines = lines.slice(293, 331).filter(line => {
  const l = line.toLowerCase();
  return !l.includes('alta commitment') && 
         !l.includes('schedule a') && 
         !l.includes('issued by') && 
         !l.includes('stewart title') && 
         !l.includes('this page is only') && 
         !l.includes('copyright 2021') && 
         !l.includes('the use of this form') && 
         !l.includes('all other uses are') && 
         !l.includes('file no.') && 
         !l.includes('fl010-un');
});
const lessExceptText = lessExceptLines.join('\n');

async function testExtraction(name, textContent) {
  console.log(`\n=========================================\nPROCESSING: ${name}\n=========================================`);
  console.log('Text content length:', textContent.length);
  console.log('-----------------------------------------');
  console.log('RUNNING REGEX FALLBACK PARSER...');
  const fallbackResult = geminiVision.parseFromTextFallback(textContent);
  if (fallbackResult && fallbackResult.courses?.length > 0) {
    const courses = fallbackResult.courses;
    console.log(`Regex Fallback Extracted ${courses.length} courses.`);
    console.log('Regex Fallback Courses:', JSON.stringify(courses, null, 2));
    const pob = { northing: 5000, easting: 5000 };
    try {
      const traverse = traverseSvc.compute({
        pointOfBeginning: pob,
        courses,
        units: 'Feet',
        isOpenEnded: false
      });
      console.log('--- Regex Fallback Traverse Closure Result ---');
      console.log('Linear Error:', traverse.closure?.linearError, 'feet');
      console.log('Precision Ratio:', traverse.closure?.precisionRatio);
      console.log('Perimeter:', traverse.perimeter, 'feet');
      console.log('Area:', traverse.areaAcres, 'acres');
    } catch (err) {
      console.error('Regex Fallback Traverse failed:', err.message);
      console.log('Regex Fallback Courses JSON:', JSON.stringify(courses, null, 2));
    }
  } else {
    console.log('Regex Fallback Parser returned no courses.');
  }

  console.log('-----------------------------------------');
  console.log('RUNNING LOCAL OLLAMA GEMMA3:4B PARSER...');
  const textBuf = Buffer.from(textContent, 'utf-8');
  try {
    const result = await geminiVision.extractBoundary(textBuf, 'text/plain');
    console.log('Extraction message:', result.message);
    console.log('Parsed Classification:', result.classification);
    
    const courses = result.courses || [];
    console.log('Parsed Courses Count:', courses.length);
    console.log('Courses JSON:', JSON.stringify(courses, null, 2));

    if (courses.length > 0) {
      const pob = { northing: 5000, easting: 5000 };
      const traverse = traverseSvc.compute({
        pointOfBeginning: pob,
        courses,
        units: 'Feet',
        isOpenEnded: false
      });
      console.log('--- Ollama Traverse Closure Result ---');
      console.log('Linear Error:', traverse.closure?.linearError, 'feet');
      console.log('Precision Ratio:', traverse.closure?.precisionRatio);
      console.log('Perimeter:', traverse.perimeter, 'feet');
      console.log('Area:', traverse.areaAcres, 'acres');
    }
  } catch (err) {
    console.error('Ollama extraction failed:', err.message);
  }
}

async function run() {
  await testExtraction('PARCEL 1', parcel1Text);
  await testExtraction('LESS and EXCEPT', lessExceptText);
}

run();
