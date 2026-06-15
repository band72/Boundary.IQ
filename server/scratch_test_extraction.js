import { fetch } from 'undici';

const rawText = `Lots 1 and 2, Block 1, SPRINGFIELD REALTY COMPANY'S SUBDIVISION of South part of Lot 3, Section 1, Township 2 South, Range 26 East, according to the plat thereof recorded in Plat Book 3, page 70 and Lots 9, 10 and 11, Block 17, LINDSLEY'S SUBDIVISION, according to the plat thereof recorded in Plat Book 2, page 98 and Lots 13, 14 and 15, DUNN'S SUBDIVISION, according to the plat thereof recorded in Plat Book 4, page 56, all plats recorded in the current public records of Duval County, Florida, and part of Government Lot 3, Section 1, Township 2 South, Range 26 East, of said county, Florida, more particularly described as follows: Begin at the intersection of the Northerly line of Southern Railroad (a 60.0 foot right of way, by Deed Book 11, page 101 and Deed Book page 2, formerly known as St: Johns River Terminal Company's Railroad) with the West line of Laura Street (a 66.0 foot right of way); thence the following two courses along said West line of Laura Street: (1) North 03° 48'52" West, 132.94 feet; to an angle point; (2) thence North 01°22'52" West, 120.00 feet to the North line of said Lot 15, DUNN'S SUBDIVISION; thence South 89° 21'48" West, 254.05 feet along the North line of said Lot 15 to the East line of a 10 foot wide alley; thence South 02°05'16" East, 10.0 feet along said East line of alley to the Northeast corner of said Lot 11, Block 17, LINDSLEY'S SUBDIVISION; thence South 89° 21'48" West, 156.75 feet along the North lines of said Lots 9, 10 and 11, Block 17, LINDSLEY'S SUBDIVISION, to the East line of Silver Street (a 66.0 foot right of way); thence South 02°05'16" East, 197.83 feet along said East line of Silver Street, to the North line of said Southern Railroad; thence the following two courses along said North line of said Railroad: (1) South 84°53'36" East, 308.19 feet to the point of curve, of a curve concave to the Southwest having a radius of 1810.00 feet; (2) thence around and along said curve, through a central angle of 03°26'34" to an arc distance of 108.76 feet, (chord bearing and distance of South 83°10'19" East, 10.74 feet) to the Point of Beginning:"`;

import { buildOllamaExtractionPrompt } from './services/geminiVision.js';

async function testModel(model) {
  console.log(`\n=========================================`);
  console.log(`TESTING MODEL: ${model}`);
  console.log(`=========================================`);
  
  const prompt = `${buildOllamaExtractionPrompt()}\n\n=========================================\nLEGAL DESCRIPTION TEXT TO PARSE:\n=========================================\n${rawText}`;
  
  try {
    const r = await fetch('http://127.0.0.1:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: { num_ctx: 4096 }
      })
    });
    
    if (!r.ok) {
      console.error(`HTTP error: ${r.status}`);
      return;
    }
    
    const data = await r.json();
    let response = data.response;
    
    // Strip think tags
    if (response.includes('<think>')) {
      response = response.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    }
    
    console.log("Response:");
    console.log(response);
  } catch (err) {
    console.error(`Error with ${model}:`, err.message);
  }
}

async function main() {
  await testModel('deepseek-r1:8b');
  await testModel('deepseek-r1:14b');
  await testModel('gemma4:26b');
}

main();
