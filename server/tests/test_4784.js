import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

async function run() {
  const { init } = await import('../services/diagnosticsDb.js');
  const { runRepairPipeline } = await import('../services/repair.js');
  const geminiVision = await import('../services/geminiVision.js');

  init();
  // Set provider to gemini-2.5-pro to get the highest quality extraction
  geminiVision.setProvider('gemini', 'gemini-2.5-pro');

  const filePath = '/home/artwalk/Downloads/training-20260530T124201Z-3-001/training/TrainPDF/Regency-Title/4784.213 - QCD (into Regency Square).pdf';
  const fileName = path.basename(filePath);
  const pob = { northing: 5000, easting: 5000 };
  const units = 'Feet';
  const isOpenEnded = false;

  console.log(`Processing ${fileName} using Gemini...`);
  try {
    const bytes = await fs.readFile(filePath);
    const result = await runRepairPipeline(bytes, 'application/pdf', pob, units, isOpenEnded, fileName);
    console.log('Result Status:', result.status);
    console.log('Repair Stage Used:', result.repairStageUsed);
    console.log('Traverse Error:', result.traverseError);
    if (result.finalExtraction) {
      console.log('\n=== Final Extracted Courses ===');
      console.log(JSON.stringify(result.finalExtraction.courses, null, 2));
    }
    if (result.finalTraverse) {
      console.log('\n=== Final Traverse JSON ===');
      console.log(JSON.stringify(result.finalTraverse.closure, null, 2));
    }
  } catch (err) {
    console.error('Error during repair: ', err);
  }
}

run();
