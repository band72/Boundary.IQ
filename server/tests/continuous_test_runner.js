import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import http from 'http';

const serverDir = path.resolve(process.cwd());
const clientDir = path.resolve(serverDir, '../client');

const ANSI_COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  fgRed: '\x1b[31m',
  fgGreen: '\x1b[32m',
  fgYellow: '\x1b[33m',
  fgBlue: '\x1b[34m',
  fgCyan: '\x1b[36m',
};

function checkPortOpen(port) {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') resolve(true);
      else resolve(false);
    });
    server.once('listening', () => {
      server.close();
      resolve(false);
    });
    server.listen(port);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCommand(command, cwd, env = {}) {
  console.log(`${ANSI_COLORS.fgCyan}Running: ${command} in ${cwd}...${ANSI_COLORS.reset}`);
  try {
    execSync(command, {
      cwd,
      stdio: 'inherit',
      env: { ...process.env, ...env }
    });
    console.log(`${ANSI_COLORS.fgGreen}✓ SUCCESS${ANSI_COLORS.reset}\n`);
    return true;
  } catch (err) {
    console.error(`${ANSI_COLORS.fgRed}✗ FAILED: ${command}${ANSI_COLORS.reset}\n`);
    return false;
  }
}

async function startLocalServer(port) {
  console.log(`${ANSI_COLORS.fgCyan}Starting local test server on port ${port}...${ANSI_COLORS.reset}`);
  const isUsed = await checkPortOpen(port);
  if (isUsed) {
    console.log(`Port ${port} already in use. Assuming server is running.`);
    return null;
  }
  
  const proc = spawn(process.execPath, ['index.js'], {
    cwd: serverDir,
    stdio: 'inherit',
    env: { ...process.env, PORT: port.toString() }
  });

  // Wait for the port to open
  let success = false;
  for (let i = 0; i < 30; i++) {
    await delay(200);
    if (await checkPortOpen(port)) {
      success = true;
      break;
    }
  }

  if (!success) {
    console.error(`${ANSI_COLORS.fgRed}✗ Failed to start local server within 6s${ANSI_COLORS.reset}`);
    proc.kill();
    throw new Error('Server start timeout');
  }

  console.log(`${ANSI_COLORS.fgGreen}✓ Local server started on port ${port}${ANSI_COLORS.reset}\n`);
  return proc;
}

async function runIteration(iteration) {
  console.log(`\n${ANSI_COLORS.bright}${ANSI_COLORS.fgBlue}=====================================================`);
  console.log(`   CONTINUOUS TEST RUNNER - ITERATION ${iteration}`);
  console.log(`=====================================================${ANSI_COLORS.reset}\n`);

  let allPassed = true;

  // 1. Client Linter
  if (!runCommand('npm run lint', clientDir)) allPassed = false;

  // 2. Server Linter
  if (!runCommand('npm run lint', serverDir)) allPassed = false;

  // 3. Unit Tests (Vitest)
  if (!runCommand('npm run test:unit', serverDir)) allPassed = false;

  // 4. Headless Riddle Verification
  if (!runCommand('node tests/test_headless_riddle.js', serverDir)) allPassed = false;

  // 5. Local Server Upload & Settings Test
  const testPort = 5055;
  let serverProc = null;
  try {
    serverProc = await startLocalServer(testPort);
    if (!runCommand('node tests/test_user_settings_uploads.js', serverDir, { PORT: testPort.toString() })) {
      allPassed = false;
    }
  } catch (err) {
    console.error(`${ANSI_COLORS.fgRed}✗ Local upload test skipped due to server error: ${err.message}${ANSI_COLORS.reset}`);
    allPassed = false;
  } finally {
    if (serverProc) {
      console.log('Stopping local test server...');
      serverProc.kill();
      await delay(500);
    }
  }

  // 6. Remote Settings & Upload Test
  if (!runCommand('node tests/test_remote_uploads.js', serverDir)) allPassed = false;

  console.log(`\n${ANSI_COLORS.bright}=====================================================`);
  if (allPassed) {
    console.log(` ${ANSI_COLORS.fgGreen}🎉 ITERATION ${iteration} COMPLETE: ALL TESTS PASSED!${ANSI_COLORS.reset}`);
  } else {
    console.log(` ${ANSI_COLORS.fgRed}✗ ITERATION ${iteration} COMPLETE: SOME TESTS FAILED!${ANSI_COLORS.reset}`);
  }
  console.log(`=====================================================\n`);
}

async function main() {
  let iteration = 1;
  const loopCount = process.env.LOOP_COUNT ? parseInt(process.env.LOOP_COUNT) : Infinity;
  while (iteration <= loopCount) {
    await runIteration(iteration++);
    if (iteration <= loopCount) {
      const waitSec = 10;
      console.log(`Sleeping for ${waitSec} seconds before the next iteration...`);
      await delay(waitSec * 1000);
    }
  }
}

main().catch(err => {
  console.error('Fatal Runner Error:', err);
  process.exit(1);
});
