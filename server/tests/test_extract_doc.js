import fs from 'fs/promises';
import { convertToPdf } from '../services/docConversion.js';
import * as gemini from '../services/geminiVision.js';

async function run() {
  try {
    const filePath = process.argv[2] || '/home/friend/Downloads/Legal Descriptions/#33278.doc';
    console.log('Reading file...');
    const bytes = await fs.readFile(filePath);
    console.log('Converting to PDF...');
    const pdfBytes = await convertToPdf(bytes, '#33278.doc');
    console.log('PDF conversion successful. Size:', pdfBytes.length);
  } catch (err) {
    console.error('Error occurred:', err);
  }
}

run();
