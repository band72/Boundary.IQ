const token = '8229c1aa2bf8387c3585c77e1c3251d18d83289df4d63a88bc2db432200d79dc';
const params = new URLSearchParams({
  path: '/home/artwalk/Pictures/Screenshots',
  file: 'Screenshot from 2026-06-18 19-33-39.png',
  pobN: '5000',
  pobE: '5000',
  units: 'Feet',
  force: 'true'
});

async function main() {
  console.log('Sending request to API...');
  try {
    const res = await fetch('http://localhost:5050/api/folderscan/process-file?' + params, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token
      }
    });

    console.log('Status:', res.status);
    const text = await res.text();
    console.log('Response text length:', text.length);
    console.log('Response raw text:', JSON.stringify(text));
  } catch (err) {
    console.error('Fetch error:', err);
  }
}

main();
