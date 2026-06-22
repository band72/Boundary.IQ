import fs from 'fs/promises';
import path from 'path';
import { runRepairPipeline } from '../services/Scripting/repair.js';
import * as geminiVision from '../services/geminiVision.js';
import { convertToPdf, isWordDocument, getMimeType } from '../services/docConversion.js';
import { init } from '../services/diagnosticsDb.js';

async function run() {
  init();

  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Please specify a file path to run.");
    process.exit(1);
  }

  const fileName = path.basename(filePath);
  const pob = { northing: 5000, easting: 5000 };
  const units = 'Feet';
  const isOpenEnded = false;

  console.log(`Processing ${fileName}...`);
  try {
    let bytes = await fs.readFile(filePath);
    let mimeType = getMimeType(fileName);

    if (isWordDocument(fileName)) {
      console.log('Converting Word doc to PDF first...');
      bytes = await convertToPdf(bytes, fileName);
      mimeType = 'application/pdf';
      console.log('PDF bytes converted successfully.');
    }

    console.log('Running repair pipeline...');
    const repairResult = await runRepairPipeline(bytes, mimeType, pob, units, isOpenEnded, fileName);

    // Save the result to the database
    const crypto = await import('crypto');
    const fileHash = crypto.createHash('sha256').update(bytes).digest('hex');
    const { saveCorrectedDeed } = await import('../services/diagnosticsDb.js');
    saveCorrectedDeed(
      fileName,
      'SUBJECT PARCEL',
      repairResult.status,
      repairResult.repairStageUsed,
      JSON.stringify(repairResult.finalExtraction || {}),
      repairResult.finalTraverse ? JSON.stringify(repairResult.finalTraverse) : null,
      repairResult.agentTurns ? JSON.stringify(repairResult.agentTurns) : null,
      repairResult.trustScore ?? null,
      repairResult.solutionSteps ? JSON.stringify(repairResult.solutionSteps) : null,
      null, null, null, pob.northing, pob.easting,
      fileHash
    );
    console.log('Saved result to database.');

    console.log('\n=== Pipeline Result ===');
    console.log('Status:', repairResult.status);
    console.log('Repair Stage Used:', repairResult.repairStageUsed);
    console.log('Traverse Error:', repairResult.traverseError);
    if (repairResult.finalExtraction) {
      console.log('Extracted Courses Count:', repairResult.finalExtraction.courses?.length);
      console.log('Courses JSON:', JSON.stringify(repairResult.finalExtraction.courses, null, 2));
    }
    if (repairResult.finalTraverse) {
      console.log('Traverse Closure:', JSON.stringify(repairResult.finalTraverse.closure, null, 2));
    }
    process.exit(0);
  } catch (err) {
    console.error('Error during repair pipeline:', err);
    process.exit(1);
  }
}

run();
