import path from 'path';

const REMOTE_URL = process.env.REMOTE_URL || 'https://boundary-iq-318563891368.us-central1.run.app';
const BASE_URL = `${REMOTE_URL}/api`;

async function test() {
  console.log(`--- Testing Remote Site: ${REMOTE_URL} ---`);
  
  const username = `remote_tester_${Math.random().toString(36).substring(7)}`;
  const password = 'Password123!';

  console.log(`Registering user ${username}...`);
  const regRes = await fetch(`${BASE_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });

  if (!regRes.ok) {
    console.error(`✗ Registration failed: ${regRes.status} ${await regRes.text()}`);
    process.exit(1);
  }

  const regData = await regRes.json();
  const userId = regData.id;
  const token = regData.token;

  console.log(`Successfully registered: User ID = ${userId}, token = ${token?.substring(0, 15)}...`);

  if (typeof userId !== 'number') {
    console.error('✗ FAILURE: User ID was not returned as a number in the registration response!');
    process.exit(1);
  }

  // Get current active model settings
  const configRes1 = await fetch(`${BASE_URL}/settings/model`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const configData1 = await configRes1.json();
  console.log(`Initial Active Provider: ${configData1.activeProvider}`);

  // Update user-specific settings
  console.log('Updating settings for this user...');
  const updateRes = await fetch(`${BASE_URL}/settings/model`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      provider: configData1.activeProvider || 'ollama',
      model: configData1.activeModel || 'deepseek-r1:8b',
      allowApiFallback: false,
      enforceNoSelfIntersection: true
    })
  });

  console.log(`POST /settings/model status: ${updateRes.status}`);
  console.log(`POST /settings/model response: ${await updateRes.text()}`);

  // Fetch settings again to confirm update for this user
  const configRes2 = await fetch(`${BASE_URL}/settings/model`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const configData2 = await configRes2.json();
  console.log(`New Active Provider: ${configData2.activeProvider}`);
  console.log(`New Active Model: ${configData2.activeModel}`);
  console.log(`New AllowApiFallback: ${configData2.allowApiFallback}`);
  console.log(`New EnforceNoSelfIntersection: ${configData2.enforceNoSelfIntersection}`);

  if (configData2.allowApiFallback !== false || configData2.enforceNoSelfIntersection !== true) {
    console.error('✗ FAILURE: User local settings did not update correctly!');
    process.exit(1);
  }

  // Perform upload
  console.log('Sending file upload request to remote server...');
  const formData = new FormData();
  const fileContent = 'N 00 00 00 E 100';
  const fileBlob = new Blob([fileContent], { type: 'text/plain' });
  formData.append('images', fileBlob, 'temp_deed_test_remote.txt');

  const uploadRes = await fetch(`${BASE_URL}/batchdeed/process`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`
    },
    body: formData
  });

  console.log(`Upload response status: ${uploadRes.status}`);
  const uploadBody = await uploadRes.text();
  
  if (!uploadRes.ok) {
    console.error(`✗ FAILURE: Upload failed with status ${uploadRes.status}`);
    console.error(`Response body: ${uploadBody}`);
    process.exit(1);
  }

  console.log('✓ SUCCESS: File uploaded and accepted successfully!');
  
  // Try parsing response JSON to verify the structure
  try {
    const parsed = JSON.parse(uploadBody);
    console.log('Parsed Upload Response Summary:');
    console.log(`  - Total Processed: ${parsed.totalProcessed}`);
    console.log(`  - Succeeded: ${parsed.succeeded}`);
    console.log(`  - Failed: ${parsed.failed}`);
    if (parsed.results && parsed.results.length > 0) {
      console.log(`  - First File Name: ${parsed.results[0].fileName}`);
      console.log(`  - First File Status: ${parsed.results[0].status}`);
    }
    console.log('✓ SUCCESS: Response body is valid JSON with expected properties.');
  } catch (err) {
    console.error('✗ FAILURE: Upload response body was not valid JSON or properties were missing:', err.message);
    console.error('Raw body:', uploadBody);
    process.exit(1);
  }

  console.log('--- All Remote Tests Passed Successfully! ---');
}

test();
