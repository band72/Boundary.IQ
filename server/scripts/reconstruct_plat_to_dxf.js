#!/usr/bin/env node
/**
 * reconstruct_plat_to_dxf.js
 * --------------------------
 * Integrates directly with the Boundary.IQ backend services to:
 * 1. Load the PDF/image plat map.
 * 2. Invoke the multi-agent OCR/vision boundary extraction system (Stage 5 repair pipeline).
 * 3. Calculate COGO traverse coordinates.
 * 4. Apply geometric corrections and adjustments (Compass Rule, meander gap, scrivener error).
 * 5. Generate a layered, annotated CAD DXF file.
 *
 * Usage:
 *   node server/scripts/reconstruct_plat_to_dxf.js <input_file> <output_dxf> [options]
 *
 * Options:
 *   --pob=N,E        Set Point of Beginning coordinates (default: 5000,5000)
 *   --units=Feet|M   Set measurement units (default: Feet)
 *   --provider=PROV  Set AI provider: gemini | ollama | openai (default: gemini if key present, else ollama)
 *   --model=MODEL    Set LLM model override
 *   --no-adjust      Skip Compass Rule correction
 *   --concurrency=N  Max concurrent files processed (default: 2)
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pLimit from 'p-limit';
import { PDFDocument } from 'pdf-lib';

// ── Bootstrap Database & Project Dir ─────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, '..');
process.chdir(SERVER_DIR);

// Lazy-load modules after changing directory and setting up environment
const { init: initDb } = await import('../services/db/core.js');
initDb?.();

const { runRepairPipeline } = await import('../services/repair.js');
const { generateDxf } = await import('../services/dxfExport.js');
const { setProvider, getActiveProvider, getActiveModel } = await import('../services/llm/dispatcher.js');
const { GEMINI_API_KEY } = await import('../config.js');

function printUsage() {
  console.log("Usage: node server/scripts/reconstruct_plat_to_dxf.js <input_file_or_dir> [output_dxf_or_dir] [options]");
  console.log("");
  console.log("Options:");
  console.log("  --pob=N,E             Point of Beginning coordinates (default: 5000,5000)");
  console.log("  --units=Feet|Meters   Measurement units (default: Feet)");
  console.log("  --provider=ai_prov    Provider: gemini | ollama | openai");
  console.log("  --model=model_name    Model identifier override");
  console.log("  --open-ended          Process as open centerline/easement path");
  console.log("  --no-adjust           Skip Compass Rule linear error distribution");
  console.log("  --concurrency=N       Max parallel file reconstructions (default: 2)");
  console.log("  --help                Show this message");
}

async function main() {
  const args = process.argv.slice(2).filter(a => !a.startsWith('-'));
  const allArgs = process.argv.slice(2);
  const help = allArgs.includes('--help') || allArgs.includes('-h') || args.length < 1;
  if (help) {
    printUsage();
    process.exit(0);
  }

  const inputFile = args[0];
  const outputDxfArg = args[1];

  // Parse custom parameters
  let pobN = 5000;
  let pobE = 5000;
  const pobArg = allArgs.find(a => a.startsWith('--pob='))?.split('=')[1];
  if (pobArg) {
    const parts = pobArg.split(',');
    if (parts.length === 2) {
      pobN = parseFloat(parts[0]) || 5000;
      pobE = parseFloat(parts[1]) || 5000;
    }
  }

  const units = allArgs.find(a => a.startsWith('--units='))?.split('=')[1] || 'Feet';
  const openEnded = allArgs.includes('--open-ended');
  const provider = allArgs.find(a => a.startsWith('--provider='))?.split('=')[1];
  const model = allArgs.find(a => a.startsWith('--model='))?.split('=')[1];
  const concurrencyArg = allArgs.find(a => a.startsWith('--concurrency='))?.split('=')[1];
  const concurrency = parseInt(concurrencyArg) || 2;

  if (!fs.existsSync(inputFile)) {
    console.error(`Error: Input file or directory not found at '${inputFile}'`);
    process.exit(1);
  }

  // Setup custom AI model overrides
  if (provider) {
    try {
      setProvider(provider, model);
      console.log(`Setting AI provider override: ${provider} (model: ${model || 'default'})`);
    } catch (e) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
  } else if (GEMINI_API_KEY && getActiveProvider() !== 'gemini') {
    // Automatically use Gemini if API key is present in environment for high-quality vision/curve table extraction
    setProvider('gemini');
    console.log(`Gemini API key detected in environment. Routing to gemini for extraction.`);
  }

  const mimeMap = {
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.txt': 'text/plain'
  };

  const stat = fs.statSync(inputFile);
  const filesToProcess = [];

  if (stat.isDirectory()) {
    console.log(`📁 Scanning directory: '${inputFile}'`);
    const children = fs.readdirSync(inputFile);
    for (const child of children) {
      const fullPath = path.join(inputFile, child);
      const childStat = fs.statSync(fullPath);
      if (childStat.isFile()) {
        const ext = path.extname(child).toLowerCase();
        if (mimeMap[ext]) {
          // Determine output path
          let outDxf;
          if (outputDxfArg) {
            const outStat = fs.existsSync(outputDxfArg) ? fs.statSync(outputDxfArg) : null;
            if (outStat && outStat.isDirectory()) {
              outDxf = path.join(outputDxfArg, path.basename(child, ext) + '_reconstructed.dxf');
            } else {
              outDxf = path.join(path.dirname(outputDxfArg), path.basename(child, ext) + '_reconstructed.dxf');
            }
          } else {
            outDxf = path.join(inputFile, path.basename(child, ext) + '_reconstructed.dxf');
          }

          if (ext === '.pdf') {
            const fileBuffer = fs.readFileSync(fullPath);
            let pageCount = 1;
            try {
              const pdfDoc = await PDFDocument.load(fileBuffer);
              pageCount = pdfDoc.getPageCount();
              if (pageCount > 1) {
                for (let pIdx = 0; pIdx < pageCount; pIdx++) {
                  const subPdfDoc = await PDFDocument.create();
                  const [copiedPage] = await subPdfDoc.copyPages(pdfDoc, [pIdx]);
                  subPdfDoc.addPage(copiedPage);
                  const subPdfBuffer = Buffer.from(await subPdfDoc.save());
                  const pageSuffix = `_page_${pIdx + 1}`;
                  
                  let pageOutDxf;
                  if (outputDxfArg) {
                    const outStat = fs.existsSync(outputDxfArg) ? fs.statSync(outputDxfArg) : null;
                    if (outStat && outStat.isDirectory()) {
                      pageOutDxf = path.join(outputDxfArg, path.basename(child, ext) + `${pageSuffix}_reconstructed.dxf`);
                    } else {
                      pageOutDxf = path.join(path.dirname(outputDxfArg), path.basename(child, ext) + `${pageSuffix}_reconstructed.dxf`);
                    }
                  } else {
                    pageOutDxf = path.join(inputFile, path.basename(child, ext) + `${pageSuffix}_reconstructed.dxf`);
                  }

                  filesToProcess.push({
                    name: `${child} (Page ${pIdx + 1}/${pageCount})`,
                    buffer: subPdfBuffer,
                    output: pageOutDxf,
                    mimeType: 'application/pdf'
                  });
                }
              } else {
                filesToProcess.push({
                  name: child,
                  buffer: fileBuffer,
                  output: outDxf,
                  mimeType: 'application/pdf'
                });
              }
            } catch (err) {
              filesToProcess.push({
                name: child,
                buffer: fileBuffer,
                output: outDxf,
                mimeType: 'application/pdf'
              });
            }
          } else {
            filesToProcess.push({
              name: child,
              buffer: fs.readFileSync(fullPath),
              output: outDxf,
              mimeType: mimeMap[ext]
            });
          }
        }
      }
    }
  } else {
    const ext = path.extname(inputFile).toLowerCase();
    const mimeType = mimeMap[ext];
    if (!mimeType) {
      console.error(`Error: Unsupported file format '${ext}'. Supported: PDF, PNG, JPG, WEBP, TXT`);
      process.exit(1);
    }
    const outDxf = outputDxfArg || path.join(path.dirname(inputFile), path.basename(inputFile, ext) + '_reconstructed.dxf');
    const fileBuffer = fs.readFileSync(inputFile);

    if (ext === '.pdf') {
      try {
        const pdfDoc = await PDFDocument.load(fileBuffer);
        const pageCount = pdfDoc.getPageCount();
        if (pageCount > 1) {
          console.log(`📄 Multi-page PDF detected: ${pageCount} pages. Splitting...`);
          for (let pIdx = 0; pIdx < pageCount; pIdx++) {
            const subPdfDoc = await PDFDocument.create();
            const [copiedPage] = await subPdfDoc.copyPages(pdfDoc, [pIdx]);
            subPdfDoc.addPage(copiedPage);
            const subPdfBuffer = Buffer.from(await subPdfDoc.save());

            let pageOutDxf = outDxf.replace(/_reconstructed\.dxf$/, `_page_${pIdx + 1}_reconstructed.dxf`);
            if (pageOutDxf === outDxf) {
              const extname = path.extname(outDxf);
              const dirname = path.dirname(outDxf);
              const basename = path.basename(outDxf, extname);
              pageOutDxf = path.join(dirname, basename + `_page_${pIdx + 1}${extname}`);
            }

            filesToProcess.push({
              name: `${path.basename(inputFile)} (Page ${pIdx + 1}/${pageCount})`,
              buffer: subPdfBuffer,
              output: pageOutDxf,
              mimeType: 'application/pdf'
            });
          }
        } else {
          filesToProcess.push({
            name: path.basename(inputFile),
            buffer: fileBuffer,
            output: outDxf,
            mimeType: 'application/pdf'
          });
        }
      } catch (err) {
        filesToProcess.push({
          name: path.basename(inputFile),
          buffer: fileBuffer,
          output: outDxf,
          mimeType: 'application/pdf'
        });
      }
    } else {
      filesToProcess.push({
        name: path.basename(inputFile),
        buffer: fileBuffer,
        output: outDxf,
        mimeType
      });
    }
  }

  if (filesToProcess.length === 0) {
    console.log("No files to process.");
    process.exit(0);
  }

  console.log(`\n🚀 Processing batch of ${filesToProcess.length} items (concurrency: ${concurrency})...`);
  const limit = pLimit(concurrency);
  const summaryResults = [];

  const tasks = filesToProcess.map(item => {
    return limit(async () => {
      console.log(`\n🔄 Starting: '${item.name}'`);
      console.log(`   POB Coordinate : Northing = ${pobN}, Easting = ${pobE}`);
      console.log(`   Units          : ${units}`);
      console.log(`   Open Ended     : ${openEnded}`);
      console.log(`   Active Provider: ${getActiveProvider()} (${getActiveModel()})`);

      try {
        const result = await runRepairPipeline(
          item.buffer,
          item.mimeType,
          { northing: pobN, easting: pobE },
          units,
          openEnded,
          item.name,
          3, // maxTurns
          true // allowEscalation
        );

        let finalStatus = result.status;
        let perimeter = 0;
        let area = 0;
        let misclosure = 'N/A';
        let precision = 'N/A';

        if (result.finalTraverse) {
          const trav = result.finalTraverse;
          const closure = trav.closure || {};
          
          const linearError = trav.linearError !== undefined ? trav.linearError : closure.linearError;
          const precisionRatio = trav.precisionRatio !== undefined ? trav.precisionRatio : closure.precisionRatio;
          finalStatus = trav.status !== undefined ? trav.status : (closure.status || (trav.isPassing ? 'PASS' : 'FAIL'));

          perimeter = trav.perimeter || 0;
          area = trav.areaAcres || 0;
          misclosure = linearError !== undefined && linearError !== null ? `${linearError.toFixed(4)} ft` : 'N/A';
          precision = precisionRatio || 'N/A';

          // Export to DXF
          const stations = trav.stations || [];
          const adjusted = trav.adjustedStations || [];
          const courses = result.finalExtraction?.courses || [];
          
          const meta = {
            parcel: path.basename(item.output, path.extname(item.output)).toUpperCase(),
            county: result.finalExtraction?.county || 'Unknown',
            state: result.finalExtraction?.state || 'Unknown',
            areaAcres: trav.areaAcres || 0,
            perimeter: trav.perimeter || 0,
            basisOfBearings: 'DEED OF RECORD',
            units: units
          };

          const dxfString = generateDxf(stations, adjusted, courses, meta, result.bustCourseIndex);
          fs.writeFileSync(item.output, dxfString);
          
          // Save JSON metadata
          const jsonOutPath = item.output + '.json';
          fs.writeFileSync(jsonOutPath, JSON.stringify(result, null, 2));
          console.log(`🎉 Successfully reconstructed and saved: '${item.name}'`);
        } else {
          console.error(`❌ Failed to resolve traverse geometry for: '${item.name}'`);
        }

        summaryResults.push({
          name: item.name,
          status: finalStatus,
          perimeter,
          area,
          misclosure,
          precision
        });
      } catch (err) {
        console.error(`❌ Execution failed for '${item.name}' with exception:`, err);
        summaryResults.push({
          name: item.name,
          status: 'ERROR',
          perimeter: 0,
          area: 0,
          misclosure: 'N/A',
          precision: 'N/A'
        });
      }
    });
  });

  await Promise.all(tasks);

  console.log("\n==========================================================================================");
  console.log("                              RECONSTRUCTION BATCH SUMMARY");
  console.log("==========================================================================================");
  console.log(
    " " +
    "File Name / Page".padEnd(35) + " " +
    "Status".padEnd(10) + " " +
    "Perimeter".padEnd(12) + " " +
    "Area (Ac)".padEnd(10) + " " +
    "Linear Misc".padEnd(12) + " " +
    "Precision"
  );
  console.log("-".repeat(90));
  
  let successCount = 0;
  for (const res of summaryResults) {
    const isSuccess = res.status === 'PASS';
    if (isSuccess) successCount++;
    console.log(
      " " +
      res.name.substring(0, 34).padEnd(35) + " " +
      res.status.padEnd(10) + " " +
      (res.perimeter ? `${res.perimeter.toFixed(2)} ft` : '0.00 ft').padEnd(12) + " " +
      (res.area ? res.area.toFixed(4) : '0.0000').padEnd(10) + " " +
      res.misclosure.padEnd(12) + " " +
      res.precision
    );
  }
  console.log("-".repeat(90));
  console.log(` Successfully processed: ${successCount}/${summaryResults.length} files`);
  console.log("==========================================================================================\n");

  process.exit(0);
}

main();
