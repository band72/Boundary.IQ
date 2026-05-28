import * as dbSvc from '../services/diagnosticsDb.js';

console.log('🚀 Starting Google Sign-In End-to-End Integration Verification...');

const SERVER_URL = 'http://localhost:5050';

async function run() {
  try {
    // 1. Initialize SQLite Database to check state locally
    console.log('[1] Initializing diagnostics database connection...');
    dbSvc.init();

    // Generate a unique mock google email
    const googleEmail = `surveyor_google_${Math.floor(Math.random() * 100000)}@gmail.com`;
    const googleName = 'Google Surveyor';

    // 2. Construct mock Google JWT ID Token
    console.log(`[2] Constructing mock Google JWT for email: "${googleEmail}"...`);
    const headerStr = JSON.stringify({ alg: 'RS256', typ: 'JWT' });
    const payloadStr = JSON.stringify({
      iss: 'https://accounts.google.com',
      sub: '109876543210987654321',
      email: googleEmail,
      email_verified: true,
      name: googleName,
      picture: 'https://lh3.googleusercontent.com/a/mock-pic',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600
    });
    
    const encodeBase64Url = (str) => {
      return Buffer.from(str)
        .toString('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
    };

    const mockJwt = `${encodeBase64Url(headerStr)}.${encodeBase64Url(payloadStr)}.mocksignature`;

    // 3. Make live HTTP request to the running Express auth endpoint
    console.log(`[3] Sending POST /api/auth/google-login to ${SERVER_URL}...`);
    const response = await fetch(`${SERVER_URL}/api/auth/google-login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ credential: mockJwt })
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(`Endpoint returned status ${response.status}: ${data.error || JSON.stringify(data)}`);
    }

    console.log('✓ API accepted mock Google token successfully!');
    console.log('  - Returned Session Token:', data.token);
    console.log('  - Registered Username:', data.username);
    console.log('  - Role Assigned:', data.role);

    if (data.username !== googleEmail) {
      throw new Error(`Username mismatch. Expected "${googleEmail}", got "${data.username}"`);
    }

    // 4. Verify user exists in SQLite DB locally
    console.log('\n[4] Querying local SQLite database to confirm registration...');
    const localUser = dbSvc.findUserByUsername(googleEmail);
    if (!localUser) {
      throw new Error('User was not written to the SQLite database!');
    }
    console.log('✓ SQLite DB confirms user is persisted securely:');
    console.log('  - SQLite Id:', localUser.id);
    console.log('  - SQLite Username:', localUser.username);
    console.log('  - SQLite Role:', localUser.role);

    // 5. Test GET /api/auth/me session check endpoint
    console.log('\n[5] Calling GET /api/auth/me using the returned session token...');
    const meResponse = await fetch(`${SERVER_URL}/api/auth/me`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${data.token}`
      }
    });

    const meData = await meResponse.json();
    if (!meResponse.ok) {
      throw new Error(`GET /me failed with status ${meResponse.status}: ${meData.error}`);
    }

    console.log('✓ Session verification succeeded:');
    console.log('  - Authenticated UserId:', meData.id);
    console.log('  - Authenticated Username:', meData.username);
    console.log('  - Authenticated Role:', meData.role);

    if (meData.id !== localUser.id || meData.username !== googleEmail) {
      throw new Error('Authenticated session details do not match SQLite DB values');
    }

    console.log('\n🎉 ALL GOOGLE AUTH E2E INTEGRATION TESTS PASSED SUCCESSFULLY! 🎉\n');
    process.exit(0);

  } catch (err) {
    console.error('\n❌ GOOGLE AUTH VERIFICATION FAILED:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

run();
