import fs from 'fs/promises';
import { runRepairPipeline } from '../services/Scripting/repair.js';
import * as geminiVision from '../services/geminiVision.js';
import { convertToPdf } from '../services/docConversion.js';
import { init } from '../services/diagnosticsDb.js';

async function run() {
  init();
  
  // Set provider to Ollama with qwen2.5-coder:1.5b
  geminiVision.setProvider('ollama', 'qwen2.5-coder:1.5b');

  const filePath = process.argv[2] || '/home/friend/Downloads/Legal Descriptions/#33278.doc';
  const fileName = '#33278.doc';
  const pob = { northing: 5000, easting: 5000 };
  const units = 'Feet';
  const isOpenEnded = false;

  console.log(`Processing ${fileName} using Ollama qwen2.5-coder:1.5b...`);
  try {
    const bytes = await fs.readFile(filePath);
    console.log('Converting Word doc to PDF first...');
    const pdfBytes = await convertToPdf(bytes, fileName);
    console.log('PDF bytes converted successfully. Running repair pipeline...');
    
    const repairResult = await runRepairPipeline(pdfBytes, 'application/pdf', pob, units, isOpenEnded, fileName);
    console.log('Result Status:', repairResult.status);
    console.log('Repair Stage Used:', repairResult.repairStageUsed);
    console.log('Traverse Error:', repairResult.traverseError);
    if (repairResult.finalExtraction) {
      console.log('Extracted Courses:', repairResult.finalExtraction.courses?.length);
    }
  } catch (err) {
    console.error('Error during repair pipeline:', err);
  }
}

run();
