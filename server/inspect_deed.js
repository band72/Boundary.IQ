import fs from 'fs';
import pdfParse from 'pdf-parse';

async function run() {
  const filePath = '/home/artwalk/Downloads/drive-download-20260602T132437Z-3-001/revised 24000500748 Commitment.pdf';
  console.log(`Reading PDF from: ${filePath}...`);
  try {
    const buffer = fs.readFileSync(filePath);
    const data = await pdfParse(buffer);
    console.log(`PDF parse succeeded! Characters: ${data.text.length}`);
    fs.writeFileSync('/home/artwalk/.gemini/antigravity-ide/brain/03ace395-7d9d-43bc-a328-273543ada6f5/scratch/24000500748_text.txt', data.text);
    console.log(`Dumped text to: /home/artwalk/.gemini/antigravity-ide/brain/03ace395-7d9d-43bc-a328-273543ada6f5/scratch/24000500748_text.txt`);
  } catch (err) {
    console.error("PDF parse failed:", err.message);
  }
}

run();
