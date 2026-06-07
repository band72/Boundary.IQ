import pdfParse from 'pdf-parse';
import fs from 'fs/promises';

async function main() {
  const filePath = '/home/artwalk/Downloads/drive-download-20260602T132437Z-3-001/Commitment Form 4690FL Agency.pdf';
  try {
    const buffer = await fs.readFile(filePath);
    const data = await pdfParse(buffer);
    console.log("PDF Digital Text Length:", data.text.length);
    await fs.writeFile('/home/artwalk/.gemini/antigravity-ide/brain/03ace395-7d9d-43bc-a328-273543ada6f5/scratch/74_text.txt', data.text, 'utf-8');
    console.log("Dumped PDF text to scratch/74_text.txt");
  } catch (err) {
    console.error("Failed to read PDF:", err);
  }
}

main();
