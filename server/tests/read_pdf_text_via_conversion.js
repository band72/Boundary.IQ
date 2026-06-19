import fs from 'fs';
import path from 'path';
import { convertToPdf } from '../services/docConversion.js';
import { extractTextFromPdf } from '../services/llm/pdfProcessor.js';

const docPath = '/home/artwalk/Downloads/training-20260530T124201Z-3-001/training/Legal Descriptions/12487-1.doc';

async function main() {
  const bytes = fs.readFileSync(docPath);
  console.log('Original doc size:', bytes.length);
  const pdfBytes = await convertToPdf(bytes, '12487-1.doc');
  console.log('PDF size:', pdfBytes.length);
  const text = await extractTextFromPdf(pdfBytes);
  console.log('Extracted Text Length:', text.length);
  console.log('=== EXTRACTED TEXT ===');
  console.log(text);
  console.log('=== END TEXT ===');
}

main();
