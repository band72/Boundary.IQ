import fs from 'fs/promises';
import path from 'path';
import { runRepairPipeline } from '../services/Scripting/repair.js';
import { writeResultFiles } from '../services/output.js';
import { init } from '../services/diagnosticsDb.js';
import * as legalWriter from '../services/Scripting/legalWriter.js';

import * as geminiVision from '../services/geminiVision.js';

async function run() {
  init();
  geminiVision.setProvider('ollama', 'deepseek-r1:8b');
  const filePath = '/home/artwalk/Downloads/drive-download-20260602T132437Z-3-001/revised 24000500748 Commitment.pdf';
  const fileName = path.basename(filePath);
  const pob = { northing: 5000, easting: 5000 };
  const units = 'Feet';
  const isOpenEnded = false;

  console.log(`Processing ${fileName}...`);
  try {
    const bytes = await fs.readFile(filePath);
    const result = await runRepairPipeline(bytes, 'application/pdf', pob, units, isOpenEnded, fileName);
    console.log('Result Status:', result.status);
    console.log('County:', result.finalExtraction?.county);
    console.log('State:', result.finalExtraction?.state);
    
    const outputFolder = '/tmp/verify_stage17_out';
    await fs.mkdir(outputFolder, { recursive: true });
    
    const courses = result.finalExtraction?.courses || result.extraction?.courses || [];
    const traverse = result.finalTraverse || result.traverse || {};
    const county = result.finalExtraction?.county || result.extraction?.county || 'Unknown';
    const state = result.finalExtraction?.state || result.extraction?.state || 'Unknown';
    const writeResult = {
      legalDescription: legalWriter.write({
        courses,
        pobNorthing: pob.northing,
        pobEasting: pob.easting,
        county,
        state,
        units: units.toLowerCase(),
        areaAcres: traverse.areaAcres || 0,
        perimeter: traverse.perimeter || 0
      }),
      courseCount: courses.length
    };
    const pdfPath = await writeResultFiles(outputFolder, fileName, result, writeResult, false, false);
    console.log('Written PDF Path:', pdfPath);
    
    const correctedPath = path.join(outputFolder, `${path.parse(fileName).name}_corrected.txt`);
    try {
      const correctedContent = await fs.readFile(correctedPath, 'utf-8');
      console.log('\n--- Corrected Deed Content ---');
      console.log(correctedContent);
      console.log('------------------------------');
    } catch (e) {
      console.log(`No corrected deed file written at ${correctedPath} (Pipeline status: ${result.status})`);
    }
  } catch (err) {
    console.error('Error during repair: ', err);
  }
}

run();
