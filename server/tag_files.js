#!/usr/bin/env node
/**
 * Boundary.IQ — File Tagging Utility for AI Readers
 * ────────────────────────────────────────────────
 * Tags and catalogs legal descriptions and documents for optimal ingestion
 * by LLM readers and agentic coders.
 *
 * Options:
 *   --dir <path>     Directory containing the documents to tag.
 *   --options <A,B,C> Comma-separated list of tagging modes to run:
 *                     A: Inject YAML frontmatter into extracted text files.
 *                     B: Generate llms.txt and llms-full.txt indices.
 *                     C: Rename and group files in a _tagged/ subdirectory.
 *   --dry-run        Preview all matches and metadata without writing/renaming.
 *
 * Usage:
 *   node tag_files.js --dir ~/Downloads/drive-download-20260602T132437Z-3-001
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';

// Colors for console logging
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const BLUE = '\x1b[34m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

function printUsage() {
  console.log(`
${BOLD}Usage:${RESET}
  node tag_files.js --dir <path> [options]

${BOLD}Options:${RESET}
  --dir <path>       ${CYAN}Required.${RESET} Path to the directory containing files to tag.
  --options <modes>  Comma-separated tagging modes. Defaults to ${BOLD}A,B,C${RESET}.
                       ${BOLD}A:${RESET} Inject YAML frontmatter into extracted .txt files.
                       ${BOLD}B:${RESET} Generate llms.txt & llms-full.txt in the directory.
                       ${BOLD}C:${RESET} Create renamed copies of files in a '_tagged' folder.
  --dry-run          Preview changes and telemetry without writing to disk.
  --help, -h         Show this help message.
`);
}

// Helper to compute file hash
function getFileHash(filePath) {
  try {
    const bytes = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(bytes).digest('hex');
  } catch (err) {
    console.error(`${RED}Error reading file for hash (${path.basename(filePath)}):${RESET}`, err.message);
    return null;
  }
}

// Helper to find DB matches
function findMatchingDeeds(db, fileName, fileHash) {
  const base = path.parse(fileName).name;
  
  // Clean duplicates like (1) or (2) from base name to match original records
  const cleanBase = base.replace(/\(\d+\)$/, '').trim();

  let rows = [];
  
  // 1. First, search by hash if available
  if (fileHash) {
    rows = db.prepare(
      `SELECT * FROM DeedLogs WHERE FileHash = ? ORDER BY Timestamp DESC`
    ).all(fileHash);
  }

  // 2. If no hash match, search by filename variations
  if (rows.length === 0) {
    rows = db.prepare(`
      SELECT * FROM DeedLogs 
      WHERE FileName = ? 
         OR FileName = ?
         OR FileName = ?
         OR FileName LIKE ?
         OR FileName LIKE ?
         OR FileName LIKE ?
      ORDER BY Timestamp DESC
    `).all(
      fileName,
      `${base}.pdf`,
      `${cleanBase}.pdf`,
      `${cleanBase}__%`,
      `${base}__%`,
      `%${cleanBase}%`
    );
  }

  // Dedup rows by FileName (keep most recent)
  const seen = new Set();
  const deduped = [];
  for (const r of rows) {
    if (!seen.has(r.FileName)) {
      seen.add(r.FileName);
      deduped.push(r);
    }
  }

  return deduped;
}

// Main execution function
async function main() {
  const args = process.argv.slice(2);
  let dirPath = '';
  let selectedOptions = 'A,B,C';
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dir') {
      dirPath = args[++i];
    } else if (args[i] === '--options') {
      selectedOptions = args[++i];
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      printUsage();
      process.exit(0);
    }
  }

  if (!dirPath) {
    console.error(`${RED}Error: --dir path is required.${RESET}`);
    printUsage();
    process.exit(1);
  }

  // Resolve directory path
  let resolvedDir = path.resolve(dirPath.replace(/^~/, os.homedir()));
  
  // Fallback to standard drive download path if local directory doesn't exist
  if (!fs.existsSync(resolvedDir)) {
    const candidate = path.join(os.homedir(), 'Downloads', path.basename(dirPath));
    if (fs.existsSync(candidate)) {
      resolvedDir = candidate;
    } else {
      console.error(`${RED}Error: Directory does not exist: ${resolvedDir}${RESET}`);
      process.exit(1);
    }
  }

  const options = new Set(selectedOptions.toUpperCase().split(','));
  console.log(`\n${BOLD}=== Boundary.IQ File Tagging Utility ===${RESET}`);
  console.log(`Target Dir:  ${BLUE}${resolvedDir}${RESET}`);
  console.log(`Modes:       ${CYAN}${Array.from(options).join(', ')}${RESET}`);
  console.log(`Dry Run:     ${dryRun ? `${YELLOW}ENABLED (no files will be written)${RESET}` : `${GREEN}DISABLED (writes will apply)${RESET}`}`);
  console.log(`========================================\n`);

  // Connect to SQLite Database
  const dbPath = process.env.DATABASE_PATH || path.join(os.homedir(), '.config', 'BoundaryQC', 'BoundaryQCDiagnostics.db');
  if (!fs.existsSync(dbPath)) {
    console.error(`${RED}Error: diagnostics database not found at ${dbPath}${RESET}`);
    process.exit(1);
  }
  const db = new Database(dbPath);
  console.log(`Connected to database: ${dbPath}\n`);

  // Scan directory
  const files = fs.readdirSync(resolvedDir).filter(f => {
    const ext = path.extname(f).toLowerCase();
    return ['.pdf', '.doc', '.docx', '.txt'].includes(ext);
  }).sort();

  console.log(`Found ${files.length} document files in target directory.`);

  let matchCount = 0;
  let missingCount = 0;
  const processedFilesMeta = [];

  for (const file of files) {
    const filePath = path.join(resolvedDir, file);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) continue;

    const fileHash = getFileHash(filePath);
    const matches = findMatchingDeeds(db, file, fileHash);

    if (matches.length > 0) {
      matchCount++;
      const isMultiParcel = matches.length > 1;

      // Extract main document metadata
      const primary = matches[0];
      let classification = 'DEED';
      let conceptualAnalysis = null;
      let courses = [];

      try {
        const ex = JSON.parse(primary.ExtractionJson || '{}');
        classification = ex.classification || ex.Classification || 'DEED';
        conceptualAnalysis = ex.conceptualAnalysis || null;
        courses = ex.courses || [];
      } catch {}

      const fileMeta = {
        fileName: file,
        filePath,
        fileHash,
        classification,
        isMultiParcel,
        parcelCount: matches.length,
        parcels: matches.map(m => {
          let mEx = {};
          let mTr = {};
          try { mEx = JSON.parse(m.ExtractionJson || '{}'); } catch {}
          try { mTr = JSON.parse(m.TraverseJson || '{}'); } catch {}
          return {
            parcelName: m.ParcelName || 'Main',
            status: m.Status,
            linearError: m.LinearError,
            precisionRatio: m.PrecisionRatio,
            repairStage: m.RepairStageUsed,
            coursesCount: mEx.courses?.length || 0,
            courses: mEx.courses || [],
            areaAcres: mTr.areaAcres || 0,
            perimeter: mTr.perimeter || 0
          };
        }),
        // Consolidated top-level status
        status: matches.some(m => m.Status === 'FAIL') ? 'FAIL' 
              : matches.some(m => m.Status === 'ERROR') ? 'ERROR'
              : matches.some(m => m.Status === 'MEANDER') ? 'MEANDER'
              : matches.some(m => m.Status === 'SKIPPED') ? 'SKIPPED'
              : 'PASS',
        conceptualAnalysis
      };

      processedFilesMeta.push(fileMeta);
      console.log(`  ${GREEN}✓${RESET} ${file}: ${BOLD}${fileMeta.status}${RESET} (${classification}, ${fileMeta.parcelCount} parcel(s))`);
    } else {
      missingCount++;
      // No DB match found, use defaults
      const fileMeta = {
        fileName: file,
        filePath,
        fileHash,
        classification: 'UNKNOWN',
        status: 'UNPROCESSED',
        isMultiParcel: false,
        parcelCount: 0,
        parcels: []
      };
      processedFilesMeta.push(fileMeta);
      console.log(`  ${YELLOW}?${RESET} ${file}: ${YELLOW}No Database Record${RESET}`);
    }
  }

  console.log(`\nMatch Summary: ${GREEN}${matchCount} matched${RESET}, ${YELLOW}${missingCount} unmatched${RESET}.\n`);

  // --- Option A: YAML Frontmatter Injection ---
  if (options.has('A')) {
    console.log(`${BOLD}--- Mode A: Injecting YAML Frontmatter ---${RESET}`);
    const extractedDir = path.join(resolvedDir, '_extracted');
    if (!fs.existsSync(extractedDir)) {
      console.log(`${YELLOW}Warning: _extracted folder not found in ${resolvedDir}. Skipping Mode A.${RESET}\n`);
    } else {
      let writtenCount = 0;
      for (const meta of processedFilesMeta) {
        if (meta.status === 'UNPROCESSED') continue;

        const base = path.parse(meta.fileName).name;
        const txtFilePath = path.join(extractedDir, `${base}.txt`);

        if (fs.existsSync(txtFilePath)) {
          // Construct YAML Frontmatter
          const yamlHeader = `---
status: ${meta.status}
classification: ${meta.classification}
file_hash: "${meta.fileHash || ''}"
is_multi_parcel: ${meta.isMultiParcel}
parcels:
${meta.parcels.map(p => `  - name: "${p.parcelName}"
    status: ${p.status}
    linear_error_ft: ${p.linearError}
    precision_ratio: "${p.precisionRatio >= 999999990 ? '1:Infinity' : `1:${Math.round(p.precisionRatio)}`}"
    repair_stage: "${p.repairStage || ''}"
    courses_count: ${p.coursesCount}
    area_acres: ${p.areaAcres.toFixed(4)}`).join('\n')}
---
`;
          if (dryRun) {
            console.log(`  [Dry-Run] Prepend frontmatter to ${txtFilePath}:`);
            console.log(yamlHeader.split('\n').map(l => `    | ${l}`).join('\n'));
          } else {
            const content = fs.readFileSync(txtFilePath, 'utf-8');
            // Make idempotent: strip existing frontmatter if present
            const yamlRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;
            let newContent;
            if (yamlRegex.test(content)) {
              newContent = content.replace(yamlRegex, yamlHeader);
            } else {
              newContent = yamlHeader + content;
            }
            fs.writeFileSync(txtFilePath, newContent, 'utf-8');
            writtenCount++;
          }
        }
      }
      console.log(`${GREEN}✓ Mode A complete: Injected frontmatter into ${writtenCount} extracted text files.${RESET}\n`);
    }
  }

  // --- Option B: Generate llms.txt & llms-full.txt ---
  if (options.has('B')) {
    console.log(`${BOLD}--- Mode B: Generating llms.txt & llms-full.txt ---${RESET}`);
    const llmsTxtPath = path.join(resolvedDir, 'llms.txt');
    const llmsFullTxtPath = path.join(resolvedDir, 'llms-full.txt');

    const folderName = path.basename(resolvedDir);
    
    // Group files by status for indexing
    const passed = processedFilesMeta.filter(m => m.status === 'PASS');
    const meanders = processedFilesMeta.filter(m => m.status === 'MEANDER');
    const skipped = processedFilesMeta.filter(m => m.status === 'SKIPPED');
    const failed = processedFilesMeta.filter(m => ['FAIL', 'ERROR'].includes(m.status));
    const unprocessed = processedFilesMeta.filter(m => m.status === 'UNPROCESSED');

    // Build llms.txt content
    let indexMd = `# ${folderName} - Boundary.IQ Deed Index

> This directory contains land deed documents, survey certifications, and title commitments cataloged and mathematically analyzed using the Boundary.IQ geometric processing engine.

## Summary Telemetry

- **Total Files**: ${processedFilesMeta.length}
- **Successfully Solved (PASS)**: ${passed.length}
- **Open-Ended / Easements (MEANDER)**: ${meanders.length}
- **Skipped (Non-boundary / Plats)**: ${skipped.length}
- **Failed / Unresolved**: ${failed.length}
- **Unprocessed (Stale)**: ${unprocessed.length}

`;

    if (passed.length > 0) {
      indexMd += `## Processed & Verified Deeds (PASS)

These documents contain complete metes-and-bounds boundaries that close within engineering tolerances.

`;
      for (const m of passed) {
        const p = m.parcels[0] || {};
        const precStr = p.precisionRatio >= 999999990 ? 'Infinity' : Math.round(p.precisionRatio).toLocaleString();
        indexMd += `- [${m.fileName}](_extracted/${path.parse(m.fileName).name}.txt):
  - **Type**: ${m.classification}
  - **Parcels**: ${m.parcelCount}
  - **Precision**: 1:${precStr}
  - **Error**: ${p.linearError.toFixed(4)} ft
  - **Area**: ${p.areaAcres.toFixed(4)} Acres
`;
      }
      indexMd += `\n`;
    }

    if (meanders.length > 0) {
      indexMd += `## Open-Ended Centerlines & Easements (MEANDER)

These files represent right-of-ways, road centerlines, or utility easements that do not form closed polygons.

`;
      for (const m of meanders) {
        const p = m.parcels[0] || {};
        indexMd += `- [${m.fileName}](_extracted/${path.parse(m.fileName).name}.txt):
  - **Type**: ${m.classification}
  - **Courses**: ${p.coursesCount}
  - **Total Distance**: ${p.perimeter.toFixed(2)} ft
`;
      }
      indexMd += `\n`;
    }

    if (skipped.length > 0) {
      indexMd += `## Skipped Documents (SKIPPED)

Non-traversable legal documents, cover pages, or lot-and-block subdivision references.

`;
      for (const m of skipped) {
        indexMd += `- [${m.fileName}](_extracted/${path.parse(m.fileName).name}.txt):
  - **Reason**: ${m.parcels[0]?.repairStage || 'Classified as non-boundary'}
`;
      }
      indexMd += `\n`;
    }

    if (failed.length > 0 || unprocessed.length > 0) {
      indexMd += `## Failed & Unprocessed Documents (Needs Review)

`;
      for (const m of [...failed, ...unprocessed]) {
        indexMd += `- [${m.fileName}](${fs.existsSync(path.join(resolvedDir, '_extracted', `${path.parse(m.fileName).name}.txt`)) ? `_extracted/${path.parse(m.fileName).name}.txt` : m.fileName}):
  - **Status**: ${m.status}
  - **Stage**: ${m.parcels[0]?.repairStage || 'No extraction records available'}
`;
      }
      indexMd += `\n`;
    }

    // Generate llms-full.txt content (consolidated corpus)
    let fullMd = `# ${folderName} - Full AI Context Corpus\n\n`;
    for (const m of processedFilesMeta) {
      const txtPath = path.join(resolvedDir, '_extracted', `${path.parse(m.fileName).name}.txt`);
      let rawText = '';
      if (fs.existsSync(txtPath)) {
        rawText = fs.readFileSync(txtPath, 'utf-8');
        // Remove frontmatter if present to avoid nested headers in corpus
        rawText = rawText.replace(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/, '');
      }

      fullMd += `## Document: ${m.fileName}
- **Status**: ${m.status}
- **Classification**: ${m.classification}
- **Hash**: ${m.fileHash || 'N/A'}
- **Parcels**:
${m.parcels.map(p => `  * ${p.parcelName}: Status=${p.status}, Error=${p.linearError.toFixed(4)} ft, Precision=1:${p.precisionRatio >= 999999990 ? 'Infinity' : Math.round(p.precisionRatio)}`).join('\n')}

### Extracted Boundaries (JSON)
\`\`\`json
${JSON.stringify(m.parcels.map(p => ({ parcel: p.parcelName, courses: p.courses })), null, 2)}
\`\`\`

### Raw Extracted Text
\`\`\`text
${rawText.trim() || '[No extracted text available]'}
\`\`\`

---

`;
    }

    if (dryRun) {
      console.log(`  [Dry-Run] Would write llms.txt (${indexMd.length} chars)`);
      console.log(`  [Dry-Run] Would write llms-full.txt (${fullMd.length} chars)`);
    } else {
      fs.writeFileSync(llmsTxtPath, indexMd, 'utf-8');
      fs.writeFileSync(llmsFullTxtPath, fullMd, 'utf-8');
      console.log(`  ${GREEN}✓${RESET} Wrote ${BLUE}llms.txt${RESET}`);
      console.log(`  ${GREEN}✓${RESET} Wrote ${BLUE}llms-full.txt${RESET}`);
    }
    console.log(`${GREEN}✓ Mode B complete.${RESET}\n`);
  }

  // --- Option C: Grouping into _tagged Subfolder ---
  if (options.has('C')) {
    console.log(`${BOLD}--- Mode C: Grouping and renaming files in _tagged/ ---${RESET}`);
    const taggedDir = path.join(resolvedDir, '_tagged');
    
    if (dryRun) {
      console.log(`  [Dry-Run] Would create directory: ${taggedDir}`);
    } else {
      if (!fs.existsSync(taggedDir)) {
        fs.mkdirSync(taggedDir, { recursive: true });
      }
    }

    let copyCount = 0;
    for (const meta of processedFilesMeta) {
      const cleanClass = meta.classification.replace(/_/g, ' ');
      const newName = `[${meta.status}] [${cleanClass}] ${meta.fileName}`;
      const destPath = path.join(taggedDir, newName);

      if (dryRun) {
        console.log(`  [Dry-Run] Would copy ${meta.fileName} -> _tagged/${newName}`);
      } else {
        try {
          fs.copyFileSync(meta.filePath, destPath);
          copyCount++;

          // Also copy the extracted text file if it exists
          const base = path.parse(meta.fileName).name;
          const txtSource = path.join(resolvedDir, '_extracted', `${base}.txt`);
          if (fs.existsSync(txtSource)) {
            const txtDest = path.join(taggedDir, `[${meta.status}] [${cleanClass}] ${base}.txt`);
            fs.copyFileSync(txtSource, txtDest);
          }
        } catch (err) {
          console.error(`  ${RED}✗${RESET} Failed to copy ${meta.fileName}:`, err.message);
        }
      }
    }
    console.log(`${GREEN}✓ Mode C complete: Copied ${copyCount} files into _tagged/ directory.${RESET}\n`);
  }

  console.log(`${BOLD}${GREEN}All requested tagging operations completed successfully!${RESET}\n`);
}

main().catch(err => {
  console.error(`${RED}Fatal script error:${RESET}`, err);
  process.exit(1);
});
