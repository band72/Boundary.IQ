import 'dotenv/config';
import fs from 'fs/promises';
import { fetch } from 'undici';

const filePath = '/home/artwalk/Downloads/drive-download-20260602T132437Z-3-001/Regency-Commitment - Issued 3.27.25.pdf';
const apiKey = process.env.GEMINI_API_KEY;
const model = 'gemini-3.5-flash';
const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

async function run() {
  try {
    const buffer = await fs.readFile(filePath);
    const b64 = buffer.toString('base64');
    
    console.log('Sending PDF to Gemini for transcription...');
    
    const prompt = `You are a professional land surveyor. The attached PDF is a Title Commitment containing multiple parcel descriptions (e.g. PARCEL A, PARCEL B, etc.) under Schedule A.
Extract and transcribe the legal descriptions of all the parcels exactly as written in the document.
Ensure that each parcel is clearly separated and starts with a line containing ONLY its name (e.g. "PARCEL A", "PARCEL B", etc.) so it can be split. For example:
PARCEL A
[Transcribed legal description of PARCEL A]

PARCEL B
[Transcribed legal description of PARCEL B]

Do not include unrelated title commitment boilerplate text. Only output the transcribed parcel descriptions.`;

    const payload = {
      contents: [{
        parts: [
          { text: prompt },
          { inlineData: { mimeType: 'application/pdf', data: b64 } }
        ],
      }],
      generationConfig: {
        temperature: 0.1
      }
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    
    const text = await res.text();
    console.log('Status:', res.status);
    
    const json = JSON.parse(text);
    const transcribed = json?.candidates?.[0]?.content?.parts?.[0]?.text;
    console.log('--- TRANSCRIBED CONTENT ---');
    console.log(transcribed ? transcribed.substring(0, 1500) + '...' : json);
    
    if (transcribed) {
      await fs.writeFile('/home/artwalk/boundary.iq/server/transcribed_commitment.txt', transcribed, 'utf-8');
      console.log('Wrote transcription to transcribed_commitment.txt');
    }
  } catch (err) {
    console.error('Error:', err);
  }
}

run();
