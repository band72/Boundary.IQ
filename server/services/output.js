// ─── Output Service ─────────────────────────────────────────────────────────
// Port of OutputService.cs — writes output files to dated subfolders.
// Extended: auto-saves DXF and PNG boundary sketch per deed during batch.

import fs   from 'fs';
import path from 'path';
import * as dxf    from './dxfExport.js';
import * as sketch from './sketchRenderer.js';
import { inferCountyStateFromText } from './geminiVision.js';
import * as traverseSvc from './Scripting/traverse.js';

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
 * Returns the combined PDF path if one was written, else null.
 */
export async function writeResultFiles(outputFolder, sourceFileName, result, writeResult, shortFileNames = false, showConceptualDetail = false, leaderStyle = 'arc', labelContentMode = 'auto', sourceFilePath = null) {
  const baseName = path.parse(sourceFileName).name;
  let targetFolder = outputFolder;
  if (shortFileNames) {
    targetFolder = path.join(outputFolder, baseName);
    if (!fs.existsSync(targetFolder)) {
      fs.mkdirSync(targetFolder, { recursive: true });
    }
  }

  try {
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
    const origDeedFile = shortFileNames ? 'Original_Deed.txt' : `${baseName}_original_deed.txt`;
    
    if (rawOCR) {
      fs.writeFileSync(path.join(targetFolder, ocrFile), rawOCR);
      fs.writeFileSync(path.join(targetFolder, origDeedFile), rawOCR);
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
      const txt = lines.join('\n');
      fs.writeFileSync(path.join(targetFolder, ocrFile), txt);
      fs.writeFileSync(path.join(targetFolder, origDeedFile), txt);
    }

    // 1. Corrected legal description
    const legalDesc = writeResult?.legalDescription || result.legalDescription || result.extraction?.legalDesc || result.extraction?.legalDescription || '';
    if (legalDesc) {
      const _inferred = inferCountyStateFromText(rawOCR || '');
      let countyVal = result.finalExtraction?.county || result.extraction?.county || _inferred.county || 'Unknown County';
      let stateVal = result.finalExtraction?.state || result.extraction?.state || _inferred.state || 'Unknown State';
      if (countyVal === 'Unknown') countyVal = 'Unknown County';
      if (stateVal === 'Unknown') stateVal = 'Unknown State';
      const formattedLegalDesc = `County: ${countyVal}\nState: ${stateVal}\n${'='.repeat(80)}\n${legalDesc}`;
      
      const correctedFile = shortFileNames ? 'Corrected.txt' : `${baseName}_corrected.txt`;
      const corrDeedFile = shortFileNames ? 'Corrected_Deed.txt' : `${baseName}_corrected_deed.txt`;
      fs.writeFileSync(path.join(targetFolder, correctedFile), formattedLegalDesc);
      fs.writeFileSync(path.join(targetFolder, corrDeedFile), formattedLegalDesc);
    }

    // 3. Full JSON report / Summary
    const report = {
      sourceFile: sourceFileName,
      processedAt: new Date().toISOString(),
      status: result.status,
      error: result.error,
      hasSelfIntersection: result.traverse?.hasSelfIntersection || result.hasSelfIntersection || false,
      selfIntersectionComment: result.selfIntersectionComment || (result.traverse?.hasSelfIntersection ? 'Warning: Boundary has self-intersecting lines (bowtie).' : null),
      extraction: result.extraction,
      traverse: result.traverse,
      legalDescription: legalDesc || null,
      originalExtraction: result.originalExtraction,
      conceptualAnalysis: result.conceptualAnalysis || result.extraction?.conceptualAnalysis || null
    };
    const reportFile = shortFileNames ? 'Summary.json' : `${baseName}_summary.json`;
    fs.writeFileSync(path.join(targetFolder, reportFile), JSON.stringify(report, null, 2));

    // POB and Units
    const pob = {
      northing: result.traverse?.stations?.[0]?.northing ?? 5000,
      easting: result.traverse?.stations?.[0]?.easting ?? 5000
    };
    const units = result.extraction?.units || 'Feet';

    // 4. Compute original uncorrected traverse
    let origCourses = result.originalExtraction?.courses || [];
    let origTraverse = null;
    if (origCourses.length > 0) {
      try {
        origTraverse = traverseSvc.compute({
          pointOfBeginning: pob,
          courses: origCourses,
          units,
          isOpenEnded: result.originalExtraction?.isOpenEnded || false
        });
      } catch (err) {
        console.warn(`Failed to compute original traverse for ${sourceFileName}:`, err.message);
      }
    }

    // 4.1 Original Cogo & Original Script
    if (origTraverse && origTraverse.stations?.length > 0) {
      const origCogoLines = ['Point,Northing,Easting,Description'];
      origTraverse.stations.forEach((s, idx) => {
        const adj = (origTraverse.adjustedStations || [])[idx] || s;
        const ptId = 500 + idx;
        const desc = idx === 0 ? 'COGO POB' : `COGO P${idx}`;
        origCogoLines.push(`${ptId},${adj.northing.toFixed(2)},${adj.easting.toFixed(2)},${desc}`);
      });
      const origCogoFile = shortFileNames ? 'Original_Cogo.txt' : `${baseName}_original_cogo.txt`;
      fs.writeFileSync(path.join(targetFolder, origCogoFile), origCogoLines.join('\n'));
    }

    if (origCourses.length > 0) {
      const origScriptLines = [];
      const origPobN = origTraverse?.stations?.[0]?.northing ?? 5000;
      const origPobE = origTraverse?.stations?.[0]?.easting ?? 5000;
      origScriptLines.push(`# COGO Script for ${sourceFileName} (ORIGINAL UNCORRECTED)`);
      origScriptLines.push(`POB N ${origPobN.toFixed(4)} E ${origPobE.toFixed(4)}`);
      origCourses.forEach((c, idx) => {
        if (c.type?.toLowerCase() === 'curve') {
          origScriptLines.push(`Curve Radius=${c.radius || 0} Delta=${c.delta || 0} Direction=${c.curveDirection || 'Right'} ChordBearing=${c.chordBearing || ''} ChordDistance=${c.chordDistance || 0}`);
        } else {
          origScriptLines.push(`${c.bearing || ''} ${c.distance || 0}`);
        }
      });
      const origScriptFile = shortFileNames ? 'Original_Script.txt' : `${baseName}_original_script.txt`;
      fs.writeFileSync(path.join(targetFolder, origScriptFile), origScriptLines.join('\n'));
    }

    // 4.2 Corrected Cogo & Corrected Script
    const stations = result.traverse?.stations || [];
    const adjusted = result.traverse?.adjustedStations || [];
    const courses  = result.extraction?.courses || result.finalExtraction?.courses || [];
    const conceptual = result.conceptualAnalysis || result.extraction?.conceptualAnalysis;

    if (stations.length > 0) {
      const cogoLines = ['Point,Northing,Easting,Description'];
      stations.forEach((s, idx) => {
        const adj = adjusted[idx] || s;
        const ptId = 500 + idx;
        const desc = idx === 0 ? 'COGO POB' : `COGO P${idx}`;
        cogoLines.push(`${ptId},${adj.northing.toFixed(2)},${adj.easting.toFixed(2)},${desc}`);
      });
      const cogoFile = shortFileNames ? 'Cogo.txt' : `${baseName}_cogo.txt`;
      const corrCogoFile = shortFileNames ? 'Corrected_Cogo.txt' : `${baseName}_corrected_cogo.txt`;
      fs.writeFileSync(path.join(targetFolder, cogoFile), cogoLines.join('\n'));
      fs.writeFileSync(path.join(targetFolder, corrCogoFile), cogoLines.join('\n'));
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
      const corrScriptFile = shortFileNames ? 'Corrected_Script.txt' : `${baseName}_corrected_script.txt`;
      fs.writeFileSync(path.join(targetFolder, scriptFile), scriptLines.join('\n'));
      fs.writeFileSync(path.join(targetFolder, corrScriptFile), scriptLines.join('\n'));
    }

    // Run Python Conceptual Map Pipeline if courses exist
    if (courses.length > 0) {
      let tempFilePath = null;
      let tempDeedPath = null;
      try {
        const { execSync } = await import('child_process');
        const { fileURLToPath } = await import('url');
        
        // Write courses JSON to a temporary file
        tempFilePath = path.join(targetFolder, `temp_courses_${Date.now()}_${Math.random().toString(36).substring(2, 9)}.json`);
        fs.writeFileSync(tempFilePath, JSON.stringify(courses));

        // Write deed text to a temporary file
        tempDeedPath = path.join(targetFolder, `temp_deed_${Date.now()}_${Math.random().toString(36).substring(2, 9)}.txt`);
        fs.writeFileSync(tempDeedPath, rawOCR || legalDesc || '');
        
        const pyScriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../conceptual_pipeline/main.py');
        const outSvg = path.join(targetFolder, shortFileNames ? 'Conceptual_Map.svg' : `${baseName}_conceptual_map.svg`);
        const outPng = path.join(targetFolder, shortFileNames ? 'Conceptual_Map.png' : `${baseName}_conceptual_map.png`);
        const outReport = path.join(targetFolder, shortFileNames ? 'Conceptual_Report.json' : `${baseName}_conceptual_report.json`);
        
        // Execute python pipeline with courses-json file
        const cmd = `python3 "${pyScriptPath}" --courses-json "${tempFilePath}" --deed-file "${tempDeedPath}" --output-svg "${outSvg}" --output-img "${outPng}" --output-report "${outReport}"`;
        execSync(cmd, { stdio: 'ignore' });
      } catch (pyErr) {
        console.warn(`Output: Python conceptual drawing pipeline failed for ${sourceFileName}:`, pyErr.message);
      } finally {
        if (tempFilePath && fs.existsSync(tempFilePath)) {
          try {
            fs.unlinkSync(tempFilePath);
          } catch {}
        }
        if (tempDeedPath && fs.existsSync(tempDeedPath)) {
          try {
            fs.unlinkSync(tempDeedPath);
          } catch {}
        }
      }
    }

    if (conceptual && (!courses || courses.length === 0)) {
      try {
        const _inferred0 = inferCountyStateFromText(rawOCR || '');
        const skMeta = {
          parcel:          result.extraction?.parcelDescription || path.parse(sourceFileName).name,
          county:          result.finalExtraction?.county      || result.extraction?.county           || _inferred0.county || null,
          state:           result.finalExtraction?.state       || result.extraction?.state            || _inferred0.state  || null,
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

        // Save combined PDF deliverable — awaited so file is flushed before return
        const pdfName = shortFileNames ? 'Map.pdf' : `${baseName}_map.pdf`;
        const outPdfPath = path.join(targetFolder, pdfName);
        await saveCombinedPdf(outPdfPath, pageBuffers);
        return outPdfPath;
      } catch (pngEx) {
        console.warn(`Output: Conceptual PNG sketch failed for ${sourceFileName}:`, pngEx.message);
      }
    }

    // 4.3 DXF generation
    const _inferred1 = inferCountyStateFromText(rawOCR || '');
    
    // Original DXF
    if (origTraverse && origTraverse.stations?.length >= 2 && origCourses.length >= 1) {
      try {
        const origMeta = {
          parcel:          (result.extraction?.parcelDescription || baseName) + ' (ORIGINAL UNCORRECTED)',
          county:          result.finalExtraction?.county      || result.extraction?.county           || _inferred1.county || null,
          state:           result.finalExtraction?.state       || result.extraction?.state            || _inferred1.state  || null,
          units:           units,
          areaAcres:       origTraverse.areaAcres              || 0,
          perimeter:       origTraverse.perimeter              || 0,
          basisOfBearings: result.extraction?.basisOfBearings  || null,
        };
        const origDxfStr = dxf.generateDxf(origTraverse.stations, origTraverse.adjustedStations || [], origCourses, origMeta);
        const origDxfFile = shortFileNames ? 'Original_DXF.dxf' : `${baseName}_original_dxf.dxf`;
        fs.writeFileSync(path.join(targetFolder, origDxfFile), origDxfStr, 'utf-8');
      } catch (dxfEx) {
        console.warn(`Output: Original DXF generation failed for ${sourceFileName}:`, dxfEx.message);
      }
    }

    // Corrected DXF
    if (stations.length >= 2 && courses.length >= 1) {
      try {
        const meta = {
          parcel:          result.extraction?.parcelDescription || path.parse(sourceFileName).name,
          county:          result.finalExtraction?.county      || result.extraction?.county           || _inferred1.county || null,
          state:           result.finalExtraction?.state       || result.extraction?.state            || _inferred1.state  || null,
          units:           result.extraction?.units            || 'Feet',
          areaAcres:       result.traverse?.areaAcres          || 0,
          perimeter:       result.traverse?.perimeter          || 0,
          basisOfBearings: result.extraction?.basisOfBearings  || null,
        };
        const dxfStr = dxf.generateDxf(stations, adjusted, courses, meta);
        const dxfFile = shortFileNames ? 'DXF.dxf' : `${baseName}_dxf.dxf`;
        const corrDxfFile = shortFileNames ? 'Corrected_DXF.dxf' : `${baseName}_corrected_dxf.dxf`;
        fs.writeFileSync(path.join(targetFolder, dxfFile), dxfStr, 'utf-8');
        fs.writeFileSync(path.join(targetFolder, corrDxfFile), dxfStr, 'utf-8');
        console.log(`Output: wrote DXF — ${path.basename(dxfFile)}`);

        // If sourceFilePath is supplied, mirror-save to source folder
        if (sourceFilePath) {
          try {
            dxf.saveToSourceDir(
              dxfStr,
              sourceFilePath,
              stations,
              courses,
              meta,
              result.traverse?.hasSelfIntersection ?? false,
              result.traverse?.closure?.linearError ?? null
            );
          } catch (mErr) {
            console.warn('[OUTPUT] Mirror saving failed:', mErr.message);
          }
        }
      } catch (dxfEx) {
        console.warn(`Output: DXF generation failed for ${sourceFileName}:`, dxfEx.message);
      }

      // 4.4 Original Map Rendering (PNG and PDF)
      if (origTraverse && origTraverse.stations?.length >= 2 && origCourses.length >= 1) {
        try {
          const origSkMeta = {
            parcel:          (result.extraction?.parcelDescription || baseName) + ' (ORIGINAL UNCORRECTED)',
            county:          result.finalExtraction?.county      || result.extraction?.county           || _inferred1.county || null,
            state:           result.finalExtraction?.state       || result.extraction?.state            || _inferred1.state  || null,
            units:           units,
            areaAcres:       origTraverse.areaAcres              || 0,
            perimeter:       origTraverse.perimeter              || 0,
            basisOfBearings: result.extraction?.basisOfBearings  || null,
            status:          'ORIGINAL',
            hasSelfIntersection: origTraverse.hasSelfIntersection || false,
          };
          const origClosure = origTraverse.closure || null;
          let origLegalDesc = result.originalExtraction?.originalLegalDesc ||
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

          const origPages = sketch.renderSketchPages(
            origTraverse.stations, origTraverse.adjustedStations || [], origCourses, origSkMeta,
            origClosure, origLegalDesc, origLegalDesc, origCourses, showConceptualDetail,
            false, rawOCR || null, leaderStyle, labelContentMode
          );

          const origPageBuffers = [];
          Object.entries(origPages).forEach(([key, buf], i) => {
            const pngName = shortFileNames ? `Original_Map_p${i + 1}.png` : `${baseName}_original_map_p${i + 1}.png`;
            fs.writeFileSync(path.join(targetFolder, pngName), buf);
            origPageBuffers.push(buf);
          });

          const origPdfName = shortFileNames ? 'Original_Map.pdf' : `${baseName}_original_map.pdf`;
          await saveCombinedPdf(path.join(targetFolder, origPdfName), origPageBuffers);
        } catch (pngEx) {
          console.warn(`Output: Original PNG sketch failed for ${sourceFileName}:`, pngEx.message);
        }
      }

      // 4.5 Corrected Map Rendering (PNG and PDF)
      let finalOutPdfPath = null;
      try {
        const skMeta = {
          parcel:          result.extraction?.parcelDescription || path.parse(sourceFileName).name,
          county:          result.finalExtraction?.county      || result.extraction?.county           || _inferred1.county || null,
          state:           result.finalExtraction?.state       || result.extraction?.state            || _inferred1.state  || null,
          units:           result.extraction?.units            || 'Feet',
          areaAcres:       result.traverse?.areaAcres          || 0,
          perimeter:       result.traverse?.perimeter          || 0,
          basisOfBearings: result.extraction?.basisOfBearings  || null,
          status:          result.status                       || null,
          hasSelfIntersection: result.traverse?.hasSelfIntersection || result.hasSelfIntersection || false,
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
          closure, legalDesc, origLegalDesc, origCourses, showConceptualDetail,
          false, rawOCR || null, leaderStyle, labelContentMode
        );

        const pageLabels = ['sketch_p1', 'sketch_p2_ocr', 'sketch_p3', 'sketch_p4', 'sketch_p5', 'sketch_p6'];
        const pageBuffers = [];
        Object.entries(pages).forEach(([key, buf], i) => {
          const pngName = shortFileNames ? `Map_p${i + 1}.png` : `${baseName}_map_p${i + 1}.png`;
          const corrPngName = shortFileNames ? `Corrected_Map_p${i + 1}.png` : `${baseName}_corrected_map_p${i + 1}.png`;
          fs.writeFileSync(path.join(targetFolder, pngName), buf);
          fs.writeFileSync(path.join(targetFolder, corrPngName), buf);
          pageBuffers.push(buf);
          console.log(`Output: wrote PNG page ${i + 1} — ${path.basename(pngName)}`);
        });

        // Save combined PDF deliverable — awaited so file is flushed before return
        const pdfName = shortFileNames ? 'Map.pdf' : `${baseName}_map.pdf`;
        const corrPdfName = shortFileNames ? 'Corrected_Map.pdf' : `${baseName}_corrected_map.pdf`;
        finalOutPdfPath = path.join(targetFolder, pdfName);
        
        await saveCombinedPdf(finalOutPdfPath, pageBuffers);
        await saveCombinedPdf(path.join(targetFolder, corrPdfName), pageBuffers);
      } catch (pngEx) {
        console.warn(`Output: PNG sketch failed for ${sourceFileName}:`, pngEx.message);
      }
      return finalOutPdfPath;
    }
  } catch (ex) {
    console.warn(`Failed to write output files for ${sourceFileName}:`, ex.message);
  }
  return null; // no PDF written
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
        hasSelfIntersection: r.traverse?.hasSelfIntersection || r.hasSelfIntersection || false,
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
      if (r.traverse?.hasSelfIntersection || r.hasSelfIntersection) {
        txtLines.push(`         [WARNING] Self-intersecting boundary (bowtie) detected.`);
      }
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

/**
 * Compile a single _BATCH_REPORT.pdf from all per-deed Map PDFs in the output folder.
 * Merges both top-level PDFs and PDFs inside short-filename subfolders.
 * Call this after all writeResultFiles() calls have resolved.
 */
export async function writeCombinedBatchPdf(outputFolder) {
  try {
    const { PDFDocument } = await import('pdf-lib');
    const mergedDoc = await PDFDocument.create();

    // Gather per-deed PDFs from top-level and one level of subfolders, sorted alphabetically
    const allEntries = fs.readdirSync(outputFolder, { withFileTypes: true });
    const topPdfs = allEntries
      .filter(e => e.isFile() && e.name.endsWith('.pdf') && !e.name.startsWith('_BATCH'))
      .map(e => path.join(outputFolder, e.name))
      .sort();

    const subPdfs = [];
    for (const entry of allEntries.filter(e => e.isDirectory())) {
      const subDir = path.join(outputFolder, entry.name);
      fs.readdirSync(subDir)
        .filter(f => f.endsWith('.pdf') && !f.startsWith('_BATCH'))
        .sort()
        .forEach(f => subPdfs.push(path.join(subDir, f)));
    }

    const pdfFiles = [...topPdfs, ...subPdfs];

    if (pdfFiles.length === 0) {
      console.log('writeCombinedBatchPdf: no per-deed PDFs found — skipping batch report.');
      return null;
    }

    for (const pdfPath of pdfFiles) {
      try {
        const srcBytes = fs.readFileSync(pdfPath);
        const srcDoc = await PDFDocument.load(srcBytes);
        const copiedPages = await mergedDoc.copyPages(srcDoc, srcDoc.getPageIndices());
        copiedPages.forEach(p => mergedDoc.addPage(p));
      } catch (pageErr) {
        console.warn(`writeCombinedBatchPdf: skipping ${path.basename(pdfPath)} — ${pageErr.message}`);
      }
    }

    const outPath = path.join(outputFolder, '_BATCH_REPORT.pdf');
    fs.writeFileSync(outPath, await mergedDoc.save());
    console.log(`Output: compiled combined batch PDF (${pdfFiles.length} deed PDFs) → ${path.basename(outPath)}`);
    return outPath;
  } catch (ex) {
    console.warn('writeCombinedBatchPdf failed:', ex.message);
    return null;
  }
}
