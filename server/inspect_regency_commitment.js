import fs from 'fs/promises';
import pdfParse from 'pdf-parse';

async function main() {
  const filePath = process.argv[2] || '/home/artwalk/Downloads/drive-download-20260602T132437Z-3-001/Regency-Commitment - Issued 3.27.25.pdf';
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

    const schedAStart = text.indexOf('SCHEDULE A');
    const schedBStart = text.indexOf('SCHEDULE B');
    
    console.log(`Schedule A index: ${schedAStart}, Schedule B index: ${schedBStart}`);
    
    const scheduleAContent = text.substring(schedAStart, schedBStart !== -1 ? schedBStart : text.length);
    
    // Let's find all instances of PARCEL followed by quotes or letter/number
    const parcelRegex = /(PARCEL\s+['"“‘]?[A-Z\d\(\)\s-]+['"”’]?)/gi;
    let match;
    const parcels = [];
    while ((match = parcelRegex.exec(scheduleAContent)) !== null) {
      parcels.push({ name: match[1], index: match.index });
    }
    
    console.log(`Found ${parcels.length} parcel matches:`);
    parcels.forEach((p, idx) => {
      console.log(`${idx}: ${p.name.substring(0, 50)} at index ${p.index}`);
    });
  } catch (err) {
    console.error('Error:', err);
  }
}

main();
