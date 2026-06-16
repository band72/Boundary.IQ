import fs from 'fs/promises';
import pdfParse from 'pdf-parse';

async function main() {
  const filePath = process.argv[2] || '/home/artwalk/Downloads/training-20260530T124201Z-3-001/training/TrainPDF/Regency-Title/Regency-Commitment - Issued 3.27.25.pdf';
  try {
    const buffer = await fs.readFile(filePath);
    const data = await pdfParse(buffer);
    let text = data.text;
    
    // Clean ALTA headers/footers
    const boilerplateRegex = /ALTA\s+Commitment[\s\S]*?Page\s+\d+\s+of\s+31/gi;
    text = text.replace(boilerplateRegex, '');
    text = text.replace(/This page is only a part of[\s\S]*?electronic form\./gi, '');
    text = text.replace(/Copyright 2021 American Land Title Association[\s\S]*?prohibited\./gi, '');
    text = text.replace(/Reprinted under license from[\s\S]*?Association\./gi, '');
    text = text.replace(/\s+/g, ' ');

    // Find the Schedule A section
    const schedAStart = text.indexOf('SCHEDULE A');
    const schedBStart = text.indexOf('SCHEDULE B');
    
    console.log(`Schedule A index: ${schedAStart}, Schedule B index: ${schedBStart}`);
    
    const scheduleAContent = text.substring(schedAStart, schedBStart !== -1 ? schedBStart : text.length);
    
    // Find all PARCEL descriptions inside Schedule A
    const parcelRegex = /(PARCEL\s+['"“]?[A-Z\d\(\)\s]+['"”]?)/g;
    let match;
    const parcels = [];
    while ((match = parcelRegex.exec(scheduleAContent)) !== null) {
      parcels.push({ name: match[1], index: match.index });
    }
    
    for (let i = 0; i < parcels.length; i++) {
      const start = parcels[i].index;
      const end = (i + 1 < parcels.length) ? parcels[i+1].index : scheduleAContent.length;
      const desc = scheduleAContent.substring(start, end).trim();
      console.log(`\n=========================================`);
      console.log(`PARCEL: ${parcels[i].name} (Length: ${desc.length})`);
      console.log(`=========================================`);
      console.log(desc);
    }
  } catch (err) {
    console.error('Failed to parse PDF:', err);
  }
}

main();
