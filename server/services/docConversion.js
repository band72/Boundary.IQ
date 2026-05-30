// ─── Document Conversion Service ────────────────────────────────────────────
// Port of DocConversionService.cs — Word to PDF via LibreOffice headless.

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';

const execFileAsync = promisify(execFile);

const WORD_EXTS = new Set(['.doc', '.docx']);

export function isWordDocument(fileName) {
  return WORD_EXTS.has(path.extname(fileName).toLowerCase());
}

export function getMimeType(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  const map = {
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.pdf': 'application/pdf',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
  };
  return map[ext] || 'application/octet-stream';
}

/**
 * Convert a Word document buffer to PDF via LibreOffice headless.
 * @param {Buffer} docBytes
 * @param {string} fileName
 * @returns {Promise<Buffer>} PDF bytes
 */
export async function convertToPdf(docBytes, fileName) {
  const tempDir = path.join(os.tmpdir(), `biq_doc_${uuidv4().replace(/-/g, '')}`);
  await fs.mkdir(tempDir, { recursive: true });

  try {
    const inputPath = path.join(tempDir, fileName);
    await fs.writeFile(inputPath, docBytes);

    console.log(`Converting ${fileName} to PDF via LibreOffice...`);

    await execFileAsync('libreoffice', [
      `-env:UserInstallation=file://${path.join(tempDir, 'user').replace(/\\/g, '/')}`,
      '--headless', '--convert-to', 'pdf', '--outdir', tempDir, inputPath
    ], {
      timeout: 300000, // 5 min — LibreOffice can be slow on first launch
      env: {
        ...process.env,
        DISPLAY: '',          // prevent X11 connection attempt (causes hang)
        HOME: os.homedir(),   // ensure stable home dir
        TMPDIR: os.tmpdir(),  // explicit temp dir
      },
    });

    const baseName = path.basename(fileName, path.extname(fileName));
    const pdfPath = path.join(tempDir, baseName + '.pdf');

    try {
      await fs.access(pdfPath);
    } catch {
      throw new Error(`LibreOffice did not produce expected output: ${pdfPath}`);
    }

    const pdfBytes = await fs.readFile(pdfPath);
    console.log(`Converted ${fileName} → PDF (${(pdfBytes.length / 1024).toFixed(1)} KB)`);
    return pdfBytes;
  } finally {
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
