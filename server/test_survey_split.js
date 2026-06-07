import fs from 'fs/promises';

// Mock hasBoundaryKeywords just for the test or define it
function hasBoundaryKeywords(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  const hasDegrees = lower.includes('°') || lower.includes('*') || lower.includes('deg') || lower.includes('degree');
  const hasThence = lower.includes('thence');
  const hasPob = lower.includes('point of beginning') || lower.includes('p.o.b.') || lower.includes('pob') || lower.includes('commence');
  const hasFeet = lower.includes('feet') || lower.includes('foot') || lower.includes(' ft') || lower.includes('chs') || lower.includes('chains');
  const hasChords = lower.includes('chord') || lower.includes('curve') || lower.includes('radius');
  
  return (hasThence && (hasFeet || hasDegrees)) || hasPob || (hasChords && hasFeet);
}

function extractNamedParcels(docText) {
  if (!docText || docText.length < 20) return null;

  const dividers = [];

  // 1. Explicit headers (e.g., "Parcel A", "PARCEL 1", "Tract B", "LOT 2", etc.)
  const explicitRe = /(?:^|\n)[ \t]*(?:Parcel|PARCEL|DEED CASE|DEED|CASE|Tract|TRACT|Lot|LOT)[ \t]+['"“‘'`]*([A-Z0-9]+)['"”’'`]*\b/gi;
  let m;
  while ((m = explicitRe.exec(docText)) !== null) {
    const nextNewline = docText.indexOf('\n', m.index + 1);
    const endOfLine = nextNewline !== -1 ? nextNewline : docText.length;
    const lineText = docText.slice(m.index, endOfLine).toLowerCase();
    
    // Ignore references disguised as headers
    const isReference = ['herein', 'described', 'referred', 'overlap', 'contiguity', 'as to'].some(k => lineText.includes(k));
    if (!isReference) {
      dividers.push({
        type: 'explicit',
        label: m[1].toUpperCase(),
        index: m.index,
        length: m[0].length
      });
    }
  }

  // 2. Keyword dividers (e.g., "Together with", "Less and except", etc.)
  const keywordRe = /(?:^|\n)[ \t]*(?:together\s+with|also\s+together\s+with|and\s+together\s+with|less\s+and\s+except|less\s+and\s+excepting|excepting\s+therefrom|also\s+together\s+with\s+an\s+easement|together\s+with\s+an\s+easement)\b/gi;
  while ((m = keywordRe.exec(docText)) !== null) {
    const nextNewline = docText.indexOf('\n', m.index + 1);
    const endOfLine = nextNewline !== -1 ? nextNewline : docText.length;
    const lineText = docText.slice(m.index, endOfLine).toLowerCase();

    let labelType = 'Easement';
    if (lineText.includes('except') || lineText.includes('therefrom')) {
      labelType = 'Exception';
    }

    dividers.push({
      type: 'keyword',
      labelType,
      index: m.index,
      length: m[0].length
    });
  }

  // Sort dividers by index
  dividers.sort((a, b) => a.index - b.index);

  // De-duplicate overlapping dividers
  const uniqueDividers = [];
  for (const div of dividers) {
    if (uniqueDividers.length === 0 || div.index > uniqueDividers[uniqueDividers.length - 1].index + 10) {
      uniqueDividers.push(div);
    }
  }

  if (uniqueDividers.length === 0) return null;

  // Let's build the splits
  const splits = [];
  let easementCount = 0;
  let exceptionCount = 0;

  // Check if we need to insert an implicit first parcel
  const firstDiv = uniqueDividers[0];
  if (firstDiv.index > 100) {
    const preText = docText.slice(0, firstDiv.index);
    if (hasBoundaryKeywords(preText)) {
      // Determine label for implicit parcel
      let firstLabel = '1';
      if (firstDiv.type === 'explicit') {
        if (firstDiv.label === 'B') firstLabel = 'A';
        else if (firstDiv.label === '2') firstLabel = '1';
        else firstLabel = '1';
      } else {
        firstLabel = '1';
      }
      splits.push({ label: firstLabel, start: 0, end: firstDiv.index });
    }
  }

  // Add the explicit/keyword splits
  for (let i = 0; i < uniqueDividers.length; i++) {
    const div = uniqueDividers[i];
    const start = div.index;
    const end = i + 1 < uniqueDividers.length ? uniqueDividers[i + 1].index : docText.length;

    let label = '';
    if (div.type === 'explicit') {
      label = div.label;
    } else {
      if (div.labelType === 'Easement') {
        easementCount++;
        label = `Easement_${easementCount}`;
      } else {
        exceptionCount++;
        label = `Exception_${exceptionCount}`;
      }
    }

    splits.push({ label, start, end });
  }

  // Map to final parcel array
  const parcels = [];
  for (const split of splits) {
    const text = docText.slice(split.start, split.end).trim();
    if (text.length > 20) {
      parcels.push({ label: split.label, text });
    }
  }

  return parcels.length >= 2 ? parcels : null;
}

async function main() {
  console.log("=== Testing survey and legal description(1) ===");
  const file1Json = JSON.parse(await fs.readFile('/home/artwalk/.config/BoundaryQC/OcrCache/f4fe7c1140cf1c63dcb9ebe05a175975d1fe3dc5cc7b444d9260f824fce532fb.json', 'utf8'));
  const parcels1 = extractNamedParcels(file1Json.combinedOcrText);
  console.log("Parcels found:", parcels1 ? parcels1.map(p => ({ label: p.label, length: p.text.length })) : null);
  if (parcels1) {
    parcels1.forEach(p => {
      console.log(`--- PARCEL ${p.label} ---`);
      console.log(p.text.slice(0, 300) + '...\n');
    });
  }

  console.log("\n=== Testing Title (Gator-Nole-Sandbagger-Stewart) ===");
  const file2Json = JSON.parse(await fs.readFile('/home/artwalk/.config/BoundaryQC/OcrCache/05d476ed7d50d23449480bbe7860b2227f66ef5efad79e53037d2aaf3de42abf.json', 'utf8'));
  const parcels2 = extractNamedParcels(file2Json.combinedOcrText);
  console.log("Parcels found:", parcels2 ? parcels2.map(p => ({ label: p.label, length: p.text.length })) : null);
  if (parcels2) {
    parcels2.forEach(p => {
      console.log(`--- PARCEL ${p.label} ---`);
      console.log(p.text.slice(0, 300) + '...\n');
    });
  }
}

main();
