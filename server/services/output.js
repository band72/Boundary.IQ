// ─── Output Service ─────────────────────────────────────────────────────────
// Port of OutputService.cs — writes output files to dated subfolders.
// Extended: auto-saves DXF and PNG boundary sketch per deed during batch.

import fs   from 'fs';
import path from 'path';
import * as dxf    from './dxfExport.js';
import * as sketch from './sketchRenderer.js';

/**
 * Creates a dated output subfolder and returns its path.
 * Format: DDMMYYYY.fff (day, month, full year, dot, milliseconds)
 */
export function createOutputFolder(sourceFolder) {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const yyyy = now.getFullYear();
  const fff = String(now.getMilliseconds()).padStart(3, '0');
  let folderName = `${dd}${mm}${yyyy}.${fff}`;
  let outputPath = path.join(sourceFolder, folderName);

  if (fs.existsSync(outputPath)) {
    let counter = 1;
    while (fs.existsSync(`${outputPath}_${counter}`)) counter++;
    outputPath = `${outputPath}_${counter}`;
  }

  fs.mkdirSync(outputPath, { recursive: true });
  console.log(`Created output folder: ${outputPath}`);
  return outputPath;
}

/**
 * Write output files for a single processed deed result.
 */
export function writeResultFiles(outputFolder, sourceFileName, result, writeResult, shortFileNames = false, showConceptualDetail = false) {
  const baseName = path.parse(sourceFileName).name;
  let targetFolder = outputFolder;
  if (shortFileNames) {
    targetFolder = path.join(outputFolder, baseName);
    if (!fs.existsSync(targetFolder)) {
      fs.mkdirSync(targetFolder, { recursive: true });
    }
  }

  try {
    // 1. Corrected legal description
    const legalDesc = writeResult?.legalDescription || result.legalDescription || result.extraction?.legalDesc || result.extraction?.legalDescription || '';
    if (legalDesc) {
      const correctedFile = shortFileNames ? 'Corrected.txt' : `${baseName}_corrected.txt`;
      fs.writeFileSync(path.join(targetFolder, correctedFile), legalDesc);
    }

    // 2. OCR / Original text file
    let rawOCR = result.extraction?.originalLegalDesc ||
                 result.originalExtraction?.originalLegalDesc ||
                 result.extraction?.originalLegalDescription ||
                 result.originalExtraction?.originalLegalDescription ||
                 null;

    if (!rawOCR) {
      try {
        const sourceFolder = path.dirname(outputFolder);
        const txtSource = path.join(sourceFolder, '_extracted', `${baseName}.txt`);
        if (fs.existsSync(txtSource)) {
          const txtContent = fs.readFileSync(txtSource, 'utf-8');
          if (txtContent && txtContent.trim().length >= 80) {
            rawOCR = txtContent.trim();
          }
        }
      } catch (err) {
        console.warn('Failed to read rawOCR from cache file:', err.message);
      }
    }

    if (!rawOCR) {
      rawOCR = result.extraction?.rawText ||
               result.originalExtraction?.rawText ||
               result.rawText || '';
    }

    const ocrFile = shortFileNames ? 'OCR.txt' : `${baseName}_ocr.txt`;
    if (rawOCR) {
      fs.writeFileSync(path.join(targetFolder, ocrFile), rawOCR);
    } else if (result.originalExtraction?.courses?.length > 0) {
      const lines = [
        `ORIGINAL EXTRACTION — ${sourceFileName}`,
        `Classification: ${result.originalExtraction.classification}`,
        `Course Count: ${result.originalExtraction.courses.length}`,
        `Preamble Found: ${result.originalExtraction.preambleFound}`,
        '',
        'ORIGINAL COURSES:',
        '─────────────────────────────────────────────────',
      ];
      result.originalExtraction.courses.forEach((c, i) => {
        if ((c.type || '').toLowerCase() === 'curve') {
          lines.push(`  C${i + 1}: ${c.type} — Chord: ${c.chordBearing} ${(c.chordDistance || 0).toFixed(2)}' | Radius: ${(c.radius || 0).toFixed(2)}' | Arc: ${(c.arcLength || 0).toFixed(2)}' | Delta: ${c.delta} | Dir: ${c.curveDirection}`);
        } else {
          lines.push(`  L${i + 1}: ${c.type} — ${c.bearing}  ${(c.distance || 0).toFixed(2)}'${c.isUnknown ? ' [UNKNOWN/MEANDER]' : ''}`);
        }
      });
      fs.writeFileSync(path.join(targetFolder, ocrFile), lines.join('\n'));
    }

    // 3. Full JSON report / Summary
    const report = {
      sourceFile: sourceFileName,
      processedAt: new Date().toISOString(),
      status: result.status,
      error: result.error,
      extraction: result.extraction,
      traverse: result.traverse,
      legalDescription: legalDesc || null,
      originalExtraction: result.originalExtraction,
      conceptualAnalysis: result.conceptualAnalysis || result.extraction?.conceptualAnalysis || null
    };
    const reportFile = shortFileNames ? 'Summary.json' : `${baseName}_summary.json`;
    fs.writeFileSync(path.join(targetFolder, reportFile), JSON.stringify(report, null, 2));

    // 4. DXF — surveyor-grade CAD file
    const stations = result.traverse?.stations || [];
    const adjusted = result.traverse?.adjustedStations || [];
    const courses  = result.extraction?.courses || result.finalExtraction?.courses || [];
    const conceptual = result.conceptualAnalysis || result.extraction?.conceptualAnalysis;

    // 4.1 Cogo file & Script file generation
    if (stations.length > 0) {
      const cogoLines = ['Point,Northing,Easting,Description'];
      stations.forEach((s, idx) => {
        const adj = adjusted[idx] || s;
        cogoLines.push(`${s.seq + 1},${adj.northing.toFixed(4)},${adj.easting.toFixed(4)},${s.course || ''}`);
      });
      const cogoFile = shortFileNames ? 'Cogo.txt' : `${baseName}_cogo.txt`;
      fs.writeFileSync(path.join(targetFolder, cogoFile), cogoLines.join('\n'));
    }

    if (courses.length > 0) {
      const scriptLines = [];
      const pobN = result.traverse?.stations?.[0]?.northing ?? 5000;
      const pobE = result.traverse?.stations?.[0]?.easting ?? 5000;
      scriptLines.push(`# COGO Script for ${sourceFileName}`);
      scriptLines.push(`POB N ${pobN.toFixed(4)} E ${pobE.toFixed(4)}`);
      courses.forEach((c, idx) => {
        if (c.type?.toLowerCase() === 'curve') {
          scriptLines.push(`Curve Radius=${c.radius || 0} Delta=${c.delta || 0} Direction=${c.curveDirection || 'Right'} ChordBearing=${c.chordBearing || ''} ChordDistance=${c.chordDistance || 0}`);
        } else {
          scriptLines.push(`${c.bearing || ''} ${c.distance || 0}`);
        }
      });
      const scriptFile = shortFileNames ? 'Script.txt' : `${baseName}_script.txt`;
      fs.writeFileSync(path.join(targetFolder, scriptFile), scriptLines.join('\n'));
    }

    if (conceptual && (!courses || courses.length === 0)) {
      try {
        const skMeta = {
          parcel:          result.extraction?.parcelDescription || path.parse(sourceFileName).name,
          county:          result.extraction?.county           || null,
          state:           result.extraction?.state            || null,
          units:           result.extraction?.units            || 'Feet',
          areaAcres:       0,
          perimeter:       0,
          basisOfBearings: result.extraction?.basisOfBearings  || null,
          status:          'SKIPPED',
        };

        const pages = sketch.renderConceptualPages(
          conceptual,
          legalDesc,
          skMeta
        );

        const pageLabels = ['conceptual_map', 'record_legal', 'conceptual_analysis'];
        const pageBuffers = [];
        Object.entries(pages).forEach(([key, buf], i) => {
          const pngName = shortFileNames ? `Map_${pageLabels[i]}.png` : `${baseName}_map_${pageLabels[i]}.png`;
          const outPath = path.join(targetFolder, pngName);
          fs.writeFileSync(outPath, buf);
          pageBuffers.push(buf);
          console.log(`Output: wrote PNG conceptual page ${i + 1} — ${path.basename(outPath)}`);
        });

        // Save combined PDF deliverable
        const pdfName = shortFileNames ? 'Map.pdf' : `${baseName}_map.pdf`;
        const outPdfPath = path.join(targetFolder, pdfName);
        saveCombinedPdf(outPdfPath, pageBuffers);
      } catch (pngEx) {
        console.warn(`Output: Conceptual PNG sketch failed for ${sourceFileName}:`, pngEx.message);
      }
    }

    if (stations.length >= 2 && courses.length >= 1) {
      try {
        const meta = {
          parcel:          result.extraction?.parcelDescription || path.parse(sourceFileName).name,
          county:          result.extraction?.county           || null,
          state:           result.extraction?.state            || null,
          units:           result.extraction?.units            || 'Feet',
          areaAcres:       result.traverse?.areaAcres          || 0,
          perimeter:       result.traverse?.perimeter          || 0,
          basisOfBearings: result.extraction?.basisOfBearings  || null,
        };
        const dxfStr = dxf.generateDxf(stations, adjusted, courses, meta);
        const dxfFile = shortFileNames ? 'DXF.dxf' : `${baseName}_dxf.dxf`;
        fs.writeFileSync(path.join(targetFolder, dxfFile), dxfStr, 'utf-8');
        console.log(`Output: wrote DXF — ${path.basename(dxfFile)}`);
      } catch (dxfEx) {
        console.warn(`Output: DXF generation failed for ${sourceFileName}:`, dxfEx.message);
      }

      // 5. PNG boundary sketches — 5 pages mirroring the multi-page PDF layout
      try {
        const skMeta = {
          parcel:          result.extraction?.parcelDescription || path.parse(sourceFileName).name,
          county:          result.extraction?.county           || null,
          state:           result.extraction?.state            || null,
          units:           result.extraction?.units            || 'Feet',
          areaAcres:       result.traverse?.areaAcres          || 0,
          perimeter:       result.traverse?.perimeter          || 0,
          basisOfBearings: result.extraction?.basisOfBearings  || null,
          status:          result.status                       || null,
        };
        const closure          = result.traverse?.closure          || null;
        const legalDesc        = writeResult?.legalDescription     || null;
        let origLegalDesc      = result.originalExtraction?.originalLegalDesc ||
                                 result.originalExtraction?.originalLegalDescription ||
                                 result.extraction?.originalLegalDesc ||
                                 result.extraction?.originalLegalDescription ||
                                 null;

        if (!origLegalDesc) {
          try {
            const sourceFolder = path.dirname(outputFolder);
            const txtSource = path.join(sourceFolder, '_extracted', `${baseName}.txt`);
            if (fs.existsSync(txtSource)) {
              const txtContent = fs.readFileSync(txtSource, 'utf-8');
              if (txtContent && txtContent.trim().length >= 80) {
                origLegalDesc = txtContent.trim();
              }
            }
          } catch (err) {
            console.warn('Failed to read origLegalDesc from cache file:', err.message);
          }
        }

        if (!origLegalDesc) {
          origLegalDesc = result.originalExtraction?.legalDescription ||
                          result.legalDescription?.legalDescription   || legalDesc;
        }
        const origCourses      = result.originalExtraction?.courses          || null;

        const pages = sketch.renderSketchPages(
          stations, adjusted, courses, skMeta,
          closure, legalDesc, origLegalDesc, origCourses, showConceptualDetail
        );

        const pageLabels = ['sketch_p1', 'sketch_p2', 'sketch_p3', 'sketch_p4', 'sketch_p5'];
        const pageBuffers = [];
        Object.entries(pages).forEach(([key, buf], i) => {
          const pngName = shortFileNames ? `Map_p${i + 1}.png` : `${baseName}_map_p${i + 1}.png`;
          const outPath = path.join(targetFolder, pngName);
          fs.writeFileSync(outPath, buf);
          pageBuffers.push(buf);
          console.log(`Output: wrote PNG page ${i + 1} — ${path.basename(outPath)}`);
        });

        // Save combined PDF deliverable
        const pdfName = shortFileNames ? 'Map.pdf' : `${baseName}_map.pdf`;
        const outPdfPath = path.join(targetFolder, pdfName);
        saveCombinedPdf(outPdfPath, pageBuffers);
      } catch (pngEx) {
        console.warn(`Output: PNG sketch failed for ${sourceFileName}:`, pngEx.message);
      }
    }
  } catch (ex) {
    console.warn(`Failed to write output files for ${sourceFileName}:`, ex.message);
  }
}

