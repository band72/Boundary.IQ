import fs from 'fs/promises';
import pdfParse from 'pdf-parse';

async function main() {
  const filePath = process.argv[2] || '/home/artwalk/Downloads/training-20260530T124201Z-3-001/training/TrainPDF/Regency-Title/Regency-Committment 01062025-signed.pdf';
  try {
    const buffer = await fs.readFile(filePath);
    const data = await pdfParse(buffer);
    const text = data.text;
    console.log('Digital text length:', text ? text.length : 0);
    if (text && text.length > 50) {
      console.log('First 1000 chars of extracted text:');
      console.log(text.substring(0, 1000));
    } else {
      console.log('NO DIGITAL TEXT - it is a scanned PDF.');
    }
  } catch (err) {
    console.error('Failed to parse PDF:', err);
  }
}

main();
