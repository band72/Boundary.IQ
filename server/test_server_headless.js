import { spawn } from 'child_process';
import { fetch } from 'undici';
import http from 'http';

const PORT = process.env.PORT || 5050;
const BASE_URL = `http://localhost:${PORT}`;

const ANSI_COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  fgRed: '\x1b[31m',
  fgGreen: '\x1b[32m',
  fgYellow: '\x1b[33m',
  fgBlue: '\x1b[34m',
  fgCyan: '\x1b[36m',
  bgBlue: '\x1b[40m',
  fgWhite: '\x1b[37m'
};

function checkPortOpen(port) {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve(true); // Port is in use (server already running)
      } else {
        resolve(false);
      }
    });
    server.once('listening', () => {
      server.close();
      resolve(false); // Port is open (server not running)
    });
    server.listen(port);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTests() {
  console.log(`${ANSI_COLORS.fgCyan}=====================================================${ANSI_COLORS.reset}`);
  console.log(`${ANSI_COLORS.bright}       Boundary.IQ Headless Server Integration Test  ${ANSI_COLORS.reset}`);
  console.log(`${ANSI_COLORS.fgCyan}=====================================================${ANSI_COLORS.reset}`);

  const alreadyRunning = await checkPortOpen(PORT);
  let spawnedProcess = null;

  if (alreadyRunning) {
    console.log(`✓ Detected running server on port ${PORT}. Testing active instance...`);
  } else {
    console.log(`⏳ Server not detected on port ${PORT}. Starting server programmatically...`);
    spawnedProcess = spawn('node', ['index.js'], {
      stdio: 'inherit',
      env: { ...process.env, PORT: PORT.toString() }
    });

    // Wait for the port to open
    let success = false;
    for (let i = 0; i < 25; i++) {
      await delay(200);
      if (await checkPortOpen(PORT)) {
        success = true;
        break;
      }
    }

    if (!success) {
      console.error(`${ANSI_COLORS.fgRed}✗ Error: Failed to start Node.js server within 5 seconds.${ANSI_COLORS.reset}`);
      if (spawnedProcess) spawnedProcess.kill();
      process.exit(1);
    }
    console.log(`✓ Programmatic server started on port ${PORT}. Running tests...`);
  }

  let failedCount = 0;
  let passedCount = 0;

  async function testCase(name, fn) {
    console.log(`\n▶ Running: ${ANSI_COLORS.bright}${name}${ANSI_COLORS.reset}...`);
    try {
      await fn();
      console.log(`  ${ANSI_COLORS.fgGreen}✓ PASSED${ANSI_COLORS.reset}`);
      passedCount++;
    } catch (err) {
      console.error(`  ${ANSI_COLORS.fgRed}✗ FAILED: ${err.message}${ANSI_COLORS.reset}`);
      failedCount++;
    }
  }

  // --- 1. Health Endpoint Test ---
  await testCase('GET /api/health', async () => {
    const res = await fetch(`${BASE_URL}/api/health`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.status !== 'ok') throw new Error(`Expected status "ok", got: ${data.status}`);
    if (!data.service.includes('Boundary.IQ')) throw new Error(`Unexpected service name: ${data.service}`);
    console.log(`  Response: status=${data.status}, service="${data.service}"`);
  });

  // --- 2. Settings Endpoint Test ---
  await testCase('GET /api/settings/model', async () => {
    const res = await fetch(`${BASE_URL}/api/settings/model`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.activeProvider) throw new Error('Missing "activeProvider" in settings payload.');
    console.log(`  Response: activeProvider=${data.activeProvider}`);
  });

  // --- 3. Traverse Calculation Test ---
  await testCase('POST /api/traverse/compute (Square Traverse)', async () => {
    const payload = {
      pointOfBeginning: { northing: 5000, easting: 5000 },
      courses: [
        { type: 'Line', bearing: 'N00°00\'00"E', distance: 100.0 },
        { type: 'Line', bearing: 'S90°00\'00"E', distance: 100.0 },
        { type: 'Line', bearing: 'S00°00\'00"W', distance: 100.0 },
        { type: 'Line', bearing: 'N90°00\'00"W', distance: 100.0 }
      ],
      units: 'Feet',
      isOpenEnded: false
    };

    const res = await fetch(`${BASE_URL}/api/traverse/compute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (!data.closure) throw new Error('Response is missing "closure" metrics.');
    const error = data.closure.linearError;
    if (error > 0.01) throw new Error(`Expected perfect square closure, got linear error: ${error}`);
    if (Math.abs(data.areaSqFt - 10000) > 1.0) throw new Error(`Expected area near 10,000 sq ft, got: ${data.areaSqFt}`);

    console.log(`  Linear Closure Error: ${error.toFixed(6)} ft`);
    console.log(`  Calculated Area:       ${data.areaSqFt.toFixed(2)} sq ft`);
  });

  // --- 4. Legal Description Writer Test ---
  await testCase('POST /api/writer/generate', async () => {
    const payload = {
      courses: [
        { type: 'Line', bearing: 'N45°00\'00"E', distance: 120.5 },
        { type: 'Line', bearing: 'S30°15\'30"E', distance: 85.2 }
      ],
      units: 'Feet',
      parcelDescription: 'Lot 42'
    };

    const res = await fetch(`${BASE_URL}/api/writer/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (!data.legalDescription) throw new Error('Missing "legalDescription" output.');
    if (data.courseCount !== 2) throw new Error(`Expected 2 courses written, got: ${data.courseCount}`);
    console.log(`  Course Count: ${data.courseCount}`);
    console.log(`  Sample Output:\n${data.legalDescription.split('\n').slice(0, 3).join('\n')}...`);
  });

  // --- 5. DXF Generation Test ---
  await testCase('POST /api/dxf/generate', async () => {
    const payload = {
      stations: [
        { northing: 5000, easting: 5000 },
        { northing: 5100, easting: 5000 },
        { northing: 5100, easting: 5100 }
      ],
      courses: [
        { type: 'Line', bearing: 'N00°00\'00"E', distance: 100 },
        { type: 'Line', bearing: 'E90°00\'00"E', distance: 100 }
      ],
      units: 'Feet'
    };

    const res = await fetch(`${BASE_URL}/api/dxf/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('dxf')) throw new Error(`Expected content-type to include dxf, got: ${contentType}`);

    const text = await res.text();
    if (!text.includes('SECTION') || !text.includes('EOF')) throw new Error('Generated output is not a valid DXF file.');

    console.log(`  Response Content-Type: ${contentType}`);
    console.log(`  DXF File Size:         ${text.length} bytes`);
  });

  // --- 6. Diagnostics Database Test ---
  await testCase('GET /api/diagnostics/stats', async () => {
    const res = await fetch(`${BASE_URL}/api/diagnostics/stats`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.deedLogCount === undefined) throw new Error('Missing deedLogCount in database stats.');
    console.log(`  Deed Log Count: ${data.deedLogCount}`);
    console.log(`  Pass Count:     ${data.passCount}`);
    console.log(`  Fail Count:     ${data.failCount}`);
  });

  // --- Clean Up ---
  if (spawnedProcess) {
    console.log('\n⏹ Stopping programmatically-started server...');
    spawnedProcess.kill();
  }

  console.log(`\n${ANSI_COLORS.fgCyan}=====================================================${ANSI_COLORS.reset}`);
  console.log(` ${ANSI_COLORS.bright}HEADLESS TESTING COMPLETE${ANSI_COLORS.reset}`);
  console.log(` Passed:  ${ANSI_COLORS.fgGreen}${passedCount}${ANSI_COLORS.reset}`);
  console.log(` Failed:  ${ANSI_COLORS.fgRed}${failedCount}${ANSI_COLORS.reset}`);
  console.log(`${ANSI_COLORS.fgCyan}=====================================================${ANSI_COLORS.reset}`);

  if (failedCount > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests().catch((err) => {
  console.error('Fatal test runner crash:', err);
  process.exit(1);
});
