import pdfParse from 'pdf-parse';
import fs from 'fs/promises';

async function main() {
  const filePath = process.argv[2] || '/home/artwalk/Downloads/drive-download-20260602T132437Z-3-001/Title (Gator-Nole-Sandbagger-Stewart).pdf';
  try {
    const buffer = await fs.readFile(filePath);
    const data = await pdfParse(buffer);
    console.log("PDF Digital Text Length:", data.text.length);
    console.log("Full text:\n", data.text);
  } catch (err) {
    console.error("Failed to read PDF:", err);
  }
}

main();
