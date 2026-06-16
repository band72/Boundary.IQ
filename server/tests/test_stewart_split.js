import { extractNamedParcels } from './services/repair.js';
// Usage: node test_stewart_split.js [ocrCacheJsonPath]
import fs from 'fs/promises';

async function main() {
  const ocrJson = await fs.readFile((process.env.OCR_CACHE_DIR ? process.env.OCR_CACHE_DIR + '/'/home/artwalk/.config/BoundaryQC/OcrCache/05d476ed7d50d23449480bbe7860b2227f66ef5efad79e53037d2aaf3de42abf.json''.split('/').pop() : '/home/artwalk/.config/BoundaryQC/OcrCache/05d476ed7d50d23449480bbe7860b2227f66ef5efad79e53037d2aaf3de42abf.json'), 'utf8');
  const data = JSON.parse(ocrJson);
  const text = data.combinedOcrText;
  
  console.log("=== Splitting Test ===");
  const parsed = extractNamedParcels(text);
  console.log("Result:", parsed);
}

main();
