import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { runRepairPipeline } from './services/repair.js';
import * as geminiVision from './services/geminiVision.js';
import { init } from './services/diagnosticsDb.js';

async function testCommitment() {
  init();

  // Force ollama provider with local model to run offline
  geminiVision.setProvider('ollama', 'gemma3:4b');
  console.log('Using provider:', geminiVision.getActiveProvider(), '/', geminiVision.getActiveModel());
  
  const filePath = '/home/artwalk/Downloads/drive-download-20260602T132437Z-3-001/revised 24000500748 Commitment.pdf';
  const fileName = path.basename(filePath);
  
  console.log(`Loading title commitment PDF: ${fileName}`);
  const pdfBytes = await fs.readFile(filePath);
  
  const pob = { northing: 5000, easting: 5000 };
  const units = 'Feet';
  const isOpenEnded = false;
  
  console.log(`Executing multi-stage repair pipeline on title commitment (can take 30-60s for full LLM OCR & math logic)...`);
  const result = await runRepairPipeline(pdfBytes, 'application/pdf', pob, units, isOpenEnded, fileName);
  
  console.log(`\n=========================================`);
  console.log(`TEST RUN RESULTS FOR TITLE COMMITMENT 24000500748`);
  console.log(`=========================================`);
  console.log(`File:         ${fileName}`);
  console.log(`Status:       ${result.status}`);
  console.log(`Stage Used:   ${result.repairStageUsed}`);
  
  if (result.finalTraverse) {
    console.log(`Precision:    ${result.finalTraverse.closure?.precisionRatio || 'N/A'}`);
    console.log(`Linear Error: ${result.finalTraverse.closure?.linearError?.toFixed(4) || 'N/A'} ft`);
    console.log(`Area:         ${result.finalTraverse.areaAcres?.toFixed(4) || 'N/A'} acres`);
    console.log(`Perimeter:    ${result.finalTraverse.perimeter?.toFixed(2) || 'N/A'} ft`);
    console.log(`Course Count: ${result.finalExtraction.courses?.length || 0}`);
  } else {
    console.log(`Traverse Error: ${result.traverseError || 'N/A'}`);
  }
  console.log(`=========================================\n`);
}

testCommitment().catch(err => console.error('Test run failed:', err));
