import 'dotenv/config';
import fs from 'fs/promises';
import pdfParse from 'pdf-parse';
import { runRepairPipeline } from './services/repair.js';
import * as geminiVision from './services/geminiVision.js';
import { init } from './services/diagnosticsDb.js';

async function processIsolatedParcel(parcelName, parcelText, modelName) {
  console.log(`\n=========================================`);
  console.log(`PROCESSING PARCEL: ${parcelName}`);
  console.log(`Model:             ${modelName}`);
  console.log(`=========================================`);
  
  const buffer = Buffer.from(parcelText, 'utf-8');
  const pob = { northing: 5000, easting: 5000 };
  const units = 'Feet';
  const isOpenEnded = false;
  
  const startTime = Date.now();
  try {
    const result = await runRepairPipeline(buffer, 'text/plain', pob, units, isOpenEnded, `${parcelName}.txt`);
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    
    console.log(`Completed in ${duration}s.`);
    console.log(`Status:       ${result.status}`);
    console.log(`Stage Used:   ${result.repairStageUsed}`);
    
    if (result.finalTraverse) {
      console.log(`Precision:    ${result.finalTraverse.closure?.precisionRatio || 'N/A'}`);
      console.log(`Linear Error: ${result.finalTraverse.closure?.linearError?.toFixed(4) || 'N/A'} ft`);
      console.log(`Area:         ${result.finalTraverse.areaAcres?.toFixed(4) || 'N/A'} acres`);
      console.log(`Perimeter:    ${result.finalTraverse.perimeter?.toFixed(2) || 'N/A'} ft`);
      console.log(`Course Count: ${result.finalExtraction.courses?.length || 0}`);
      console.log('Courses:', JSON.stringify(result.finalExtraction.courses, null, 2));
    } else {
      console.log(`Traverse Error: ${result.traverseError || 'N/A'}`);
    }
  } catch (err) {
    console.error(`Error processing ${parcelName}:`, err.message);
  }
}

