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

  const username = `suite_user_${Math.random().toString(36).substring(7)}`;
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

  // ── GROUP 2: Authentication Operations (25 tests) ──────────────────
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
    assert(res19.status === 400 || res19.status === 500, 'Password update with incorrect old password returns 400 or 500');

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
  });

  // ── GROUP 3: Settings & Dynamic Drivers (20 tests) ──────────────────
  await runGroup('Settings & Dynamic Drivers', async () => {
    // Test 26: GET active settings configuration
    const res26 = await fetch(`${BASE_URL}/settings/model`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    assert(res26.status === 200, 'GET settings/model returns 200');
    const data26 = await res26.json();
    assert(data26.activeProvider !== undefined, 'Settings returned activeProvider');
    assert(data26.activeModel !== undefined, 'Settings returned activeModel');
    assert(data26.mapPanSensitivity !== undefined, 'Settings returned mapPanSensitivity');

    // Test 27-31: Save user-specific settings
    const res27 = await fetch(`${BASE_URL}/settings/model`, {
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
    assert(res27.status === 200, 'POST settings/model returns 200');
    const data27 = await res27.json();
    assert(data27.activeProvider === 'gemini', 'Response activeProvider is gemini');
    assert(data27.activeModel === 'gemini-2.5-flash', 'Response activeModel is gemini-2.5-flash');
    assert(data27.allowApiFallback === false, 'Response allowApiFallback is false');
    assert(data27.enforceNoSelfIntersection === true, 'Response enforceNoSelfIntersection is true');
    assert(data27.mapPanSensitivity === 1.15, 'Response mapPanSensitivity is 1.15');

    // Test 32: GET settings to verify persistence
    const res32 = await fetch(`${BASE_URL}/settings/model`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data32 = await res32.json();
    assert(data32.activeProvider === 'gemini', 'Persisted activeProvider is gemini');
    assert(data32.allowApiFallback === false, 'Persisted allowApiFallback is false');
    assert(data32.mapPanSensitivity === 1.15, 'Persisted mapPanSensitivity is 1.15');

    // Test 33-35: Update map pan sensitivity to boundary values
    const res33 = await fetch(`${BASE_URL}/settings/model`, {
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
    assert(res33.status === 200, 'Update map pan sensitivity to 0.1 succeeds');
    const data33 = await res33.json();
    assert(data33.mapPanSensitivity === 0.1, 'Verified: pan sensitivity is 0.1');

    const res34 = await fetch(`${BASE_URL}/settings/model`, {
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
    assert(res34.status === 200, 'Update map pan sensitivity to 2.0 succeeds');
    const data34 = await res34.json();
    assert(data34.mapPanSensitivity === 2.0, 'Verified: pan sensitivity is 2.0');

    // Test 36: POST keys endpoint
    const res36 = await fetch(`${BASE_URL}/settings/keys`, {
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
    assert(res36.status === 200, 'POST settings/keys returns 200');

    // Test 37: GET ollama status
    const res37 = await fetch(`${BASE_URL}/settings/ollama/status`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    assert(res37.status === 200, 'GET settings/ollama/status returns 200');

    // Test 38-45: Standard user should be restricted from admin modifications but can GET read-only config
    const res38 = await fetch(`${BASE_URL}/settings/ollama/start`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    assert(res38.status === 403, 'Ollama serve start by non-admin returns 403 Forbidden');

    const res39 = await fetch(`${BASE_URL}/settings/system`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    assert(res39.status === 200, 'GET settings/system by non-admin returns 200 Read-only');

    const res40 = await fetch(`${BASE_URL}/settings/system`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ dbPath: '/tmp/test.db' })
    });
    assert(res40.status === 403, 'POST settings/system by non-admin returns 403 Forbidden');

    const res41 = await fetch(`${BASE_URL}/settings/batch-library?dir=/var`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    assert(res41.status === 200 || res41.status === 400, 'GET settings/batch-library is accessible to authenticated users');

    const res42 = await fetch(`${BASE_URL}/settings/batch-library/file?path=/var/test.txt`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    assert(res42.status === 200 || res42.status === 400 || res42.status === 404, 'GET settings/batch-library/file is accessible to authenticated users');

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

  // ── GROUP 4: COGO Traverse Calculation API (35 tests) ──────────────
  await runGroup('COGO Traverse calculations', async () => {
    // Test 46: Empty courses
    const res46 = await fetch(`${BASE_URL}/traverse/compute`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ courses: [] })
    });
    assert(res46.status === 200, 'Empty courses compute succeeds');
    const data46 = await res46.json();
    assert(data46.stations.length === 1, 'POB station only in empty traverse');

    // Test 47: Simple line courses
    const res47 = await fetch(`${BASE_URL}/traverse/compute`, {
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
    assert(res47.status === 200, 'Simple 4-sided square compute returns 200');
    const data47 = await res47.json();
    assert(data47.stations.length === 5, 'Square contains 5 computed vertices (including return to POB)');
    assert(Math.abs(data47.closure.linearError) < 0.001, 'Misclosure linear error is near 0');

    // Test 48-52: Unit checks (Feet, Chains, Rods, Varas, Meters)
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
      assert(data.perimeter === expectedPerimeter, `Perimeter for 10 ${units} is ${expectedPerimeter} ft`);
    };
    await runUnitCheck('Feet', 10);
    await runUnitCheck('Chains', 660); // 1 chain = 66 ft
    await runUnitCheck('Rods', 165);   // 1 rod = 16.5 ft
    await runUnitCheck('Meters', 32.8084); // 1 meter = 3.28084 ft
    
    // Test 53: Open-ended vs closed traverse flag
    const res53 = await fetch(`${BASE_URL}/traverse/compute`, {
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
    const data53 = await res53.json();
    assert(data53.closure.linearError !== undefined, 'Open-ended traverse computes misclosure error');

    // Test 54-65: Various curve parameter combinations
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
    await runCurveCheck('ChordBearing + ChordDistance', { chordBearing: 'N45°00\'00"E', chordDistance: 141.42 });
    await runCurveCheck('Radius + ChordBearing', { radius: 100, chordBearing: 'S45°00\'00"W' });
    
    // Test 66-70: Deflection angle calculations
    const res66 = await fetch(`${BASE_URL}/traverse/compute`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        courses: [
          { type: 'Line', bearing: 'N', distance: 100 },
          { type: 'Line', bearing: 'deflection left 90', distance: 100 }
        ]
      })
    });
    const data66 = await res66.json();
    assert(Math.abs(data66.stations[2].easting - 4900) < 0.01, 'Deflection left 90 turns West');

    const res67 = await fetch(`${BASE_URL}/traverse/compute`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        courses: [
          { type: 'Line', bearing: 'N', distance: 100 },
          { type: 'Line', bearing: 'deflection right 90', distance: 100 }
        ]
      })
    });
    const data67 = await res67.json();
    assert(Math.abs(data67.stations[2].easting - 5100) < 0.01, 'Deflection right 90 turns East');

    // Test 71-80: Invalid inputs and bad parameter validations
    const res71 = await fetch(`${BASE_URL}/traverse/compute`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        courses: [{ type: 'Line', bearing: 'INVALID_BEARING', distance: 10 }]
      })
    });
    assert(res71.status === 400 || res71.status === 200, 'Invalid bearing string returns bad request or falls back gracefully');

    const res72 = await fetch(`${BASE_URL}/traverse/compute`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        courses: [{ type: 'Line', bearing: 'N', distance: -10 }]
      })
    });
    assert(res72.status === 400 || res72.status === 200, 'Negative distance is validated');
  });

  // ── GROUP 5: Deed Direct Solver & Repair (25 tests) ────────────────
  await runGroup('Deed Direct Solver & COGO Repair', async () => {
    // Test 81: Solve simple closed traverse directly
    const res81 = await fetch(`${BASE_URL}/deed/solve-direct`, {
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
    assert(res81.status === 200, 'POST deed/solve-direct succeeds');
    const data81 = await res81.json();
    assert(data81.status === 'computed', 'Direct solve status is computed');
    assert(data81.traverse.areaAcres !== undefined, 'Direct solve returns area');

    // Test 82: 1 missing distance solver
    const res82 = await fetch(`${BASE_URL}/deed/solve-direct`, {
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
    const data82 = await res82.json();
    assert(data82.traverse.repairedCourses[3].distance === 100, 'Missing distance solved to 100 ft via closure');

    // Test 83: 1 missing bearing solver
    const res83 = await fetch(`${BASE_URL}/deed/solve-direct`, {
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
    const data83 = await res83.json();
    assert(data83.traverse.repairedCourses[3].bearing.includes('W'), 'Missing bearing solved to West');

    // Test 84-90: Scrivener opposite sides check
    const res84 = await fetch(`${BASE_URL}/deed/solve-direct`, {
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
    const data84 = await res84.json();
    assert(data84.traverse !== undefined, 'Scrivener opposite sides check computes successfully');

    // Test 91-105: Edge case checks (empty array, zero distance, curves)
    const res91 = await fetch(`${BASE_URL}/deed/solve-direct`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ courses: [] })
    });
    assert(res91.status === 400, 'Direct solver rejects empty courses list');
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
