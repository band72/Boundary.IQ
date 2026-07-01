#!/usr/bin/env node
import 'dotenv/config';
import { createRequire } from 'module';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const PBKDF2_ITERATIONS = 310_000;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function getDbPath() {
  const envPath = process.env.DIAGNOSTICS_DB_PATH || process.env.DB_PATH;
  if (envPath) return path.resolve(envPath);
  const configDir = process.env.APPDATA ||
    (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : path.join(os.homedir(), '.config'));
  return path.join(configDir, 'BoundaryQC', 'BoundaryQCDiagnostics.db');
}

async function main() {
  const dbPath = getDbPath();
  const db = new Database(dbPath);

  const username = process.argv[2];
  const password = process.argv[3];
  const email = process.argv[4];

  if (!username || !password) {
    console.log('❌ Error: username and password are required.');
    console.log('Usage: node server/scripts/create-admin.js <username> <password> [email]');
    process.exit(1);
  }

  const passwordHash = hashPassword(password);
  const nowStr = new Date().toISOString();

  try {
    db.prepare(`
      INSERT INTO Users (Username, PasswordHash, Role, Plan, Timestamp)
      VALUES (?, ?, 'admin', 'enterprise', ?)
    `).run(username, passwordHash, nowStr);
    console.log(`✅ Admin user "${username}" successfully created with role=admin, plan=enterprise`);
  } catch (e) {
    if (e.message.includes('UNIQUE constraint failed')) {
      db.prepare(`
        UPDATE Users SET PasswordHash = ?, Role = 'admin', Plan = 'enterprise' WHERE Username = ?
      `).run(passwordHash, username);
      console.log(`✅ Existing user "${username}" promoted to admin, plan=enterprise, password updated`);
    } else {
      console.error('❌ Failed to create admin account:', e.message);
      process.exit(1);
    }
  } finally {
    db.close();
  }
}

main().catch(err => {
  console.error('❌ Unexpected error:', err.message);
  process.exit(1);
});
