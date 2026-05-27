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
export function writeResultFiles(outputFolder, sourceFileName, result, writeResult) {
  const baseName = path.parse(sourceFileName).name;

  try {
    // 1. Corrected legal description
    if (writeResult?.legalDescription) {
      fs.writeFileSync(path.join(outputFolder, `${baseName}_corrected.txt`), writeResult.legalDescription);
    }

    // 2. Original extraction summary
    if (result.originalExtraction?.courses?.length > 0) {
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
      fs.writeFileSync(path.join(outputFolder, `${baseName}_original.txt`), lines.join('\n'));
    }

    // 3. Full JSON report
    const report = {
      sourceFile: sourceFileName,
      processedAt: new Date().toISOString(),
      status: result.status,
      error: result.error,
      extraction: result.extraction,
      traverse: result.traverse,
      legalDescription: writeResult?.legalDescription || null,
      originalExtraction: result.originalExtraction,
    };
    fs.writeFileSync(path.join(outputFolder, `${baseName}_report.json`), JSON.stringify(report, null, 2));

    // 4. DXF — surveyor-grade CAD file
    //    Only generated when we have stations (traverse computed successfully)
    const stations = result.traverse?.stations || [];
    const adjusted = result.traverse?.adjustedStations || [];
    const courses  = result.extraction?.courses || result.finalExtraction?.courses || [];
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
        fs.writeFileSync(path.join(outputFolder, `${baseName}.dxf`), dxfStr, 'utf-8');
        console.log(`Output: wrote DXF — ${baseName}.dxf`);
      } catch (dxfEx) {
        console.warn(`Output: DXF generation failed for ${sourceFileName}:`, dxfEx.message);
      }

      // 5. PNG boundary sketch — letter-landscape at 2× resolution
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
        const pngBuf = sketch.renderSketchPng(stations, adjusted, courses, skMeta);
        fs.writeFileSync(path.join(outputFolder, `${baseName}_sketch.png`), pngBuf);
        console.log(`Output: wrote PNG sketch — ${baseName}_sketch.png`);
      } catch (pngEx) {
        console.warn(`Output: PNG sketch failed for ${sourceFileName}:`, pngEx.message);
      }
    }
  } catch (ex) {
    console.warn(`Failed to write output files for ${sourceFileName}:`, ex.message);
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
    console.log(`Wrote batch summary: ${path.join(outputFolder, '_BATCH_SUMMARY.json')}`);
  } catch (ex) {
    console.warn('Failed to write batch summary:', ex.message);
  }
}
