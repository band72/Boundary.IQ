import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { init as initDb, getDb, saveDeedLog, saveBatchRun } from '../services/diagnosticsDb.js';
import { compute } from '../services/traverse.js';

const FAILED_DIR = '/home/artwalk/Downloads/training-20260530T124201Z-3-001/training/Legal Descriptions/_FAILED';
const EXTRACTED_DIR = path.join(FAILED_DIR, '_extracted');
const BATCH_ID = 'MANUAL_TRAINING_SEED';

const perfectDeeds = {
  '10615A.txt': [
    { type: 'Line', bearing: 'S54°32\'41"E', distance: 310.63 },
    { type: 'Line', bearing: 'N39°50\'18"E', distance: 128.98 },
    { type: 'Curve', radius: 25, chordBearing: 'N05°09\'42"W', chordDistance: 35.36, curveDirection: 'Left', delta: 90, arcLength: 39.27 },
    { type: 'Line', bearing: 'N50°09\'42"W', distance: 22.89 },
    { type: 'Curve', radius: 212.45, chordBearing: 'N73°23\'49"W', chordDistance: 167.62, curveDirection: 'Left', delta: 46.4706, arcLength: 172.31 },
    { type: 'Line', bearing: 'S83°22\'04"W', distance: 132.98 },
    { type: 'Curve', radius: 189.60, chordBearing: 'S86°43\'30"W', chordDistance: 22.21, curveDirection: 'Right', delta: 6.7153, arcLength: 22.22 }
  ],
  '10370-2L.txt': [
    { type: 'Line', bearing: 'N89°20\'30"W', distance: 227.00 },
    { type: 'Line', bearing: 'N00°39\'30"E', distance: 241.56 },
    { type: 'Line', bearing: 'S65°49\'00"E', distance: 247.57 },
    { type: 'Line', bearing: 'S00°39\'00"W', distance: 142.74 }
  ],
  '10660L.txt': [
    { type: 'Line', bearing: 'S74°39\'07"W', distance: 58.76 },
    { type: 'Line', bearing: 'N09°45\'46"W', distance: 281.70 },
    { type: 'Curve', radius: 439.26, chordBearing: 'N83°22\'13"E', chordDistance: 174.95, curveDirection: 'Left', delta: 22.9736, arcLength: 176.13 },
    { type: 'Line', bearing: 'N71°53\'00"E', distance: 30.77 },
    { type: 'Line', bearing: 'S07°34\'03"E', distance: 169.33 },
    { type: 'Line', bearing: 'S44°16\'34"W', distance: 173.16 }
  ],
  '10729L.txt': [
    { type: 'Curve', radius: 360.00, chordBearing: 'N68°10\'12"E', chordDistance: 57.86, curveDirection: 'Right', delta: 9.21, arcLength: 57.90 },
    { type: 'Line', bearing: 'S26°34\'17"E', distance: 112.02 },
    { type: 'Line', bearing: 'S51°05\'06"W', distance: 69.86 },
    { type: 'Line', bearing: 'S23°52\'39"W', distance: 90.41 },
    { type: 'Line', bearing: 'S50°25\'40"W', distance: 23.13 },
    { type: 'Line', bearing: 'N23°52\'39"E', distance: 106.22 },
    { type: 'Line', bearing: 'N17°13\'05"W', distance: 123.56 }
  ],
  '11082L.txt': [
    { type: 'Curve', radius: 2566.04, chordBearing: 'S65°45\'00"E', chordDistance: 128.25, curveDirection: 'Left', delta: 2.863, arcLength: 128.25 },
    { type: 'Line', bearing: 'S67°03\'00"E', distance: 21.80 },
    { type: 'Line', bearing: 'N22°57\'00"E', distance: 315.00 },
    { type: 'Line', bearing: 'N67°03\'00"W', distance: 150.00 },
    { type: 'Line', bearing: 'S22°57\'00"W', distance: 311.80 }
  ],
  '11090L.txt': [
    { type: 'Line', bearing: 'N49°00\'00"W', distance: 6.35 },
    { type: 'Curve', radius: 105.00, chordBearing: 'N61°26\'15"W', chordDistance: 45.23, curveDirection: 'Left', delta: 24.88, arcLength: 45.59 },
    { type: 'Line', bearing: 'N08°52\'30"W', distance: 121.51 },
    { type: 'Line', bearing: 'N86°45\'00"E', distance: 42.85 },
    { type: 'Line', bearing: 'S07°57\'34"E', distance: 149.47 }
  ],
  '12271.txt': [
    { type: 'Curve', radius: 42.43, chordBearing: 'N45°47\'00"W', chordDistance: 6000, curveDirection: 'Right', delta: 0, arcLength: 0 },
    { type: 'Line', bearing: 'S44°13\'00"W', distance: 100.00 },
    { type: 'Line', bearing: 'S45°47\'00.52"E', distance: 5998.25 },
    { type: 'Line', bearing: 'N45°13\'00"E', distance: 100.00 }
  ],
  '11928L.txt': [
    { type: 'Line', bearing: 'N13°29\'15"W', distance: 105.05 },
    { type: 'Line', bearing: 'N89°05\'20"E', distance: 471.00 },
    { type: 'Line', bearing: 'S33°36\'00"E', distance: 121.82 },
    { type: 'Line', bearing: 'S89°05\'20"W', distance: 514.00 }
  ],
  '12301L2.txt': [
    { type: 'Line', bearing: 'S88°50\'46"W', distance: 4.00 },
    { type: 'Line', bearing: 'N01°09\'14"W', distance: 118.78 },
    { type: 'Curve', radius: 193.00, chordBearing: 'N88°50\'46.00"E', chordDistance: 4.00, curveDirection: 'Right', delta: 47.2906, arcLength: 159.30 },
    { type: 'Line', bearing: 'S01°09\'14"E', distance: 118.78 }
  ],
  '12417L.txt': [
    { type: 'Line', bearing: 'N39°51\'16"E', distance: 22.92 },
    { type: 'Line', bearing: 'N59°29\'00"E', distance: 5.97 },
    { type: 'Line', bearing: 'N04°01\'37"E', distance: 4.07 },
    { type: 'Line', bearing: 'N39°51\'16"E', distance: 15.00 },
    { type: 'Line', bearing: 'S50°08\'44"E', distance: 24.44 },
    { type: 'Line', bearing: 'S67°26\'57"W', distance: 53.26 }
  ],
  '12430L.txt': [
    { type: 'Line', bearing: 'S85°32\'20"E', distance: 77.86 },
    { type: 'Curve', radius: 0.00, chordBearing: 'S86°29\'25"E', chordDistance: 22.15, curveDirection: 'Right', delta: 0, arcLength: 0 },
    { type: 'Line', bearing: 'N04°27\'40"E', distance: 199.63 },
    { type: 'Line', bearing: 'N85°32\'20"W', distance: 100.00 },
    { type: 'Line', bearing: 'S04°27\'40"W', distance: 200.00 }
  ],
  '12983L-3.txt': [
    { type: 'Line', bearing: 'N90°00\'00"W', distance: 100.00 },
    { type: 'Line', bearing: 'S45°00\'00"W', distance: 43.38 },
    { type: 'Line', bearing: 'S89°50\'54"W', distance: 372.40 },
    { type: 'Line', bearing: 'S00°14\'06"E', distance: 81.45 },
    { type: 'Line', bearing: 'N89°50\'54"E', distance: 391.07 },
    { type: 'Line', bearing: 'N45°00\'00"E', distance: 17.08 },
    { type: 'Line', bearing: 'S90°00\'00"E', distance: 100.00 },
    { type: 'Line', bearing: 'N00°14\'07"W', distance: 100.00 }
  ],
  '13245L.txt': [
    { type: 'Line', bearing: 'S39°03\'00"E', distance: 110.00 },
    { type: 'Line', bearing: 'S50°50\'51"W', distance: 426.43 },
    { type: 'Line', bearing: 'N40°00\'41"W', distance: 110.00 },
    { type: 'Line', bearing: 'N50°50\'56"E', distance: 424.58 }
  ]
};

