// ─── Auth Flow Verification Script ───────────────────────────────────────────
import * as dbSvc from '../services/diagnosticsDb.js';

console.log('🚀 Starting User Authentication Flow Verification...');

try {
  // 1. Initialize SQLite Database
  console.log('\n[1] Initializing database...');
  dbSvc.init();
  console.log('✓ Database initialized successfully.');

  // Generate a random username to avoid collisions on multiple test runs
  const testUsername = 'surveyor_' + Math.floor(Math.random() * 100000);
  const testPassword = 'Password123!';

  // 2. User Creation Test
  console.log(`\n[2] Registering test user: "${testUsername}"...`);
  const newUser = dbSvc.createUser(testUsername, testPassword, 'admin');
  console.log('✓ User created successfully:');
  console.log('  - Id:', newUser.id);
  console.log('  - Username:', newUser.username);
  console.log('  - Role:', newUser.role);

  if (newUser.username !== testUsername || newUser.role !== 'admin') {
    throw new Error('User payload does not match input arguments');
  }

  // 3. Duplicate Prevention Test
  console.log('\n[3] Testing duplicate username registration prevention...');
  try {
    dbSvc.createUser(testUsername, 'AnotherPassword!');
    throw new Error('Duplicate username registered successfully — FAILURE!');
  } catch (err) {
    if (err.message === 'Username already exists') {
      console.log('✓ Duplicate registration blocked with correct message: "Username already exists".');
    } else {
      throw err;
    }
  }

  // 4. Verification & Hashing Test
  console.log('\n[4] Testing credentials verification...');
  
  // Valid credentials
  const validAuth = dbSvc.verifyUser(testUsername, testPassword);
  if (!validAuth) {
    throw new Error('Valid login credentials rejected!');
  }
  console.log('✓ Valid credentials accepted. Returned details:', JSON.stringify(validAuth));

  // Invalid password
  const invalidPass = dbSvc.verifyUser(testUsername, 'wrong_password');
  if (invalidPass !== null) {
    throw new Error('Invalid password accepted!');
  }
  console.log('✓ Invalid password correctly rejected.');

  // Non-existent user
  const invalidUser = dbSvc.verifyUser('non_existent_user', testPassword);
  if (invalidUser !== null) {
    throw new Error('Non-existent user verified successfully!');
  }
  console.log('✓ Non-existent username correctly rejected.');

  // 5. Session Token Creation & Lifetime Test
  console.log('\n[5] Testing Session registration & validation...');
  const token = dbSvc.createSession(newUser.id);
  console.log('✓ Session token registered in SQLite:', token);

  const activeSession = dbSvc.getSession(token);
  if (!activeSession) {
    throw new Error('Failed to retrieve registered session!');
  }
  console.log('✓ Session verified successfully:');
  console.log('  - UserId:', activeSession.userId);
  console.log('  - Username:', activeSession.username);
  console.log('  - Role:', activeSession.role);

  if (activeSession.username !== testUsername) {
    throw new Error('Session username does not match registered user');
  }

  // 6. Session Deletion (Logout) Test
  console.log('\n[6] Testing Session deletion (Logout)...');
  dbSvc.deleteSession(token);
  console.log('✓ Session revoked.');

  const revokedSession = dbSvc.getSession(token);
  if (revokedSession !== null) {
    throw new Error('Revoked session token is still valid!');
  }
  console.log('✓ Session verified as completely revoked.');

  console.log('\n🎉 ALL AUTHENTICATION UNIT TESTS PASSED SUCCESSFULLY! 🎉\n');
  process.exit(0);

} catch (err) {
  console.error('\n❌ VERIFICATION TEST FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
}
