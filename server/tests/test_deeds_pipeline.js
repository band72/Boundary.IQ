import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { runRepairPipeline } from '../services/Scripting/repair.js';
import * as geminiVision from '../services/geminiVision.js';
import { init } from '../services/diagnosticsDb.js';

async function run() {
  init();
  
  // Set provider to Ollama with llama3.2:3b
  geminiVision.setProvider('ollama', 'llama3.2:3b');
  console.log('Using active provider:', geminiVision.getActiveProvider(), '/', geminiVision.getActiveModel());

  const baseDir = process.argv[2] || '/home/artwalk/Downloads/training-20260530T124201Z-3-001/training/Legal Descriptions';
  const files = [
    '#33278.doc',
    '10155L-2.doc',
    '10155L.doc',
    '10234L.doc',
    '10568L.doc',
    '11070-7.doc'
  ];

  console.log('\n=========================================');
  console.log('STARTING PIPELINE TEST FOR THE SIX DEEDS');
  console.log('=========================================\n');

  for (const file of files) {
    const baseName = path.parse(file).name;
    const txtPath = path.join(baseDir, '_extracted', baseName + '.txt');
    console.log(`-----------------------------------------`);
    console.log(`Processing: ${file}`);
    console.log(`Pre-extracted Text Path: ${txtPath}`);

    try {
      const text = await fs.readFile(txtPath, 'utf-8');
      const buffer = Buffer.from(text, 'utf-8');
      
      const pob = { northing: 5000, easting: 5000 };
      const units = 'Feet';
      const isOpenEnded = false;

      console.log(`Running repair pipeline on extracted text buffer (${buffer.length} bytes)...`);
      const result = await runRepairPipeline(buffer, 'text/plain', pob, units, isOpenEnded, file);

      console.log(`File: ${file}`);
      console.log(`Status: ${result.status}`);
      console.log(`Stage Used: ${result.repairStageUsed}`);
      if (result.finalTraverse) {
        console.log(`Precision: ${result.finalTraverse.closure?.precisionRatio || 'N/A'}`);
        console.log(`Linear Error: ${result.finalTraverse.closure?.linearError?.toFixed(4) || 'N/A'} ft`);
        console.log(`Area: ${result.finalTraverse.areaAcres?.toFixed(4) || 'N/A'} acres`);
      } else {
        console.log(`Traverse Error: ${result.traverseError || 'N/A'}`);
      }
    } catch (err) {
      console.error(`Error processing ${file}:`, err.message);
    }
    console.log(`-----------------------------------------\n`);
  }
}

run();