async function main() {
  init();
  geminiVision.setProvider('ollama', 'gemma3:4b');
  
  // Clean text and extract Schedule A parcel blocks
  const filePath = '/home/artwalk/Downloads/training-20260530T124201Z-3-001/training/TrainPDF/Regency-Title/Regency-Commitment - Issued 3.27.25.pdf';
  const pdfBytes = await fs.readFile(filePath);
  const parsedPdf = await pdfParse(pdfBytes);
  let text = parsedPdf.text;
  
  const boilerplateRegex = /ALTA\s+Commitment[\s\S]*?Page\s+\d+\s+of\s+31/gi;
  text = text.replace(boilerplateRegex, '');
  text = text.replace(/This page is only a part of[\s\S]*?electronic form\./gi, '');
  text = text.replace(/Copyright 2021 American Land Title Association[\s\S]*?prohibited\./gi, '');
  text = text.replace(/Reprinted under license from[\s\S]*?Association\./gi, '');
  text = text.replace(/\s+/g, ' ');

  const schedAStart = text.indexOf('SCHEDULE A');
  const schedBStart = text.indexOf('SCHEDULE B');
  const scheduleAContent = text.substring(schedAStart, schedBStart !== -1 ? schedBStart : text.length);

  // We have the 3 major parcels
  const parcelA_text = "PARCEL \"A\": A part of Sections 13 and 24, Township 2 South, Range 27 East, Duval County, Florida, more particularly described as follows: COMMENCE at the Northeast corner of said Section 24; thence South 89 degrees 41 minutes 10 seconds West, along the Northerly line of said Section 24, 1150.02 feet to the Westerly right of way line of Monument Road, as established for a width of 100 feet; thence South 00 degrees 18 minutes 50 seconds East, along said Westerly right of way line, 431.02 feet to its intersection with the Northerly right of way line of the Arlington Expressway; thence South 83 degrees 17 minutes 50 seconds West, along said Northerly right of way line, 690.41 feet to the point of curve of curve to the right, said curve having a radius of 5679.65 feet; thence along the arc of said curve and along said Northerly right of way line, an arc distance of 1574.52 feet; thence North 00 degrees 18 minutes 50 seconds West, along said right of way line 33.45 feet; thence westerly along a curve concave Northerly and having a radius of 5646.65 feet, the same being the Northerly right of way line of said Arlington Expressway, an arc distance of 556.44 feet to the point of compound curve, said curve having a radius of 4566.66 feet; thence along the arc of said curve and along said Northerly right of way line, an arc distance of 879.22 feet to the point of tangency of said curve; thence North 64 degrees 05 minutes 10 seconds West, along said Northerly right of way line, 442.88 feet to the Southeasterly corner of lands described in Official Record Volume 3933, page 512; thence North 09 degrees 30 minutes 40 seconds East, along the Easterly line of said lands, 165.87 feet to the point of beginning; thence continue North 09 degrees 30 minutes 40 seconds East, along said Easterly line and the Easterly line of those lands described in Official Record Volume 3702, page 925 and the Northerly prolongation thereof, 686.62 feet to the Southerly right of way line of Regency Square Boulevard; thence North 89 degrees 45 minutes 21 seconds East, along said Southerly right of way line 389.35 feet; thence South 42 degrees 34 minutes 03 seconds West, 23.85 feet to the point of curvature of a curve to the left, thence Southwesterly along the arc of a curve concave Southeasterly and having a radius of 1772.02 feet, an arc distance of 787.70 feet, said arc being subtended by a chord bearing and distance of South 29 degrees 49 minutes 58 seconds West, 781.23 feet; thence North 80 degrees 29 minutes 20 seconds West, 99.39 feet to the Point of Beginning.";
  
  const parcelC_text = "PARCEL \"C\" (NORTH RETENTION POND): A part of the Southwest 1/4 of the Southwest 1/4 and a part of the Northwest 1/4 of the Southwest 1/4 of Section 13, Township 2 South, Range 27 East, Duval County, Florida, more particularly described as follows: COMMENCE at the intersection of the Easterly line of the Southeast 1/4 of the Southwest 1/4 of said Section 13 with the Northerly right of way line of Regency Square Boulevard; thence South 89 degrees 45 minutes 21 seconds West, along said Northerly right of way line 1956.84 feet to an intersection with the proposed Northwesterly right of way line of the Southside Boulevard Connector Road for the point of beginning; thence continue South 89 degrees 45 minutes 21 seconds West, along said Northwesterly right of way line, 110.58 feet to the Southeasterly corner of lands described in Official Record Volume 2778, page 310; thence North 10 degrees 28 minutes 24 seconds East, along the Easterly line of said lands 203.19 feet to the Northeast corner of said lands; thence South 89 degrees 47 minutes 28 seconds West, along the Northerly line of said lands 28.86 feet to the Southeast corner of lands described in Official Record Volume 3519, page 245; thence North 00 degrees 25 minutes 37 seconds West, along the Easterly line of said lands, 265 feet to the Northeast corner of said lands; thence South 89 degrees 47 minutes 28 seconds West, along the Northerly line of said lands, 325 feet to an intersection with the line 240 feet Easterly of and parallel with, when measured at right angles to the Easterly right of way line of Mill Creek Road as established for a width of 100 feet; thence North 01 degrees 12 minutes 35 seconds East, along said line, 311.66 feet to an intersection with a line 275 feet Southerly of and parallel with when measured at right angle to the centerline of proposed relocated Regency Square Boulevard; thence North 89 degrees 50 minutes 07 seconds East, along said line, 1032.43 feet to an intersection with the proposed Northwesterly right of way line of the Southside Boulevard Connector Road, said proposed Northwesterly right of way line being in a curve concave Northwesterly having a radius of 5751.03 feet; thence Southerly along the arc of said curve and along said proposed Northwesterly right of way line, an arc distance of 664.70 feet, said curve having a chord bearing and distance of South 35 degrees 54 minutes 08 seconds West, 664.33 feet (said curve having a tangent bearing of South 39 degrees 12 minutes 48 seconds West); thence South 42 degrees 34 minutes 03 seconds West, along said proposed Northwesterly right of way line, 325.14 feet to the point of beginning.";

  await processIsolatedParcel('Parcel A', parcelA_text, 'gemma3:4b');
  await processIsolatedParcel('Parcel C', parcelC_text, 'gemma3:4b');
}

main().catch(err => console.error(err));
