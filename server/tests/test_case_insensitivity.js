import 'dotenv/config';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { assert } from 'console';
import * as db from '../services/diagnosticsDb.js';
import { resolvePathCaseInsensitive } from '../services/pathUtils.js';

async function runTests() {
  console.log('--- STARTING CASE INSENSITIVITY TEST SUITE ---');
  
  // 1. Initialize DB
  db.init();
  const rawDb = db.getDb();
  
  // 2. USERNAME CASE INSENSITIVITY TESTS
  console.log('\n[1/3] Testing Username Case-Insensitivity...');
  
  const testUser = 'TestUser_CaseSensitive';
  const testUserLower = testUser.toLowerCase();
  
  // Clean up existing user if present
  try {
    const existing = db.findUserByUsername(testUser);
    if (existing) {
      db.deleteUser(existing.id);
      console.log(`  - Cleaned up pre-existing test user: ${testUser}`);
    }
  } catch (err) {
    console.warn('  - Non-critical warning cleanup failed:', err.message);
  }

  // Create user with mixed case
  const user = db.createUser(testUser, 'password123');
  console.log(`  ✓ Successfully registered user: ${user.username}`);
  
  // Attempt to register again with lowercase username -> should throw Username already exists
  let registrationFailedAsExpected = false;
  try {
    db.createUser(testUserLower, 'anotherPassword');
  } catch (err) {
    if (err.message.includes('Username already exists')) {
      registrationFailedAsExpected = true;
    } else {
      console.error('  ✗ Unexpected error on duplicate registration:', err.message);
    }
  }
  
  if (registrationFailedAsExpected) {
    console.log('  ✓ Duplicate registration rejected case-insensitively (as expected)');
  } else {
    throw new Error('✗ FAIL: Allowed duplicate username with different casing!');
  }
  
  // Verify/Login using lowercase username -> should succeed
  const verified = db.verifyUser(testUserLower, 'password123');
  if (verified && verified.username.toLowerCase() === testUserLower) {
    console.log(`  ✓ Successfully verified/logged in user using lowercase query: ${testUserLower}`);
  } else {
    throw new Error('✗ FAIL: Could not verify user using lowercase username query!');
  }

  // Find user by uppercase username -> should succeed
  const found = db.findUserByUsername(testUser.toUpperCase());
  if (found && found.username.toLowerCase() === testUserLower) {
    console.log(`  ✓ Successfully found user using uppercase query: ${testUser.toUpperCase()}`);
  } else {
    throw new Error('✗ FAIL: Could not lookup user using uppercase username query!');
  }
  
  // Clean up
  db.deleteUser(user.id);
  console.log('  ✓ Cleaned up test user');

  // 3. DATABASE QUERIES CASE INSENSITIVITY TESTS (Status & Reference Point)
  console.log('\n[2/3] Testing DB Query Case-Insensitivity...');
  
  const testBatch = 'CASE_TEST_BATCH';
  const testFile = '10615A_CASE_TEST.txt';
  const testRefPoint = 'SECTION 4_TEST_CASE';
  
  // Delete any existing logs with this filename to have a clean state
  rawDb.prepare('DELETE FROM DeedLogs WHERE FileName = ? COLLATE NOCASE').run(testFile);
  
  // Save a deed log
  db.saveDeedLog(
    testBatch,
    testFile,
    'Test Parcel',
    5,
    0.05,
    15000,
    'FAIL',
    'Stage 5: Test Case Resolution',
    JSON.stringify({ courses: [] }),
    JSON.stringify({ closure: {} }),
    null,
    0.95,
    null,
    testRefPoint
  );
  console.log('  ✓ Saved test deed log entry');
  
  // Query detail using lowercase filename
  const detail = db.getDeedDetail(testFile.toLowerCase());
  if (detail && detail.fileName === testFile) {
    console.log(`  ✓ getDeedDetail matched case-insensitively for: ${testFile.toLowerCase()}`);
  } else {
    throw new Error(`✗ FAIL: getDeedDetail did not match case-insensitively for ${testFile.toLowerCase()}`);
  }
  
  // Query reference point using lowercase ref point name
  const deedsByRef = db.getDeedsByReferencePoint(testRefPoint.toLowerCase());
  // Note: getDeedsByReferencePoint queries Status IN ('PASS', 'MEANDER'). Since our test deed is 'FAIL',
  // it won't be returned by that function. Let's temporarily save a PASS deed.
  db.saveCorrectedDeed(
    testFile,
    'Test Parcel',
    'PASS',
    'Stage 5: Test Case Resolution',
    JSON.stringify({ courses: [] }),
    JSON.stringify({ closure: {} }),
    null,
    0.95,
    null,
    testRefPoint
  );
  
  const deedsByRef2 = db.getDeedsByReferencePoint(testRefPoint.toLowerCase());
  if (deedsByRef2 && deedsByRef2.length > 0 && deedsByRef2[0].fileName === testFile) {
    console.log(`  ✓ getDeedsByReferencePoint matched case-insensitively for: ${testRefPoint.toLowerCase()}`);
  } else {
    throw new Error(`✗ FAIL: getDeedsByReferencePoint did not match case-insensitively for ${testRefPoint.toLowerCase()}`);
  }
  
  // Query status case-insensitively using searchDeedLogs
  const searchResults = db.searchDeedLogs(null, 'pass');
  const foundSearch = searchResults.find(r => r.fileName === testFile);
  if (foundSearch) {
    console.log('  ✓ searchDeedLogs matched status case-insensitively for: pass');
  } else {
    throw new Error('✗ FAIL: searchDeedLogs did not match status case-insensitively');
  }
  
  // Clean up DB log
  rawDb.prepare('DELETE FROM DeedLogs WHERE FileName = ? COLLATE NOCASE').run(testFile);
  console.log('  ✓ Cleaned up test deed log entries');

  // 4. PATH RESOLUTION CASE INSENSITIVITY TESTS
  console.log('\n[3/3] Testing Path Resolution Case-Insensitivity...');
  
  const tempBase = path.join(os.tmpdir(), 'biq_case_test_dir');
  const nestedDir = path.join(tempBase, 'Nested_Folder_Case');
  const targetFile = path.join(nestedDir, 'Target_File_Case.txt');
  
  fs.mkdirSync(nestedDir, { recursive: true });
  fs.writeFileSync(targetFile, 'Hello, Case-Insensitive World!');
  console.log(`  - Created test file with mixed-case paths: ${targetFile}`);
  
  // Try to resolve case-insensitively
  const searchPathLower = path.join(tempBase, 'nested_folder_case', 'target_file_case.txt');
  const resolved = resolvePathCaseInsensitive(searchPathLower);
  
  console.log(`  - Query Path (lowercase): ${searchPathLower}`);
  console.log(`  - Resolved Path:          ${resolved}`);
  
  if (resolved === targetFile) {
    console.log('  ✓ Path resolved case-insensitively successfully');
  } else {
    throw new Error('✗ FAIL: Path did not resolve case-insensitively!');
  }
  
  // Clean up files
  fs.rmSync(tempBase, { recursive: true, force: true });
  console.log('  ✓ Cleaned up temporary test files');
  
  console.log('\n--- ALL CASE INSENSITIVITY TESTS PASSED ---');
}

runTests().catch(err => {
  console.error('\n--- TEST SUITE FAILED ---');
  console.error(err);
  process.exit(1);
});
