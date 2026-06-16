import { fetch } from 'undici';

async function main() {
  const payload = {
    model: 'deepseek-r1:8b',
    prompt: 'Return a JSON object with key "name" set to "Antigravity".',
    stream: false,
    format: 'json',
    options: { temperature: 0.1 }
  };

  try {
    console.log("Sending request to Ollama...");
    const res = await fetch('http://127.0.0.1:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    if (!res.ok) {
      console.error("HTTP error:", res.status, await res.text());
      return;
    }
    
    const data = await res.json();
    console.log("Response text:\n", data.response);
  } catch (err) {
    console.error("Error:", err);
  }
}

main();
