#!/usr/bin/env node
/**
 * Admin Password Reset Script
 * Usage: node server/scripts/reset-admin.js [username] [newPassword]
 *
 * If run with no args, lists all admin users and prompts interactively.
 * Safe to run while the server is stopped OR running (uses same DB).
 *
 * Examples:
 *   node server/scripts/reset-admin.js
 *   node server/scripts/reset-admin.js admin MyNewPassword123!
 *   node server/scripts/reset-admin.js artwalk Survey2024!
 */

import 'dotenv/config';
import { createRequire } from 'module';
import path from 'path';
import os from 'os';
import readline from 'readline';
import crypto from 'crypto';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

// Same settings as diagnosticsDb.js
const PBKDF2_ITERATIONS = 310_000;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

// ── Locate the database ───────────────────────────────────────────────────────
function getDbPath() {
  const envPath = process.env.DIAGNOSTICS_DB_PATH || process.env.DB_PATH;
  if (envPath) return path.resolve(envPath);
  const configDir = process.env.APPDATA ||
    (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : path.join(os.homedir(), '.config'));
  return path.join(configDir, 'BoundaryQC', 'BoundaryQCDiagnostics.db');
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

async function main() {
  const dbPath = getDbPath();
  console.log(`\n🗄  Database: ${dbPath}\n`);

  let db;
  try {
    db = new Database(dbPath);
  } catch (err) {
    console.error(`❌ Cannot open database: ${err.message}`);
    console.error('   Make sure the server has been started at least once to create the DB.');
    process.exit(1);
  }

  // List all users
  const users = db.prepare('SELECT Id, Username, Role, Plan, Timestamp FROM Users ORDER BY Id').all();

  if (users.length === 0) {
    console.error('❌ No users found in the database. Start the server and register first.');
    process.exit(1);
  }

  console.log('👥 All users:\n');
  users.forEach(u => {
    const isAdmin = u.Role === 'admin';
    console.log(`  ${isAdmin ? '🔑' : '👤'} [${u.Id}] ${u.Username}  role=${u.Role}  plan=${u.Plan}  created=${u.Timestamp?.slice(0,10)}`);
  });

  // Parse CLI args
  let [,, targetUsername, newPassword] = process.argv;

  if (!targetUsername) {
    console.log('');
    targetUsername = await prompt('Enter username to reset (or press Enter for first admin): ');
    if (!targetUsername) {
      const admin = users.find(u => u.Role === 'admin') || users[0];
      targetUsername = admin.Username;
      console.log(`  → Using: ${targetUsername}`);
    }
  }

  const target = users.find(u => u.Username.toLowerCase() === targetUsername.toLowerCase());
  if (!target) {
    console.error(`\n❌ User "${targetUsername}" not found.`);
    process.exit(1);
  }

  if (!newPassword) {
    console.log('');
    newPassword = await prompt(`New password for "${target.Username}" (Enter to generate): `);
    if (!newPassword) {
      // Generate a secure readable password
      const words = ['Survey', 'Deed', 'Parcel', 'Tract', 'Plat', 'Boundary', 'Section'];
      const word = words[Math.floor(Math.random() * words.length)];
      newPassword = `${word}${crypto.randomInt(1000, 9999)}!`;
      console.log(`  → Generated password: ${newPassword}`);
    }
  }

  if (newPassword.length < 6) {
    console.error('\n❌ Password must be at least 6 characters.');
    process.exit(1);
  }

  // Hash and update
  const hash = hashPassword(newPassword);

  db.prepare('UPDATE Users SET PasswordHash = ?, ForceResetPw = 0 WHERE Id = ?').run(hash, target.Id);

  // Revoke all sessions so old tokens can't be used
  const revoked = db.prepare('DELETE FROM Sessions WHERE UserId = ?').run(target.Id);

  console.log(`\n✅ Password reset for "${target.Username}"`);
  console.log(`   New password : ${newPassword}`);
  console.log(`   Role         : ${target.Role}`);
  console.log(`   Sessions revoked: ${revoked.changes}`);
  console.log(`\n🔐 Log in at: http://localhost:5174\n`);

  db.close();
}

main().catch(err => {
  console.error('\n❌ Unexpected error:', err.message);
  process.exit(1);
});