function getFileHash(filePath) {
  try {
    const buffer = readFileSync(filePath);
    return crypto.createHash('sha256').update(buffer).digest('hex');
  } catch (err) {
    console.error(`Error hashing file ${filePath}:`, err.message);
    return null;
  }
}

async function main() {
  console.log('Initializing Diagnostics Database...');
  initDb();
  const db = getDb();

  // Create seed batch run entry
  db.prepare('INSERT OR REPLACE INTO BatchRuns (BatchId, Timestamp, TotalFiles, PassRate) VALUES (?, ?, ?, ?)')
    .run(BATCH_ID, new Date().toISOString().replace('T', ' ').slice(0, 19), 101, 1.0);

  console.log('Inserting custom perfect cases into database...');

  for (const [fileName, courses] of Object.entries(perfectDeeds)) {
    const txtFilePath = path.join(EXTRACTED_DIR, fileName);
    if (!existsSync(txtFilePath)) {
      console.warn(`⚠️ Warning: Extracted text file not found: ${txtFilePath}`);
      continue;
    }

    const fileHash = getFileHash(txtFilePath);
    if (!fileHash) {
      console.error(`❌ Could not hash file ${fileName}`);
      continue;
    }

    // Run traverse computation to get a mathematically sound TraverseJson
    const req = {
      pointOfBeginning: { northing: 5000.0, easting: 5000.0 },
      courses: courses,
      units: 'Feet',
      isOpenEnded: false
    };

    let traverseResult;
    try {
      traverseResult = compute(req);
    } catch (err) {
      console.error(`❌ Failed to compute traverse for ${fileName}:`, err.message);
      continue;
    }

    const extractionJson = JSON.stringify({
      classification: 'METES_BOUNDS',
      courses: courses,
      preambleFound: true,
      isOpenEnded: false,
      mentalMapSummary: 'Manually corrected perfect courses'
    });

    const traverseJson = JSON.stringify(traverseResult);

    // Delete existing record to prevent duplicates
    db.prepare('DELETE FROM DeedLogs WHERE FileName = ?').run(fileName);
    db.prepare('DELETE FROM DeedLogs WHERE FileHash = ?').run(fileHash);

    saveDeedLog(
      BATCH_ID,
      fileName,
      'MANUALLY CORRECTED PERFECT PARCEL',
      courses.length,
      traverseResult.closure?.linearError || 0,
      traverseResult.closure?.precisionRatio === '1:∞ (Perfect)' ? 999999999 : parseFloat(traverseResult.closure?.precisionRatio?.split(':')[1]?.replace(/,/g, '') || 0),
      'PASS',
      'Stage 5: Manual Correction',
      extractionJson,
      traverseJson,
      null, // agentTurnsJson
      100.0, // trustScore
      null, // solutionStepsJson
      null, // refName
      null, // refN
      null, // refE
      5000.0, // pobN
      5000.0, // pobE
      fileHash
    );

    console.log(`✓ Seeded ${fileName} with hash ${fileHash} and status PASS (linear err = ${traverseResult.closure?.linearError?.toFixed(4)} ft)`);
  }

  console.log('Seeding finished!');
}

main().catch(console.error);
