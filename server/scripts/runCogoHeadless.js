#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, '..');
process.chdir(SERVER_DIR);

// Lazy-import services
const Scripting = await import('../services/Scripting/index.js');

const COGO_DIR = process.argv[2] || '/home/artwalk/Downloads/drive-download-20260714T131128Z-1-001';
const REPORT_FILE = path.join(SERVER_DIR, '../cogo_batch_report.json');
const SUMMARY_FILE = path.join(SERVER_DIR, '../cogo_batch_summary.md');

function parseCogoFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');

  const boundaries = {};
  let currentBegBoundary = null;
  let begCourses = [];

  let currentMapcheckBoundary = null;
  let mapcheckCourses = [];
  let currentMetrics = {};

  const lineCourseRegex = /(?:BEARING|Course):\s*([^D]+?)\s+(?:DISTANCE|Distance):\s*([\d\.]+)/i;
  const lineCurveRegex = /(?:Arc Length|Arc):\s*([\d\.\-]+)\s+(?:Radius|Rad):\s*([\d\.\-]+)\s+Delta:\s*([\d\.\-]+)/i;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const cleanLine = rawLine.trim();

    // Detect BEG [name] in point-log mode
    const begMatch = cleanLine.match(/BEG\s+([a-zA-Z0-9_]+)/i);
    if (begMatch) {
      currentBegBoundary = begMatch[1].toUpperCase();
      begCourses = [];
      currentMapcheckBoundary = null;
      continue;
    }

    // Detect END or MAPCHK to close the BEG block
    if (cleanLine.match(/END|MAPCHK/i)) {
      if (currentBegBoundary && begCourses.length > 0) {
        if (!boundaries[currentBegBoundary]) {
          boundaries[currentBegBoundary] = { source: 'BEG', courses: [] };
        }
        boundaries[currentBegBoundary].courses = begCourses;
      }
      currentBegBoundary = null;
    }

    // Detect Figure Name: [name] in mapcheck mode
    const figMatch = cleanLine.match(/Figure Name:\s*([a-zA-Z0-9_]+)/i);
    if (figMatch) {
      currentMapcheckBoundary = figMatch[1].toUpperCase();
      mapcheckCourses = [];
      currentMetrics = {};
      currentBegBoundary = null; 
      continue;
    }

    // Parse course/curve lines
    const courseMatch = cleanLine.match(lineCourseRegex);
    if (courseMatch) {
      const bearingStr = courseMatch[1].trim();
      const distance = parseFloat(courseMatch[2]);
      const courseObj = { type: 'Line', bearing: bearingStr, distance };
      
      if (currentMapcheckBoundary) {
        mapcheckCourses.push(courseObj);
      } else if (currentBegBoundary) {
        begCourses.push(courseObj);
      }
      continue;
    }

    const curveMatch = cleanLine.match(lineCurveRegex);
    if (curveMatch) {
      const arcLength = parseFloat(curveMatch[1]);
      const radius = parseFloat(curveMatch[2]);
      const deltaStr = curveMatch[3].trim();
      
      // Parse delta string to decimal degrees
      let deltaDeg = 0;
      const parts = deltaStr.split('-');
      if (parts.length >= 1) {
        const deg = parseFloat(parts[0]) || 0;
        const min = parseFloat(parts[1]) || 0;
        const sec = parseFloat(parts[2]) || 0;
        const absVal = Math.abs(deg) + min / 60 + sec / 3600;
        deltaDeg = deg < 0 || deltaStr.startsWith('-') ? -absVal : absVal;
      } else {
        deltaDeg = parseFloat(deltaStr) || 0;
      }

      const curveDirection = deltaDeg < 0 ? 'Left' : 'Right';

      const courseObj = {
        type: 'Curve',
        radius: Math.abs(radius),
        arcLength: Math.abs(arcLength),
        delta: Math.abs(deltaDeg).toFixed(6),
        curveDirection
      };

      if (currentMapcheckBoundary) {
        mapcheckCourses.push(courseObj);
      } else if (currentBegBoundary) {
        begCourses.push(courseObj);
      }
      continue;
    }

    // Parse printed metrics in mapcheck block
    if (currentMapcheckBoundary) {
      const perimMatch = cleanLine.match(/Perimeter:\s*([\d\.,]+)/i);
      if (perimMatch) currentMetrics.perimeter = parseFloat(perimMatch[1].replace(/,/g, ''));

      const areaMatch = cleanLine.match(/Area:\s*([\d\.,]+)/i);
      if (areaMatch) currentMetrics.areaSqFt = parseFloat(areaMatch[1].replace(/,/g, ''));

      const closureMatch = cleanLine.match(/(?:Error of Closure|Error):\s*([\d\.,]+)/i);
      if (closureMatch) currentMetrics.linearError = parseFloat(closureMatch[1].replace(/,/g, ''));

      const precMatch = cleanLine.match(/Precision\s*(?:1:)?\s*([\d\.,]+|<Illegal>)/i);
      if (precMatch) {
        currentMetrics.precisionRatio = precMatch[1].trim();
      }

      if (cleanLine.match(/Error of Closure|Precision/i) || (cleanLine === '' && mapcheckCourses.length > 0)) {
        // Stop parser if we got all metrics or hit a blank line
        if (mapcheckCourses.length > 0) {
          boundaries[currentMapcheckBoundary] = { 
            source: 'MAPCHK', 
            courses: mapcheckCourses, 
            metrics: currentMetrics 
          };
        }
        if (cleanLine.match(/Precision/i) || cleanLine === '') {
          currentMapcheckBoundary = null;
        }
      }
    }
  }

  // Fallback close
  if (currentBegBoundary && begCourses.length > 0) {
    if (!boundaries[currentBegBoundary]) {
      boundaries[currentBegBoundary] = { source: 'BEG', courses: begCourses };
    }
  }
  if (currentMapcheckBoundary && mapcheckCourses.length > 0) {
    boundaries[currentMapcheckBoundary] = { source: 'MAPCHK', courses: mapcheckCourses, metrics: currentMetrics };
  }

  return boundaries;
}

