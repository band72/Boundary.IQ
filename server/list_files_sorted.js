import fs from 'fs';
import path from 'path';

const SUPPORTED_EXTS = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.webp', '.gif', '.doc', '.docx', '.txt']);

function getSupportedFiles(dirPath) {
  return fs.readdirSync(dirPath)
    .filter(f => SUPPORTED_EXTS.has(path.extname(f).toLowerCase()))
    .sort()
    .map(f => path.join(dirPath, f));
}

const dir = "/home/artwalk/Downloads/drive-download-20260602T132437Z-3-001/_extracted";
const files = getSupportedFiles(dir);
console.log(`Found ${files.length} supported files:`);
files.forEach((f, idx) => {
  console.log(`${idx}: ${path.basename(f)}`);
});
