import { fetch } from 'undici';

async function main() {
  const payload = {
    model: 'gemma4:26b',
    messages: [
      { role: 'user', content: 'Say hello in 5 words.' }
    ],
    stream: false,
    options: { num_ctx: 2048, num_predict: 100 }
  };
  
  try {
    const res = await fetch('http://127.0.0.1:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    console.log('Status:', res.status);
    const data = await res.json();
    console.log('Response JSON:', JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error:', err.message);
  }
}

main();

