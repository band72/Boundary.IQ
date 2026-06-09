import fs from 'fs';
import pdfParse from 'pdf-parse';

async function run() {
  const filePath = process.argv[2] || '/home/artwalk/Downloads/drive-download-20260602T132437Z-3-001/revised 24000500748 Commitment.pdf';
  console.log(`Reading PDF from: ${filePath}...`);
  try {
    const buffer = fs.readFileSync(filePath);
    const data = await pdfParse(buffer);
    console.log(`PDF parse succeeded! Characters: ${data.text.length}`);
    fs.writeFileSync(process.argv[3] || './24000500748_text.txt', data.text);
    console.log(`Dumped text to: ${process.argv[3] || './24000500748_text.txt'}`);
  } catch (err) {
    console.error("PDF parse failed:", err.message);
  }
}

run();