/**
 * Helper to compile and write a combined PDF using pdf-lib (runs asynchronously).
 */
async function saveCombinedPdf(outPdfPath, pageBuffers) {
  try {
    const { PDFDocument } = await import('pdf-lib');
    const pdfDoc = await PDFDocument.create();
    for (const buf of pageBuffers) {
      const img = await pdfDoc.embedPng(buf);
      const page = pdfDoc.addPage([792, 612]);
      page.drawImage(img, {
        x: 0,
        y: 0,
        width: 792,
        height: 612
      });
    }
    const pdfBytes = await pdfDoc.save();
    fs.writeFileSync(outPdfPath, pdfBytes);
    console.log(`Output: compiled and wrote combined PDF deliverable — ${path.basename(outPdfPath)}`);
  } catch (pdfEx) {
    console.warn(`Output: failed to compile PDF deliverable:`, pdfEx.message);
  }
}

/**
 * Write a batch summary manifest.
 */
export function writeBatchSummary(outputFolder, sourcePath, results, elapsedMs) {
  try {
    const total = results.length;
    const passed = results.filter(r => r.status === 'success' || r.status === 'PASS').length;
    const failed = results.filter(r => r.status === 'error' || r.status === 'FAIL').length;
    const meander = results.filter(r => r.status === 'MEANDER').length;

    const summary = {
      batchSummary: {
        sourcePath, outputFolder,
        processedAt: new Date().toISOString(),
        elapsedSeconds: Math.round(elapsedMs / 100) / 10,
        totalFiles: total, passed, failed, meander,
        passRate: total > 0 ? `${(100 * passed / total).toFixed(1)}%` : 'N/A',
      },
      files: results.map(r => ({
        fileName: r.fileName,
        status: r.status,
        courses: r.extraction?.courses?.length || 0,
        linearError: r.traverse?.closure?.linearError || null,
        precision: r.traverse?.closure?.precisionRatio || null,
        error: r.error,
      })),
    };

    fs.writeFileSync(path.join(outputFolder, '_BATCH_SUMMARY.json'), JSON.stringify(summary, null, 2));
    console.log(`Wrote batch summary JSON: ${path.join(outputFolder, '_BATCH_SUMMARY.json')}`);

    // Generate human-readable text summary
    const separator = '='.repeat(80);
    const lineRule = '─'.repeat(80);
    const skippedCount = results.filter(r => r?.status === 'skipped').length;
    const txtLines = [
      separator,
      '                           BOUNDARY.IQ BATCH SCAN SUMMARY',
      separator,
      `Processed At:   ${new Date().toISOString()}`,
      `Source Folder:  ${sourcePath}`,
      `Output Folder:  ${outputFolder}`,
      `Elapsed Time:   ${(Math.round(elapsedMs / 100) / 10).toFixed(1)} seconds`,
      '',
      `Total Files:    ${total}`,
      `Passed:         ${passed} (Success: ${passed - meander}, Meander/Open-ended: ${meander})`,
      `Skipped:        ${skippedCount}`,
      `Failed:         ${failed}`,
      `Pass Rate:      ${total > 0 ? `${(100 * passed / total).toFixed(1)}%` : 'N/A'}`,
      '',
      separator,
      '                                 FILE DETAILS',
      separator,
      'STATUS   COURSES  PRECISION   ERROR (FT)  FILE NAME / DETAILS',
      lineRule
    ];

    results.forEach(r => {
      if (!r) return;
      const statusField = (r.status || 'FAIL').toUpperCase().padEnd(9);
      const coursesField = String(r.extraction?.courses?.length || 0).padEnd(9);
      const prec = r.traverse?.closure?.precisionRatio || '—';
      const precisionField = prec.padEnd(12);
      const errVal = r.traverse?.closure?.linearError != null ? r.traverse.closure.linearError.toFixed(4) : '—';
      const errorField = errVal.padEnd(12);
      
      txtLines.push(`${statusField}${coursesField}${precisionField}${errorField}${r.fileName}`);
      if (r.status === 'skipped' && r.skipReason) {
        txtLines.push(`         [SKIP REASON] ${r.skipReason}`);
      } else if (r.status === 'error' && r.error) {
        txtLines.push(`         [ERROR] ${r.error}`);
      }
    });

    txtLines.push(lineRule);
    fs.writeFileSync(path.join(outputFolder, '_BATCH_SUMMARY.txt'), txtLines.join('\n'));
    console.log(`Wrote batch summary TXT: ${path.join(outputFolder, '_BATCH_SUMMARY.txt')}`);
  } catch (ex) {
    console.warn('Failed to write batch summary:', ex.message);
  }
}