async function run() {
  console.log(`🚀 Starting Cogo Headless Batch Processor for: ${COGO_DIR}`);

  if (!fs.existsSync(COGO_DIR)) {
    console.error(`Error: Directory not found: ${COGO_DIR}`);
    process.exit(1);
  }

  const files = fs.readdirSync(COGO_DIR)
    .filter(f => f.toLowerCase().endsWith('.txt'))
    .sort();

  console.log(`📂 Found ${files.length} COGO files to process.\n`);

  const results = [];
  const stats = {
    totalFiles: files.length,
    totalBoundaries: 0,
    succeeded: 0,
    failed: 0,
    errors: 0,
    maxClosureError: 0,
    maxClosureErrorFile: ''
  };

  const pob = { northing: 5000, easting: 5000 };

  for (let i = 0; i < files.length; i++) {
    const fileName = files[i];
    const filePath = path.join(COGO_DIR, fileName);

    try {
      const fileBoundaries = parseCogoFile(filePath);
      const parsedBoundariesList = Object.entries(fileBoundaries);

      if (parsedBoundariesList.length === 0) {
        continue; // No boundaries found in this file
      }

      const fileResult = {
        fileName,
        boundaries: []
      };

      for (const [name, bnd] of parsedBoundariesList) {
        stats.totalBoundaries++;
        let computed = null;
        let errorMsg = null;
        let status = 'SUCCESS';

        try {
          computed = Scripting.traverse.compute({
            pointOfBeginning: pob,
            courses: bnd.courses,
            units: 'Feet',
            isOpenEnded: false
          });
        } catch (err) {
          status = 'ERROR';
          errorMsg = err.message;
          stats.errors++;
        }

        const calculatedMetrics = computed ? {
          perimeter: computed.perimeter,
          areaSqFt: computed.areaSqFt,
          areaAcres: computed.areaAcres,
          linearError: computed.closure?.linearError,
          precisionRatio: computed.closure?.precisionRatio
        } : null;

        let discrepancy = null;
        if (calculatedMetrics && bnd.metrics) {
          discrepancy = {
            perimeterDiff: Math.abs(calculatedMetrics.perimeter - (bnd.metrics.perimeter || 0)),
            areaDiff: Math.abs(calculatedMetrics.areaSqFt - (bnd.metrics.areaSqFt || 0)),
            linearErrorDiff: Math.abs(calculatedMetrics.linearError - (bnd.metrics.linearError || 0))
          };

          // If linear closure discrepancy is significant (> 0.05 ft), flag it
          if (discrepancy.linearErrorDiff > 0.05) {
            status = 'FAILED';
            stats.failed++;
          } else {
            stats.succeeded++;
          }

          if (calculatedMetrics.linearError > stats.maxClosureError) {
            stats.maxClosureError = calculatedMetrics.linearError;
            stats.maxClosureErrorFile = `${fileName} (${name})`;
          }
        } else if (status === 'SUCCESS') {
          stats.succeeded++;
        }

        fileResult.boundaries.push({
          name,
          source: bnd.source,
          courseCount: bnd.courses.length,
          status,
          error: errorMsg,
          reportedMetrics: bnd.metrics || null,
          calculatedMetrics,
          discrepancy
        });
      }

      results.push(fileResult);
    } catch (fileErr) {
      console.error(`Error processing file ${fileName}:`, fileErr);
      stats.errors++;
    }
  }

  // Write reports
  fs.writeFileSync(REPORT_FILE, JSON.stringify({ stats, results }, null, 2));

  // Generate Markdown Summary
  let md = `# Boundary.IQ — Headless COGO Batch Run Summary\n\n`;
  md += `**Timestamp**: ${new Date().toISOString()}\n`;
  md += `**Source Directory**: \`${COGO_DIR}\`\n\n`;
  md += `## Aggregate Stats\n\n`;
  md += `| Metric | Count / Value |\n`;
  md += `|--------|---------------|\n`;
  md += `| Total Files Scanned | ${stats.totalFiles} |\n`;
  md += `| Total Boundaries Evaluated | ${stats.totalBoundaries} |\n`;
  md += `| Successfully Computed | ${stats.succeeded} |\n`;
  md += `| Verification Discrepancies | ${stats.failed} |\n`;
  md += `| Computation Errors | ${stats.errors} |\n`;
  md += `| Maximum Loop Closure Error | ${stats.maxClosureError.toFixed(4)} ft (in ${stats.maxClosureErrorFile || 'N/A'}) |\n\n`;

  const failedList = [];
  const errorList = [];
  for (const r of results) {
    for (const b of r.boundaries) {
      if (b.status === 'FAILED') {
        failedList.push({ file: r.fileName, boundary: b.name, diff: b.discrepancy });
      }
      if (b.status === 'ERROR') {
        errorList.push({ file: r.fileName, boundary: b.name, error: b.error });
      }
    }
  }

  if (failedList.length > 0) {
    md += `## Verification Discrepancies\n\n`;
    md += `| File | Boundary | Perim Diff | Area Diff | Closure Diff |\n`;
    md += `|------|----------|------------|-----------|--------------|\n`;
    for (const f of failedList.slice(0, 50)) {
      md += `| ${f.file} | ${f.boundary} | ${f.diff.perimeterDiff.toFixed(3)} | ${f.diff.areaDiff.toFixed(2)} | ${f.diff.linearErrorDiff.toFixed(4)} |\n`;
    }
    md += `\n`;
  }

  if (errorList.length > 0) {
    md += `## Computation Errors\n\n`;
    for (const e of errorList.slice(0, 50)) {
      md += `- **${e.file}** (Boundary ${e.boundary}): \`${e.error}\`\n`;
    }
    md += `\n`;
  }

  fs.writeFileSync(SUMMARY_FILE, md);

  console.log(`\n=========================================`);
  console.log(`COGO BATCH SCAN COMPLETE`);
  console.log(`=========================================`);
  console.log(`Total Files Scanned:         ${stats.totalFiles}`);
  console.log(`Total Boundaries Evaluated:  ${stats.totalBoundaries}`);
  console.log(`Succeeded (Math Match):      ${stats.succeeded}`);
  console.log(`Failed (Discrepancies):      ${stats.failed}`);
  console.log(`Errors (Crash/Exception):     ${stats.errors}`);
  console.log(`Max Closure Error:           ${stats.maxClosureError.toFixed(4)} ft`);
  console.log(`=========================================`);
  console.log(`📄 Report written to:  ${REPORT_FILE}`);
  console.log(`📝 Summary written to: ${SUMMARY_FILE}`);
}

run().catch(console.error);
