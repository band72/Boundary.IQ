import { init, getDeedDetail } from './services/diagnosticsDb.js';

init();

const files = ['#33278.doc', '10030CERT.doc'];
for (const file of files) {
  console.log(`=== Detail for ${file} ===`);
  const detail = getDeedDetail(file);
  if (detail) {
    console.log(JSON.stringify(detail, null, 2));
  } else {
    console.log('No detail found.');
  }
}
