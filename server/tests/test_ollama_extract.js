import 'dotenv/config';
import fs from 'fs/promises';
import pdfParse from 'pdf-parse';
import { runRepairPipeline } from '../services/repair.js';
import * as geminiVision from '../services/geminiVision.js';
import { init } from '../services/diagnosticsDb.js';

async function testModel(modelName) {
  console.log(`\n=========================================`);
  console.log(`TESTING OLLAMA MODEL: ${modelName}`);
  console.log(`=========================================`);
  
  geminiVision.setProvider('ollama', modelName);
  
  const filePath = process.argv[2] || '/home/artwalk/Downloads/training-20260530T124201Z-3-001/training/TrainPDF/Regency-Title/Regency-Commitment - Issued 3.27.25.pdf';
  const pdfBytes = await fs.readFile(filePath);
  
  // Extract digital text first and clean it from ALTA breaks
  const parsedPdf = await pdfParse(pdfBytes);
  let cleanedText = parsedPdf.text;
  const boilerplateRegex = /ALTA\s+Commitment[\s\S]*?Page\s+\d+\s+of\s+31/gi;
  cleanedText = cleanedText.replace(boilerplateRegex, '');
  cleanedText = cleanedText.replace(/This page is only a part of[\s\S]*?electronic form\./gi, '');
  cleanedText = cleanedText.replace(/Copyright 2021 American Land Title Association[\s\S]*?prohibited\./gi, '');
  cleanedText = cleanedText.replace(/Reprinted under license from[\s\S]*?Association\./gi, '');
  
  const buffer = Buffer.from(cleanedText, 'utf-8');
  
  const pob = { northing: 5000, easting: 5000 };
  const units = 'Feet';
  const isOpenEnded = false;
  
  console.log(`Running offline repair pipeline on extracted digital text (${buffer.length} bytes)...`);
  const startTime = Date.now();
  try {
    const result = await runRepairPipeline(buffer, 'text/plain', pob, units, isOpenEnded, 'Regency-Commitment - Issued 3.27.25.pdf');
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    
    console.log(`Completed in ${duration}s.`);
    console.log(`Status:       ${result.status}`);
    console.log(`Stage Used:   ${result.repairStageUsed}`);
    
    if (result.finalTraverse) {
      console.log(`Precision:    ${result.finalTraverse.closure?.precisionRatio || 'N/A'}`);
      console.log(`Linear Error: ${result.finalTraverse.closure?.linearError?.toFixed(4) || 'N/A'} ft`);
      console.log(`Area:         ${result.finalTraverse.areaAcres?.toFixed(4) || 'N/A'} acres`);
      console.log(`Course Count: ${result.finalExtraction.courses?.length || 0}`);
      console.log('Courses:', JSON.stringify(result.finalExtraction.courses, null, 2));
      return { success: result.status === 'PASS' || result.status === 'MEANDER', courses: result.finalExtraction.courses };
    } else {
      console.log(`Traverse Error: ${result.traverseError || 'N/A'}`);
      return { success: false, error: result.traverseError };
    }
  } catch (err) {
    console.error(`Model ${modelName} crashed:`, err.message);
    return { success: false, error: err.message };
  }
}

async function main() {
  init();
  const filePath = process.argv[2] || "/home/artwalk/Downloads/drive-download-20260602T132437Z-3-001/180455 Title Commitment(1).pdf";
  console.log(`Testing models on: ${filePath}`);
  
  const models = ['llama3.2:3b', 'gemma3:4b', 'deepseek-r1:8b', 'deepseek-r1:14b', 'gemma4:26b'];
  for (const model of models) {
    const res = await testModel(model);
    if (res.success) {
      console.log(`\n🎉 SUCCESS with model: ${model}`);
      break;
    } else {
      console.log(`\n❌ FAILED with model: ${model}`);
    }
  }
}

main().catch(err => console.error(err));
