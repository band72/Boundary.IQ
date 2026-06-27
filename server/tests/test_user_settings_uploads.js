import fs from 'fs';
import path from 'path';

const PORT = process.env.PORT || 5050;
const BASE_URL = `http://localhost:${PORT}/api`;

async function test() {
  console.log('--- Testing Per-User Settings and Upload Subfolder ---');
  
  const username = `user_tester_${Math.random().toString(36).substring(7)}`;
  const password = 'password123';

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
  console.log('Updating settings for this user to openai/llama3...');
  const updateRes = await fetch(`${BASE_URL}/settings/model`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      provider: 'openai',
      model: 'llama3',
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

  if (configData2.activeProvider !== 'openai' || configData2.activeModel !== 'llama3') {
    console.error('✗ FAILURE: User local settings did not update correctly!');
    process.exit(1);
  }

  // Perform upload
  console.log('Sending file upload request...');
  const formData = new FormData();
  const fileContent = 'N 00 00 00 E 100';
  const fileBlob = new Blob([fileContent], { type: 'text/plain' });
  formData.append('images', fileBlob, 'temp_deed_test_user.txt');

  const uploadRes = await fetch(`${BASE_URL}/batchdeed/process`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`
    },
    body: formData
  });

  console.log(`Upload response status: ${uploadRes.status}`);
  const uploadBody = await uploadRes.text();
  console.log(`Upload response body: ${uploadBody.substring(0, 1000)}...`);

  if (!uploadRes.ok) {
    console.error(`✗ FAILURE: Upload failed with status ${uploadRes.status}`);
    process.exit(1);
  }

  // Check if uploads folder was created for this user ID padded to 6 digits
  const paddedUserId = String(userId).padStart(6, '0');
  const uploadsBase = process.cwd().endsWith('server')
    ? path.join(process.cwd(), 'uploads')
    : path.join(process.cwd(), 'server', 'uploads');
  const userUploadsDir = path.join(uploadsBase, paddedUserId);
  console.log(`Checking if user uploads folder exists at: ${userUploadsDir}`);

  if (fs.existsSync(userUploadsDir)) {
    console.log('✓ SUCCESS: User-specific uploads folder was found!');
    
    // Check if the directory is clean (files inside should be deleted)
    const files = fs.readdirSync(userUploadsDir);
    if (files.length === 0) {
      console.log('✓ SUCCESS: User-specific uploads folder is clean (no files left behind).');
    } else {
      console.error(`✗ WARNING: Files were left behind in ${userUploadsDir}:`, files);
    }
  } else {
    console.error('✗ FAILURE: User-specific uploads folder was NOT found!');
    process.exit(1);
  }

  console.log('--- All Tests Passed Successfully! ---');
}

test();
