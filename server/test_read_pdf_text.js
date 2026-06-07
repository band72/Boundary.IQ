import pdfParse from 'pdf-parse';
import fs from 'fs/promises';

async function main() {
  const filePath = '/home/artwalk/Downloads/drive-download-20260602T132437Z-3-001/11627760 HL Commitment(1).pdf';
  try {
    const buffer = await fs.readFile(filePath);
    const data = await pdfParse(buffer);
    console.log("PDF Digital Text Length:", data.text.length);
    console.log("First 2000 chars:\n", data.text.slice(0, 2000));
    console.log("\n=========================================\n");
    console.log("Last 2000 chars:\n", data.text.slice(-2000));
  } catch (err) {
    console.error("Failed to read PDF:", err);
  }
}

main();
