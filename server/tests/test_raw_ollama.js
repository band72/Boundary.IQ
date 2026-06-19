import fs from 'fs';
import path from 'path';
import { convertToPdf } from '../services/docConversion.js';
import { extractTextFromPdf } from '../services/llm/pdfProcessor.js';
import { extractRaw } from '../services/llm/dispatcher.js';
import { init } from '../services/geminiVision.js';
import { buildOllamaExtractionPrompt } from '../services/geminiVision.js';

const docPath = '/home/artwalk/Downloads/training-20260530T124201Z-3-001/training/Legal Descriptions/12487-1.doc';

async function main() {
  const bytes = fs.readFileSync(docPath);
  console.log('Converting doc to PDF...');
  const pdfBytes = await convertToPdf(bytes, '12487-1.doc');
  const text = await extractTextFromPdf(pdfBytes);
  console.log('Extracted text length:', text.length);

  const prompt = buildOllamaExtractionPrompt();
  const activePrompt = `${prompt}\n\n=========================================\nLEGAL DESCRIPTION TEXT TO PARSE:\n=========================================\n${text}`;

  console.log('Calling Ollama extractRaw...');
  const rawText = await extractRaw(Buffer.from(text, 'utf-8'), 'text/plain', prompt);
  console.log('=== RAW OLLAMA RESPONSE ===');
  console.log(rawText);
  console.log('=== END RAW RESPONSE ===');
}

main();
