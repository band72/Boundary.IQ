import pdfParse from 'pdf-parse';
import fs from 'fs/promises';

async function main() {
  const filePath = '/home/artwalk/Downloads/windsor commons/PDF.js viewer.pdf';
  try {
    const buffer = await fs.readFile(filePath);
    const data = await pdfParse(buffer);
    console.log("PDF Digital Text Length:", data.text.length);
    console.log("First 3000 chars:\n", data.text.slice(0, 3000));
  } catch (err) {
    console.error("Failed to read PDF:", err);
  }
}

main();
