// server/tests/runDeedWriterBatch.js
import fs from 'fs';
import path from 'path';
import * as solver from '../services/Scripting/deedTextSolver.js';
import * as writer from '../services/Scripting/legalWriter.js';

const trainingDir = '/home/artwalk/Downloads/training-20260530T124201Z-3-001/_extracted';
const artifactsDir = '/home/artwalk/.gemini/antigravity-ide/brain/c65ca6d3-6647-4b52-88de-f3237ba8f927';

async function run() {
  console.log(`Starting deed writer batch validation on: ${trainingDir}\n`);

  if (!fs.existsSync(trainingDir)) {
    console.error(`Error: Training directory not found: ${trainingDir}`);
    process.exit(1);
  }

  const files = fs.readdirSync(trainingDir).filter(f => {
    if (!f.endsWith('.txt')) return false;
    const stats = fs.statSync(path.join(trainingDir, f));
    return stats.size < 10000; // Skip files >= 10 KB to prevent regex backtracking on huge documents
  });
  console.log(`Found ${files.length} deed text files (< 10 KB) to process.`);

  const results = [];
  let totalSuccessfulSolves = 0;
  let totalFailedSolves = 0;

  for (const file of files) {
    const filePath = path.join(trainingDir, file);
    const content = fs.readFileSync(filePath, 'utf8');
    console.log(`Processing file: ${file} (${content.length} chars)`);

    let solveResult;
    try {
      solveResult = solver.solveFromText(content, {
        pobNorthing: 5000,
        pobEasting: 5000,
        units: 'feet',
      });
    } catch (err) {
      results.push({
        file,
        status: 'FAILED_SOLVE',
        error: err.message,
        coursesCount: 0,
      });
      totalFailedSolves++;
      continue;
    }

    const courses = solveResult.repairedCourses || [];
    if (!courses || courses.length === 0) {
      results.push({
        file,
        status: 'NO_COURSES_EXTRACTED',
        error: 'Regex engine extracted 0 courses',
        coursesCount: 0,
      });
      totalFailedSolves++;
      continue;
    }

    totalSuccessfulSolves++;

    // Test writing under different precisions
    const precisions = [0, 1, 2];
    const precisionChecks = {};

    for (const p of precisions) {
      try {
        const legalText = writer.write({
          courses: courses.map(c => ({
            type: (c.type === 'Meandering Line' || c.type === 'meandering line') ? 'Squiggle' : (c.type || 'Line'),
            bearing: c.bearing || null,
            distance: c.distance != null ? parseFloat(c.distance) : null,
            chordBearing: c.chordBearing || null,
            chordDistance: c.chordDistance != null ? parseFloat(c.chordDistance) : null,
            arcLength: c.arcLength != null ? parseFloat(c.arcLength) : null,
            delta: c.delta != null ? parseFloat(c.delta) : null,
            radius: c.radius != null ? parseFloat(c.radius) : null,
            curveDirection: c.curveDirection || null,
            description: c.description || null,
          })),
          pobNorthing: 5000,
          pobEasting: 5000,
          bearingSecondsDecimals: p,
          units: 'feet',
        });

        // Verify precision format
        // We match processed bearings, e.g., N45°30'05"E or S10°20'30.5"W
        // Regex looks for degrees, minutes, seconds and checking decimals inside seconds
        const bearingRegex = /[NS]\s*\d+\u00B0\s*\d+\s*'\s*(\d+(?:\.\d+)?)\s*"\s*[EW]/gi;
        let matches = [...legalText.matchAll(bearingRegex)];

        let checkPassed = true;
        let details = '';

        if (matches.length > 0) {
          for (const match of matches) {
            const secondVal = match[1]; // e.g. "05" or "05.7" or "05.72"
            const decIdx = secondVal.indexOf('.');
            if (p === 0 && decIdx !== -1) {
              checkPassed = false;
              details = `Expected whole seconds, found decimals: ${secondVal} in match "${match[0]}"`;
              break;
            } else if (p > 0) {
              if (decIdx === -1) {
                checkPassed = false;
                details = `Expected ${p} decimal place(s), found whole seconds: ${secondVal} in match "${match[0]}"`;
                break;
              }
              const decimalPart = secondVal.substring(decIdx + 1);
              if (decimalPart.length !== p) {
                checkPassed = false;
                details = `Expected exactly ${p} decimal place(s), found: ${secondVal} in match "${match[0]}"`;
                break;
              }
            }
          }
        }

        precisionChecks[p] = {
          success: checkPassed,
          error: details || null,
        };
      } catch (err) {
        precisionChecks[p] = {
          success: false,
          error: `Writer crashed: ${err.message}`,
        };
      }
    }

    results.push({
      file,
      status: 'SUCCESS',
      coursesCount: courses.length,
      precisionChecks,
    });
  }

  // Generate Markdown report
  let report = `# Deed Writer Batch Validation Report\n\n`;
  report += `This report lists the results of running the Deed Writer parser and generator pipeline across all extracted deed files.\n\n`;
  report += `* **Dataset**: \`${trainingDir}\`\n`;
  report += `* **Total Files**: ${files.length}\n`;
  report += `* **Successfully Parsed & Written**: ${totalSuccessfulSolves}\n`;
  report += `* **Failed/Empty**: ${totalFailedSolves}\n\n`;

  report += `## Detailed Results\n\n`;
  report += `| File Name | Status | Courses | Precision 0 (Whole) | Precision 1 (1 Dec) | Precision 2 (2 Dec) | Details / Warnings |\n`;
  report += `| --- | --- | --- | --- | --- | --- | --- |\n`;

  for (const r of results) {
    if (r.status !== 'SUCCESS') {
      report += `| \`${r.file}\` | ❌ **${r.status}** | 0 | - | - | - | ${r.error || ''} |\n`;
    } else {
      const p0 = r.precisionChecks[0].success ? '✅ Pass' : '❌ Fail';
      const p1 = r.precisionChecks[1].success ? '✅ Pass' : '❌ Fail';
      const p2 = r.precisionChecks[2].success ? '✅ Pass' : '❌ Fail';
      const errors = [
        r.precisionChecks[0].error,
        r.precisionChecks[1].error,
        r.precisionChecks[2].error
      ].filter(Boolean).join('; ');

      report += `| \`${r.file}\` | ✅ SUCCESS | ${r.coursesCount} | ${p0} | ${p1} | ${p2} | ${errors} |\n`;
    }
  }

  const reportPath = path.join(artifactsDir, 'deed_writer_test_results.md');
  fs.writeFileSync(reportPath, report, 'utf8');
  console.log(`\nReport written to: ${reportPath}`);
}

run().catch(console.error);
