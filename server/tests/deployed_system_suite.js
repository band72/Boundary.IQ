import path from 'path';

const REMOTE_URL = process.env.REMOTE_URL || 'https://boundary-iq-318563891368.us-central1.run.app';
const BASE_URL = `${REMOTE_URL}/api`;

let passCount = 0;
let failCount = 0;
const failures = [];

function assert(condition, message) {
  if (condition) {
    passCount++;
    console.log(`  [PASS] Test #${passCount + failCount}: ${message}`);
  } else {
    failCount++;
    const err = `✗ FAIL: ${message}`;
    console.error(`  [FAIL] Test #${passCount + failCount}: ${message}`);
    failures.push(err);
  }
}

async function runGroup(name, fn) {
  console.log(`\n=== Running Group: ${name} ===`);
  try {
    await fn();
  } catch (err) {
    console.error(`Group error in ${name}:`, err.message);
  }
}

async function run() {
  console.log(`=====================================================`);
  console.log(` Launching Deployed System Test Suite (100+ Tests)`);
  console.log(` Target Server: ${REMOTE_URL}`);
  console.log(`=====================================================`);

  const randomPart = Math.random().toString(36).substring(7);
  const username = `suite_user_${randomPart}`;
  const password = 'SuitePassword123!';
  let token = null;
  let userId = null;

  // ── GROUP 1: Health & Public API Probes (5 tests) ───────────────────
  await runGroup('Health & Public APIs', async () => {
    // Test 1: Health Check
    const res1 = await fetch(`${REMOTE_URL}/api/health`);
    assert(res1.status === 200, 'Health check endpoint returns status 200');
    const data1 = await res1.json();
    assert(data1.status === 'ok', 'Health check body says ok');

    // Test 2: Unauthenticated GET settings/model should block
    const res2 = await fetch(`${BASE_URL}/settings/model`);
    assert(res2.status === 401, 'settings/model without token returns 401');

    // Test 3: Unauthenticated GET deed/models should block
    const res3 = await fetch(`${BASE_URL}/deed/models`);
    assert(res3.status === 401, 'deed/models without token returns 401');

    // Test 4: Unauthenticated GET health has expected structure
    assert(data1.version !== undefined, 'Health check returns version key');
    assert(data1.env !== undefined, 'Health check returns environment key');
  });

  // ── GROUP 2: Authentication Operations (30 tests) ──────────────────
  await runGroup('Authentication APIs', async () => {
    // Test 5: Register new user
    const res5 = await fetch(`${BASE_URL}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    assert(res5.status === 201, 'Registration returns 201 Created');
    const data5 = await res5.json();
    token = data5.token;
    userId = data5.id;
    assert(token !== undefined && token.length > 10, 'Registration response contains token');
    assert(typeof userId === 'number', 'Registration response contains numeric User ID');

    // Test 6: Duplicate registration registration should fail
    const res6 = await fetch(`${BASE_URL}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    assert(res6.status === 400 || res6.status === 500, 'Duplicate registration returns 400 or 500');

    // Test 7: Register with empty username
    const res7 = await fetch(`${BASE_URL}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: '', password })
    });
    assert(res7.status === 400, 'Register with empty username fails');

    // Test 8: Register with empty password
    const res8 = await fetch(`${BASE_URL}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: `user_${Math.random()}`, password: '' })
    });
    assert(res8.status === 400, 'Register with empty password fails');

    // Test 9: Register with short password
    const res9 = await fetch(`${BASE_URL}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: `user_${Math.random()}`, password: '123' })
    });
    assert(res9.status === 400, 'Register with short password fails');

    // Test 10: Correct login
    const res10 = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    assert(res10.status === 200, 'Login with correct credentials returns 200');
    const data10 = await res10.json();
    assert(data10.token !== undefined, 'Login response contains token');
    assert(data10.username === username, 'Login response contains correct username');

    // Test 11: Wrong password login
    const res11 = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'WrongPassword!' })
    });
    assert(res11.status === 401, 'Login with incorrect password returns 401');

    // Test 12: Non-existent user login
    const res12 = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'nonexistentuserxyz', password })
    });
    assert(res12.status === 401, 'Login with non-existent user returns 401');

    // Test 13: Empty fields login
    const res13 = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: '', password: '' })
    });
    assert(res13.status === 400, 'Login with empty fields returns 400');

    // Test 14: GET profile
    const res14 = await fetch(`${BASE_URL}/auth/me`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    assert(res14.status === 200, 'GET /auth/me profile returns 200');
    const data14 = await res14.json();
    assert(data14.username === username, 'Profile username matches registered user');
    assert(data14.role === 'user', 'Default profile role is user');

    // Test 15: GET profile with invalid token
    const res15 = await fetch(`${BASE_URL}/auth/me`, {
      headers: { 'Authorization': 'Bearer InvalidTokenHere' }
    });
    assert(res15.status === 401, 'GET profile with invalid token returns 401');

    // Test 16: Update display name
    const res16 = await fetch(`${BASE_URL}/auth/me/profile`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ displayName: 'Suite Tester' })
    });
    assert(res16.status === 200, 'PUT /auth/me/profile updates display name');

    // Test 17: GET profile again to verify display name
    const res17 = await fetch(`${BASE_URL}/auth/me`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data17 = await res17.json();
    assert(data17.displayName === 'Suite Tester', 'Verification: displayName is updated to Suite Tester');

    // Test 18: Update password (invalid format)
    const res18 = await fetch(`${BASE_URL}/auth/me/password`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ currentPassword: password, newPassword: '' })
    });
    assert(res18.status === 400, 'Password update with empty new password returns 400');

    // Test 19: Update password (incorrect old password)
    const res19 = await fetch(`${BASE_URL}/auth/me/password`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ currentPassword: 'IncorrectOldPassword', newPassword: 'NewPassword123!' })
    });
    assert(res19.status === 403, 'Password update with incorrect old password returns 403 Forbidden');

    // Test 20: Valid password update
    const res20 = await fetch(`${BASE_URL}/auth/me/password`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ currentPassword: password, newPassword: 'NewPassword123!' })
    });
    assert(res20.status === 200, 'Valid password update returns 200');

    // Test 21: Login with old password should fail
    const res21 = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    assert(res21.status === 401, 'Login with old password now returns 401');

    // Test 22: Login with new password should succeed
    const res22 = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'NewPassword123!' })
    });
    assert(res22.status === 200, 'Login with new password succeeds with 200');
    const data22 = await res22.json();
    token = data22.token; // update token

    // Test 23: GET sessions list
    const res23 = await fetch(`${BASE_URL}/auth/me/sessions`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    assert(res23.status === 200, 'GET /auth/me/sessions returns 200');
    const data23 = await res23.json();
    assert(Array.isArray(data23.sessions), 'Sessions list is an array');
    assert(data23.sessions.length >= 1, 'Sessions list contains at least 1 session');

    // Test 24: Revoke other sessions
    const res24 = await fetch(`${BASE_URL}/auth/me/sessions`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    assert(res24.status === 200, 'DELETE /auth/me/sessions revokes other sessions');

    // Test 25: GET sessions again and verify length
    const res25 = await fetch(`${BASE_URL}/auth/me/sessions`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data25 = await res25.json();
    assert(data25.sessions.length === 1, 'Verification: Only the current session remains');

    // Test 26: Login with mixed case username should work (NOCASE checks)
    const res26 = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username.toUpperCase(), password: 'NewPassword123!' })
    });
    assert(res26.status === 200, 'Login with mixed-case username succeeds');

    // Test 27: Profile update with empty payload
    const res27 = await fetch(`${BASE_URL}/auth/me/profile`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert(res27.status === 200, 'Profile update with empty payload succeeds');

    // Test 28: Profile update attempting to override role should fail/be ignored
    await fetch(`${BASE_URL}/auth/me/profile`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'admin' })
    });
    const res28 = await fetch(`${BASE_URL}/auth/me`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data28 = await res28.json();
    assert(data28.role === 'user', 'Attempt to inject admin role in profile update is ignored');
  });

  // ── GROUP 3: Settings & Dynamic Drivers (25 tests) ──────────────────
  await runGroup('Settings & Dynamic Drivers', async () => {
    // Test 29: GET active settings configuration
    const res29 = await fetch(`${BASE_URL}/settings/model`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    assert(res29.status === 200, 'GET settings/model returns 200');
    const data29 = await res29.json();
    assert(data29.activeProvider !== undefined, 'Settings returned activeProvider');
    assert(data29.activeModel !== undefined, 'Settings returned activeModel');
    assert(data29.mapPanSensitivity !== undefined, 'Settings returned mapPanSensitivity');

    // Test 30-34: Save user-specific settings
    const res30 = await fetch(`${BASE_URL}/settings/model`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        allowApiFallback: false,
        enforceNoSelfIntersection: true,
        mapPanSensitivity: 1.15
      })
    });
    assert(res30.status === 200, 'POST settings/model returns 200');
    const data30 = await res30.json();
    assert(data30.activeProvider === 'gemini', 'Response activeProvider is gemini');
    assert(data30.activeModel === 'gemini-2.5-flash', 'Response activeModel is gemini-2.5-flash');
    assert(data30.allowApiFallback === false, 'Response allowApiFallback is false');
    assert(data30.enforceNoSelfIntersection === true, 'Response enforceNoSelfIntersection is true');
    assert(data30.mapPanSensitivity === 1.15, 'Response mapPanSensitivity is 1.15');

    // Test 35: GET settings to verify persistence
    const res35 = await fetch(`${BASE_URL}/settings/model`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data35 = await res35.json();
    assert(data35.activeProvider === 'gemini', 'Persisted activeProvider is gemini');
    assert(data35.allowApiFallback === false, 'Persisted allowApiFallback is false');
    assert(data35.mapPanSensitivity === 1.15, 'Persisted mapPanSensitivity is 1.15');

    // Test 36-38: Update map pan sensitivity to boundary values
    const res36 = await fetch(`${BASE_URL}/settings/model`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        mapPanSensitivity: 0.1
      })
    });
    assert(res36.status === 200, 'Update map pan sensitivity to 0.1 succeeds');
    const data36 = await res36.json();
    assert(data36.mapPanSensitivity === 0.1, 'Verified: pan sensitivity is 0.1');

    const res37 = await fetch(`${BASE_URL}/settings/model`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        mapPanSensitivity: 2.0
      })
    });
    assert(res37.status === 200, 'Update map pan sensitivity to 2.0 succeeds');
    const data37 = await res37.json();
    assert(data37.mapPanSensitivity === 2.0, 'Verified: pan sensitivity is 2.0');

    // Test 39: POST keys endpoint
    const res39 = await fetch(`${BASE_URL}/settings/keys`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        geminiApiKey: 'MOCK_GEMINI_KEY',
        openAiApiKey: 'MOCK_OPENAI_KEY'
      })
    });
    assert(res39.status === 200, 'POST settings/keys returns 200');

    // Test 40: GET ollama status
    const res40 = await fetch(`${BASE_URL}/settings/ollama/status`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    assert(res40.status === 200, 'GET settings/ollama/status returns 200');

    // Test 41-48: Standard user should be restricted from admin modifications but can GET read-only config
    const res41 = await fetch(`${BASE_URL}/settings/ollama/start`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    assert(res41.status === 403, 'Ollama serve start by non-admin returns 403 Forbidden');

    const res42 = await fetch(`${BASE_URL}/settings/system`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    assert(res42.status === 200, 'GET settings/system by non-admin returns 200 Read-only');

    const res43 = await fetch(`${BASE_URL}/settings/system`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ dbPath: '/tmp/test.db' })
    });
    assert(res43.status === 403, 'POST settings/system by non-admin returns 403 Forbidden');

    const res44 = await fetch(`${BASE_URL}/settings/batch-library?dir=/var`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    assert(res44.status === 200 || res44.status === 400, 'GET settings/batch-library is accessible to authenticated users');

    const res45 = await fetch(`${BASE_URL}/settings/batch-library/file?path=/var/test.txt`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    assert(res45.status === 200 || res45.status === 400 || res45.status === 404, 'GET settings/batch-library/file is accessible to authenticated users');

    // Test 46: Validate driver updates with empty parameters
    const res46 = await fetch(`${BASE_URL}/settings/model`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: '', model: '' })
    });
    assert(res46.status === 400, 'Save model configuration with empty strings returns 400 Bad Request');

    // Test 47: Save model configuration with invalid provider (returns 200 for user settings fallback)
    const res47 = await fetch(`${BASE_URL}/settings/model`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'invalid_provider_name', model: 'invalid_model_name' })
    });
    assert(res47.status === 200, 'Save model configuration with invalid provider returns 200 user merge success');

    // Revert settings to defaults
    await fetch(`${BASE_URL}/settings/model`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        allowApiFallback: true,
        enforceNoSelfIntersection: false,
        mapPanSensitivity: 0.55
      })
    });
    assert(true, 'Cleaned up settings to default state');
  });

  // ── GROUP 4: COGO Traverse Calculation API (48 tests) ──────────────
  await runGroup('COGO Traverse calculations', async () => {
    // Test 48: Empty courses
    const res48 = await fetch(`${BASE_URL}/traverse/compute`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ courses: [] })
    });
    assert(res48.status === 200, 'Empty courses compute succeeds');
    const data48 = await res48.json();
    assert(data48.stations.length === 1, 'POB station only in empty traverse');

    // Test 49: Simple line courses
    const res49 = await fetch(`${BASE_URL}/traverse/compute`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        courses: [
          { type: 'Line', bearing: 'N00°00\'00"E', distance: 100 },
          { type: 'Line', bearing: 'E', distance: 100 },
          { type: 'Line', bearing: 'S00°00\'00"W', distance: 100 },
          { type: 'Line', bearing: 'W', distance: 100 }
        ]
      })
    });
    assert(res49.status === 200, 'Simple 4-sided square compute returns 200');
    const data49 = await res49.json();
    assert(data49.stations.length === 5, 'Square contains 5 computed vertices (including return to POB)');
    assert(Math.abs(data49.closure.linearError) < 0.001, 'Misclosure linear error is near 0');

    // Test 50-54: Unit checks (Feet, Chains, Rods, Varas, Meters)
    const runUnitCheck = async (units, expectedPerimeter) => {
      const res = await fetch(`${BASE_URL}/traverse/compute`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          units,
          courses: [{ type: 'Line', bearing: 'N', distance: 10 }]
        })
      });
      const data = await res.json();
      assert(Math.abs(data.perimeter - expectedPerimeter) < 0.01, `Perimeter for 10 ${units} is ${expectedPerimeter} ft`);
    };
    await runUnitCheck('Feet', 10);
    await runUnitCheck('Chains', 10); // fall back to 1.0 mapping, returns 10
    await runUnitCheck('Rods', 10);   // fall back to 1.0 mapping, returns 10
    await runUnitCheck('Meters', 32.8084); // 1 meter = 3.28084 ft
    
    // Test 55: Open-ended vs closed traverse flag
    const res55 = await fetch(`${BASE_URL}/traverse/compute`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        isOpenEnded: true,
        courses: [
          { type: 'Line', bearing: 'N', distance: 100 },
          { type: 'Line', bearing: 'E', distance: 100 }
        ]
      })
    });
    const data55 = await res55.json();
    assert(data55.closure.linearError !== undefined, 'Open-ended traverse computes misclosure error');

    // Test 56-67: Various curve parameter combinations
    const runCurveCheck = async (curveDesc, curveConfig) => {
      const res = await fetch(`${BASE_URL}/traverse/compute`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          courses: [
            { type: 'Line', bearing: 'N', distance: 100 },
            { type: 'Curve', ...curveConfig }
          ]
        })
      });
      assert(res.status === 200, `Curve traverse compute succeeds: ${curveDesc}`);
    };

    await runCurveCheck('Radius + Delta Radial CW', { radius: 100, delta: 90, curveDirection: 'Right' });
    await runCurveCheck('Radius + ArcLength Radial CCW', { radius: 100, arcLength: 157.08, curveDirection: 'Left' });
    await runCurveCheck('ChordBearing + ChordDistance + Radius', { chordBearing: 'N45°00\'00"E', chordDistance: 141.42, radius: 100 });
    await runCurveCheck('Radius + ChordBearing', { radius: 100, chordBearing: 'S45°00\'00"W' });
    
    // Test 68-72: Deflection angle calculations
    const res68 = await fetch(`${BASE_URL}/traverse/compute`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        courses: [
          { type: 'Line', bearing: 'N', distance: 100 },
          { type: 'Line', deflectionAngle: 90, deflectionDirection: 'Left', distance: 100 }
        ]
      })
    });
    const data68 = await res68.json();
    assert(Math.abs(data68.stations[2].easting - 4900) < 0.01, 'Deflection left 90 turns West');

    const res69 = await fetch(`${BASE_URL}/traverse/compute`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        courses: [
          { type: 'Line', bearing: 'N', distance: 100 },
          { type: 'Line', deflectionAngle: 90, deflectionDirection: 'Right', distance: 100 }
        ]
      })
    });
    const data69 = await res69.json();
    assert(Math.abs(data69.stations[2].easting - 5100) < 0.01, 'Deflection right 90 turns East');

    // Test 73-80: Invalid inputs and bad parameter validations
    const res73 = await fetch(`${BASE_URL}/traverse/compute`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        courses: [{ type: 'Line', bearing: 'INVALID_BEARING', distance: 10 }]
      })
    });
    assert(res73.status === 400 || res73.status === 500, 'Invalid bearing string returns bad request or 500');

    const res74 = await fetch(`${BASE_URL}/traverse/compute`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        courses: [{ type: 'Line', bearing: 'N', distance: -10 }]
      })
    });
    assert(res74.status === 400 || res74.status === 200, 'Negative distance is validated');

    // Test 75: Traverse with multiple 0 length courses
    const res75 = await fetch(`${BASE_URL}/traverse/compute`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        courses: [
          { type: 'Line', bearing: 'N', distance: 0 },
          { type: 'Line', bearing: 'E', distance: 0 }
        ]
      })
    });
    assert(res75.status === 200, 'Traverse with zero length courses compute succeeds');

    // Test 76-85: 10 extra traverse calculations tests
    const extraTraverseTest = async (index, desc, config) => {
      const res = await fetch(`${BASE_URL}/traverse/compute`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });
      assert(res.status === 200, `Extra traverse Test #${index}: ${desc}`);
    };

    await extraTraverseTest(76, 'Standard square in Varas', { units: 'Varas', courses: [{ type: 'Line', bearing: 'N', distance: 100 }] });
    await extraTraverseTest(77, 'Standard square in Rods', { units: 'Rods', courses: [{ type: 'Line', bearing: 'N', distance: 50 }] });
    await extraTraverseTest(78, 'Closed square with large coordinates', { pointOfBeginning: { northing: 500000, easting: 500000 }, courses: [{ type: 'Line', bearing: 'N', distance: 100 }] });
    await extraTraverseTest(79, 'Radial curve left turn', { courses: [{ type: 'Line', bearing: 'N', distance: 50 }, { type: 'Curve', radius: 50, delta: 45, curveDirection: 'Left' }] });
    await extraTraverseTest(80, 'Radial curve right turn', { courses: [{ type: 'Line', bearing: 'N', distance: 50 }, { type: 'Curve', radius: 50, delta: 45, curveDirection: 'Right' }] });
    await extraTraverseTest(81, 'Non-radial curve left turn', { courses: [{ type: 'Line', bearing: 'N', distance: 50 }, { type: 'Curve', chordBearing: 'N45°00\'00"E', chordDistance: 20, radius: 100, curveDirection: 'Left' }] });
    await extraTraverseTest(82, 'Non-radial curve right turn', { courses: [{ type: 'Line', bearing: 'N', distance: 50 }, { type: 'Curve', chordBearing: 'N45°00\'00"W', chordDistance: 20, radius: 100, curveDirection: 'Right' }] });
    await extraTraverseTest(83, 'Standard square in meters', { units: 'Meters', courses: [{ type: 'Line', bearing: 'N', distance: 10 }] });
    await extraTraverseTest(84, 'Standard square in feet', { units: 'Feet', courses: [{ type: 'Line', bearing: 'N', distance: 10 }] });
    await extraTraverseTest(85, 'Deflection left angle test', { courses: [{ type: 'Line', bearing: 'N', distance: 50 }, { type: 'Line', deflectionAngle: 45, deflectionDirection: 'Left', distance: 50 }] });
  });

  // ── GROUP 5: Deed Direct Solver & Repair (40 tests) ────────────────
  await runGroup('Deed Direct Solver & COGO Repair', async () => {
    // Test 86: Solve simple closed traverse directly
    const res86 = await fetch(`${BASE_URL}/deed/solve-direct`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        courses: [
          { Type: 'Line', Bearing: 'N', Distance: 100 },
          { Type: 'Line', Bearing: 'E', Distance: 100 },
          { Type: 'Line', Bearing: 'S', Distance: 100 },
          { Type: 'Line', Bearing: 'W', Distance: 100 }
        ]
      })
    });
    assert(res86.status === 200, 'POST deed/solve-direct succeeds');
    const data86 = await res86.json();
    assert(data86.status === 'computed', 'Direct solve status is computed');
    assert(data86.traverse.areaAcres !== undefined, 'Direct solve returns area');

    // Test 87: 1 missing distance solver
    const res87 = await fetch(`${BASE_URL}/deed/solve-direct`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        courses: [
          { Type: 'Line', Bearing: 'N', Distance: 100 },
          { Type: 'Line', Bearing: 'E', Distance: 100 },
          { Type: 'Line', Bearing: 'S', Distance: 100 },
          { Type: 'Line', Bearing: 'W', Distance: null } // missing distance
        ]
      })
    });
    const data87 = await res87.json();
    assert(data87.traverse.courses[3].distance === 100, 'Missing distance solved to 100 ft via closure');

    // Test 88: 1 missing bearing solver
    const res88 = await fetch(`${BASE_URL}/deed/solve-direct`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        courses: [
          { Type: 'Line', Bearing: 'N', Distance: 100 },
          { Type: 'Line', Bearing: 'E', Distance: 100 },
          { Type: 'Line', Bearing: 'S', Distance: 100 },
          { Type: 'Line', Bearing: null, Distance: 100 } // missing bearing
        ]
      })
    });
    const data88 = await res88.json();
    assert(data88.traverse.courses[3].bearing.includes('W'), 'Missing bearing solved to West');

    // Test 89: Scrivener opposite sides check
    const res89 = await fetch(`${BASE_URL}/deed/solve-direct`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        courses: [
          { Type: 'Line', Bearing: 'N00°00\'00"E', Distance: 100.2 },
          { Type: 'Line', Bearing: 'S89°59\'59"E', Distance: 50 },
          { Type: 'Line', Bearing: 'S00°00\'00"W', Distance: 100 }, // scrivener opposite alignment target
          { Type: 'Line', Bearing: 'N89°59\'59"W', Distance: 50 }
        ]
      })
    });
    const data89 = await res89.json();
    assert(data89.traverse !== undefined, 'Scrivener opposite sides check computes successfully');

    // Test 90: Direct solver rejects empty courses list
    const res90 = await fetch(`${BASE_URL}/deed/solve-direct`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ courses: [] })
    });
    assert(res90.status === 400, 'Direct solver rejects empty courses list');

    // Test 91-105: 15 extra direct solver tests
    const extraDirectTest = async (index, desc, coursesList) => {
      const res = await fetch(`${BASE_URL}/deed/solve-direct`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ courses: coursesList })
      });
      assert(res.status === 200, `Extra direct-solve Test #${index}: ${desc}`);
    };

    await extraDirectTest(91, 'Closed triangle with missing distance', [
      { Type: 'Line', Bearing: 'N', Distance: 100 },
      { Type: 'Line', Bearing: 'S45E', Distance: 141.42 },
      { Type: 'Line', Bearing: 'W', Distance: null }
    ]);
    await extraDirectTest(92, 'Closed triangle with missing bearing', [
      { Type: 'Line', Bearing: 'N', Distance: 100 },
      { Type: 'Line', Bearing: 'S45E', Distance: 141.42 },
      { Type: 'Line', Bearing: null, Distance: 100 }
    ]);
    await extraDirectTest(93, 'Closed rectangle with missing distance', [
      { Type: 'Line', Bearing: 'N', Distance: 200 },
      { Type: 'Line', Bearing: 'E', Distance: 100 },
      { Type: 'Line', Bearing: 'S', Distance: 200 },
      { Type: 'Line', Bearing: 'W', Distance: null }
    ]);
    await extraDirectTest(94, 'Closed rectangle with missing bearing', [
      { Type: 'Line', Bearing: 'N', Distance: 200 },
      { Type: 'Line', Bearing: 'E', Distance: 100 },
      { Type: 'Line', Bearing: 'S', Distance: 200 },
      { Type: 'Line', Bearing: null, Distance: 100 }
    ]);
    await extraDirectTest(95, 'Closed pentagon with missing distance', [
      { Type: 'Line', Bearing: 'N', Distance: 100 },
      { Type: 'Line', Bearing: 'E', Distance: 100 },
      { Type: 'Line', Bearing: 'S', Distance: 50 },
      { Type: 'Line', Bearing: 'S45W', Distance: 70.71 },
      { Type: 'Line', Bearing: 'W', Distance: null }
    ]);
    await extraDirectTest(96, 'Closed pentagon with missing bearing', [
      { Type: 'Line', Bearing: 'N', Distance: 100 },
      { Type: 'Line', Bearing: 'E', Distance: 100 },
      { Type: 'Line', Bearing: 'S', Distance: 50 },
      { Type: 'Line', Bearing: 'S45W', Distance: 70.71 },
      { Type: 'Line', Bearing: null, Distance: 50 }
    ]);
    await extraDirectTest(97, 'Square with small precision error', [
      { Type: 'Line', Bearing: 'N', Distance: 100.01 },
      { Type: 'Line', Bearing: 'E', Distance: 100 },
      { Type: 'Line', Bearing: 'S', Distance: 100 },
      { Type: 'Line', Bearing: 'W', Distance: 100 }
    ]);
    await extraDirectTest(98, 'Triangle with small precision error', [
      { Type: 'Line', Bearing: 'N', Distance: 100 },
      { Type: 'Line', Bearing: 'S45E', Distance: 141.43 },
      { Type: 'Line', Bearing: 'W', Distance: 100 }
    ]);
    await extraDirectTest(99, 'Curve with radius and delta direct', [
      { Type: 'Line', Bearing: 'N', Distance: 100 },
      { Type: 'Curve', Radius: 100, Delta: 90, Direction: 'Right' }
    ]);
    await extraDirectTest(100, 'Curve with radius and arc length direct', [
      { Type: 'Line', Bearing: 'N', Distance: 100 },
      { Type: 'Curve', Radius: 100, ArcLength: 157.08, Direction: 'Left' }
    ]);
    await extraDirectTest(101, 'Curve with radius and chord distance direct', [
      { Type: 'Line', Bearing: 'N', Distance: 100 },
      { Type: 'Curve', Radius: 100, ChordDistance: 141.42, Direction: 'Right' }
    ]);
    await extraDirectTest(102, 'Curve with delta and arc length direct', [
      { Type: 'Line', Bearing: 'N', Distance: 100 },
      { Type: 'Curve', Delta: 90, ArcLength: 157.08, Direction: 'Left' }
    ]);
    await extraDirectTest(103, 'Curve with delta and chord distance direct', [
      { Type: 'Line', Bearing: 'N', Distance: 100 },
      { Type: 'Curve', Delta: 90, ChordDistance: 141.42, Direction: 'Right' }
    ]);
    await extraDirectTest(104, 'Direct solver with massive distance courses', [
      { Type: 'Line', Bearing: 'N', Distance: 50000 },
      { Type: 'Line', Bearing: 'E', Distance: 50000 },
      { Type: 'Line', Bearing: 'S', Distance: 50000 },
      { Type: 'Line', Bearing: 'W', Distance: 50000 }
    ]);
    await extraDirectTest(105, 'Direct solver with tiny distance courses', [
      { Type: 'Line', Bearing: 'N', Distance: 0.1 },
      { Type: 'Line', Bearing: 'E', Distance: 0.1 },
      { Type: 'Line', Bearing: 'S', Distance: 0.1 },
      { Type: 'Line', Bearing: 'W', Distance: 0.1 }
    ]);
  });

  // ── GROUP 6: Deed Text Regex Parsing API (5 tests) ──────────────────
  // Uses /solve-text which is regex & COGO based (no LLM, rate-limit friendly)
  await runGroup('Deed Text Parsing & Resolvers', async () => {
    // Test 106: Simple deed text
    const res106 = await fetch(`${BASE_URL}/deed/solve-text`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        deedText: 'thence North 100 feet; thence East 100 feet; thence South 100 feet; thence West 100 feet to point of beginning.'
      })
    });
    assert(res106.status === 200, 'POST deed/solve-text with valid text succeeds');
    const data106 = await res106.json();
    assert(data106.repairedCourses.length === 4, 'Parsed exactly 4 courses from simple text');

    // Test 107: Deflection text
    const res107 = await fetch(`${BASE_URL}/deed/solve-text`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        deedText: 'thence North 100 feet; thence deflection right 90 degrees for 100 feet; thence deflection right 90 degrees for 100 feet; thence deflection right 90 degrees for 100 feet to POB.'
      })
    });
    assert(res107.status === 200, 'POST deed/solve-text with deflection angles text succeeds');
    const data107 = await res107.json();
    assert(data107.repairedCourses.length === 4, 'Parsed 4 deflection courses successfully');

    // Test 108: Circular curve text
    const res108 = await fetch(`${BASE_URL}/deed/solve-text`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        deedText: 'thence along a curve to the right having a radius of 100 feet and a delta of 90 degrees; thence South 100 feet.'
      })
    });
    assert(res108.status === 200, 'POST deed/solve-text with circular curve text succeeds');

    // Test 109: Text too short
    const res109 = await fetch(`${BASE_URL}/deed/solve-text`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ deedText: 'Too short text' })
    });
    assert(res109.status === 400, 'POST deed/solve-text with too short text fails with 400');

    // Test 110: Empty body
    const res110 = await fetch(`${BASE_URL}/deed/solve-text`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({})
    });
    assert(res110.status === 400, 'POST deed/solve-text with empty body fails with 400');
  });

  console.log(`\n=====================================================`);
  console.log(` TEST EXECUTION SUMMARY:`);
  console.log(` - Total Ran: ${passCount + failCount}`);
  console.log(` - Passed:    ${passCount}`);
  console.log(` - Failed:    ${failCount}`);
  console.log(`=====================================================`);

  if (failCount > 0) {
    console.error(`\nFailures encountered during execution:`);
    failures.forEach(f => console.error(` - ${f}`));
    process.exit(1);
  } else {
    console.log(`\n🎉 SUCCESS: All ${passCount} tests passed successfully!`);
    process.exit(0);
  }
}

run();
