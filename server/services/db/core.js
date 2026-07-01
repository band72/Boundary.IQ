/**
 * db/core.js — Database connection, initialization, migrations, and shared helpers.
 *
 * This module owns the single `db` instance. All other db/* modules import
 * `getDb()` to access it — never open their own connection.
 */

import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { DATABASE_PATH } from '../../config.js';
import { downloadDb, uploadDb } from './persistence.js';

let db = null;
let dbPath = '';

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Returns the current time as a sortable ISO-like string (SQLite TEXT). */
export function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

/** Returns the shared db instance. Throws if init() has not been called. */
export function getDb() {
  if (!db) throw new Error('Database not initialized. Call init() first.');
  return db;
}

export function getDbPath() {
  return dbPath;
}

// ── Initialization ────────────────────────────────────────────────────────────

export async function init() {
  if (DATABASE_PATH) {
    dbPath = path.resolve(DATABASE_PATH);
  } else {
    // Keep the same path as the original C# version for backwards compatibility
    const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    const folder = path.join(configDir, 'BoundaryQC');
    dbPath = path.join(folder, 'BoundaryQCDiagnostics.db');
  }

  const parent = path.dirname(dbPath);
  fs.mkdirSync(parent, { recursive: true });

  // Download the database backup from GCS prior to opening
  try {
    await downloadDb(dbPath);
  } catch (err) {
    console.error('Failed to download database backup from GCS:', err);
  }

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  _initializeSchema();
  _runMigrations();
  _seedHeuristics();
  _seedPlanSettings();

  // Setup periodic database backup to GCS every 30 seconds
  setInterval(async () => {
    try {
      await uploadDb(db, dbPath);
    } catch (err) {
      console.error('Periodic database backup upload to GCS failed:', err);
    }
  }, 30000);

  // Setup process exit/termination signal handlers to perform a final backup
  const handleExitSignal = async (signal) => {
    console.log(`\nReceived ${signal} - performing final database backup to GCS...`);
    if (db) {
      try {
        await uploadDb(db, dbPath, true);
        console.log('✓ Final database backup completed successfully.');
      } catch (err) {
        console.error('Final database backup upload to GCS failed:', err);
      }
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => handleExitSignal('SIGTERM'));
  process.on('SIGINT', () => handleExitSignal('SIGINT'));

  // Purge old logs once on startup (deferred 5 s to avoid blocking boot),
  // then every 24 h. Prevents startup latency on large databases.
  setTimeout(() => _purgeOldLogs(90), 5000);
  setInterval(() => _purgeOldLogs(90), 24 * 60 * 60 * 1000);
}

export function switchDbPath(newPath) {
  if (!newPath) throw new Error('New database path cannot be empty.');
  const resolved = path.resolve(newPath);
  const parent = path.dirname(resolved);
  fs.mkdirSync(parent, { recursive: true });

  if (db) db.close();

  dbPath = resolved;
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  _initializeSchema();
  _runMigrations();
  _seedHeuristics();
  _seedPlanSettings();
  console.log(`✓ SQLite Database path successfully switched to: ${dbPath}`);
}

// ── Schema & migrations ───────────────────────────────────────────────────────

function _initializeSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS BatchRuns (
      BatchId TEXT PRIMARY KEY,
      Timestamp TEXT NOT NULL,
      TotalFiles INTEGER NOT NULL,
      PassRate REAL NOT NULL,
      UserId INTEGER,
      FOREIGN KEY (UserId) REFERENCES Users(Id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS DeedLogs (
      Id INTEGER PRIMARY KEY AUTOINCREMENT,
      BatchId TEXT NOT NULL,
      FileName TEXT NOT NULL COLLATE NOCASE,
      ParcelName TEXT,
      GeoCallCount INTEGER NOT NULL,
      LinearError REAL NOT NULL,
      PrecisionRatio REAL NOT NULL,
      Status TEXT NOT NULL COLLATE NOCASE,
      RepairStageUsed TEXT,
      Timestamp TEXT NOT NULL,
      ExtractionJson TEXT,
      TraverseJson TEXT,
      AgentTurnsJson TEXT,
      TrustScore REAL,
      SolutionStepsJson TEXT,
      FileHash TEXT,
      FOREIGN KEY (BatchId) REFERENCES BatchRuns(BatchId)
    );

    CREATE TABLE IF NOT EXISTS HeuristicTracking (
      Id INTEGER PRIMARY KEY AUTOINCREMENT,
      ProblemName TEXT NOT NULL,
      SolutionApplied TEXT NOT NULL,
      SuccessCount INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS Users (
      Id INTEGER PRIMARY KEY AUTOINCREMENT,
      Username TEXT UNIQUE NOT NULL COLLATE NOCASE,
      PasswordHash TEXT NOT NULL,
      Role TEXT NOT NULL DEFAULT 'user',
      Plan TEXT NOT NULL DEFAULT 'free',
      Timestamp TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS Sessions (
      Token TEXT PRIMARY KEY,
      UserId INTEGER NOT NULL,
      ExpiresAt TEXT NOT NULL,
      FOREIGN KEY (UserId) REFERENCES Users(Id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS Subscriptions (
      Id INTEGER PRIMARY KEY AUTOINCREMENT,
      UserId INTEGER UNIQUE NOT NULL,
      Plan TEXT NOT NULL DEFAULT 'free',
      StripeCustomerId TEXT,
      StripeSubscriptionId TEXT,
      Status TEXT NOT NULL DEFAULT 'inactive',
      PeriodEnd TEXT,
      UpdatedAt TEXT NOT NULL,
      FOREIGN KEY (UserId) REFERENCES Users(Id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS UsageTracking (
      Id INTEGER PRIMARY KEY AUTOINCREMENT,
      UserId INTEGER NOT NULL,
      Date TEXT NOT NULL,
      DeedSolves INTEGER NOT NULL DEFAULT 0,
      UNIQUE(UserId, Date),
      FOREIGN KEY (UserId) REFERENCES Users(Id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS TokenUsage (
      Id INTEGER PRIMARY KEY AUTOINCREMENT,
      UserId INTEGER,
      Provider TEXT NOT NULL,
      Model TEXT NOT NULL,
      InputTokens INTEGER NOT NULL DEFAULT 0,
      OutputTokens INTEGER NOT NULL DEFAULT 0,
      TotalTokens INTEGER NOT NULL DEFAULT 0,
      Type TEXT NOT NULL,
      Timestamp TEXT NOT NULL,
      FOREIGN KEY (UserId) REFERENCES Users(Id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS AuditLog (
      Id INTEGER PRIMARY KEY AUTOINCREMENT,
      UserId INTEGER,
      ActorId INTEGER,
      Action TEXT NOT NULL,
      Target TEXT,
      Detail TEXT,
      IpAddress TEXT,
      Timestamp TEXT NOT NULL,
      FOREIGN KEY (UserId) REFERENCES Users(Id) ON DELETE SET NULL,
      FOREIGN KEY (ActorId) REFERENCES Users(Id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS InviteTokens (
      Token TEXT PRIMARY KEY,
      CreatedByUserId INTEGER NOT NULL,
      Email TEXT,
      Note TEXT,
      UsedByUserId INTEGER,
      UsedAt TEXT,
      ExpiresAt TEXT NOT NULL,
      CreatedAt TEXT NOT NULL,
      FOREIGN KEY (CreatedByUserId) REFERENCES Users(Id) ON DELETE CASCADE,
      FOREIGN KEY (UsedByUserId) REFERENCES Users(Id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS UserSettings (
      UserId INTEGER PRIMARY KEY,
      ActiveProvider TEXT,
      ActiveModel TEXT,
      OpenaiBaseUrl TEXT,
      AllowApiFallback INTEGER,
      EnforceNoSelfIntersection INTEGER,
      GeminiApiKey TEXT,
      OpenaiApiKey TEXT,
      MapPanSensitivity REAL,
      FOREIGN KEY (UserId) REFERENCES Users(Id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS _Migrations (
      Name TEXT PRIMARY KEY,
      AppliedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS PendingRegistrations (
      Email TEXT PRIMARY KEY COLLATE NOCASE,
      Username TEXT NOT NULL,
      PasswordHash TEXT NOT NULL,
      Code TEXT NOT NULL,
      Attempts INTEGER NOT NULL DEFAULT 0,
      ExpiresAt TEXT NOT NULL,
      InviteToken TEXT,
      CreatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS LicenseKeys (
      KeyHash TEXT PRIMARY KEY,
      Plan TEXT NOT NULL DEFAULT 'pro',
      CreatedByUserId INTEGER,
      RedeemedByUserId INTEGER,
      RedeemedAt TEXT,
      ExpiresAt TEXT,
      Note TEXT,
      CreatedAt TEXT NOT NULL,
      FOREIGN KEY (CreatedByUserId) REFERENCES Users(Id) ON DELETE SET NULL,
      FOREIGN KEY (RedeemedByUserId) REFERENCES Users(Id) ON DELETE SET NULL
    );
  `);
}

function _runMigrations() {
  const appliedMigrations = new Set(
    db.prepare('SELECT Name FROM _Migrations').all().map(r => r.Name)
  );

  const migrations = [
    { name: 'add_ExtractionJson',          sql: 'ALTER TABLE DeedLogs ADD COLUMN ExtractionJson TEXT' },
    { name: 'add_TraverseJson',            sql: 'ALTER TABLE DeedLogs ADD COLUMN TraverseJson TEXT' },
    { name: 'add_AgentTurnsJson',          sql: 'ALTER TABLE DeedLogs ADD COLUMN AgentTurnsJson TEXT' },
    { name: 'add_TrustScore',              sql: 'ALTER TABLE DeedLogs ADD COLUMN TrustScore REAL' },
    { name: 'add_SolutionStepsJson',       sql: 'ALTER TABLE DeedLogs ADD COLUMN SolutionStepsJson TEXT' },
    { name: 'add_ReferencePointName',      sql: 'ALTER TABLE DeedLogs ADD COLUMN ReferencePointName TEXT COLLATE NOCASE' },
    { name: 'add_ReferencePointNorthing',  sql: 'ALTER TABLE DeedLogs ADD COLUMN ReferencePointNorthing REAL' },
    { name: 'add_ReferencePointEasting',   sql: 'ALTER TABLE DeedLogs ADD COLUMN ReferencePointEasting REAL' },
    { name: 'add_PobNorthing',             sql: 'ALTER TABLE DeedLogs ADD COLUMN PobNorthing REAL' },
    { name: 'add_PobEasting',              sql: 'ALTER TABLE DeedLogs ADD COLUMN PobEasting REAL' },
    { name: 'add_FileHash',                sql: 'ALTER TABLE DeedLogs ADD COLUMN FileHash TEXT' },
    { name: 'add_Users_Plan',              sql: "ALTER TABLE Users ADD COLUMN Plan TEXT NOT NULL DEFAULT 'free'" },
    { name: 'add_Users_LastLogin',         sql: 'ALTER TABLE Users ADD COLUMN LastLogin TEXT' },
    { name: 'add_Users_DisplayName',       sql: 'ALTER TABLE Users ADD COLUMN DisplayName TEXT' },
    { name: 'add_Users_AvatarUrl',         sql: 'ALTER TABLE Users ADD COLUMN AvatarUrl TEXT' },
    { name: 'add_Sessions_UserAgent',      sql: 'ALTER TABLE Sessions ADD COLUMN UserAgent TEXT' },
    { name: 'add_Sessions_IpAddress',      sql: 'ALTER TABLE Sessions ADD COLUMN IpAddress TEXT' },
    { name: 'add_Sessions_CreatedAt',      sql: 'ALTER TABLE Sessions ADD COLUMN CreatedAt TEXT' },
    { name: 'add_Users_ForceResetPw',      sql: 'ALTER TABLE Users ADD COLUMN ForceResetPw INTEGER NOT NULL DEFAULT 0' },
    { name: 'add_UserSettings_MapPanSensitivity', sql: 'ALTER TABLE UserSettings ADD COLUMN MapPanSensitivity REAL' },
    { name: 'create_TokenUsage_table', sql: 'CREATE TABLE IF NOT EXISTS TokenUsage (Id INTEGER PRIMARY KEY AUTOINCREMENT, UserId INTEGER, Provider TEXT NOT NULL, Model TEXT NOT NULL, InputTokens INTEGER NOT NULL DEFAULT 0, OutputTokens INTEGER NOT NULL DEFAULT 0, TotalTokens INTEGER NOT NULL DEFAULT 0, Type TEXT NOT NULL, Timestamp TEXT NOT NULL, FOREIGN KEY (UserId) REFERENCES Users(Id) ON DELETE CASCADE)' },
    { name: 'add_BatchRuns_UserId', sql: 'ALTER TABLE BatchRuns ADD COLUMN UserId INTEGER REFERENCES Users(Id) ON DELETE SET NULL' },
    { name: 'create_PlanSettings_table', sql: 'CREATE TABLE IF NOT EXISTS PlanSettings (Plan TEXT PRIMARY KEY, Name TEXT NOT NULL, DailyDeedLimit INTEGER NOT NULL DEFAULT -1, Price INTEGER NOT NULL DEFAULT 0, Features TEXT, Description TEXT)' },
    { name: 'add_LicenseKeys_RawKey', sql: 'ALTER TABLE LicenseKeys ADD COLUMN RawKey TEXT' },
  ];

  const applyMigration = db.transaction((m) => {
    try {
      db.exec(m.sql);
    } catch (e) {
      if (!e.message.includes('duplicate column name')) throw e;
    }
    db.prepare('INSERT OR IGNORE INTO _Migrations (Name, AppliedAt) VALUES (?, ?)').run(m.name, now());
  });

  for (const m of migrations) {
    if (!appliedMigrations.has(m.name)) {
      applyMigration(m);
      console.log(`  ✓ Migration applied: ${m.name}`);
    }
  }
}

function _seedHeuristics() {
  const count = db.prepare('SELECT COUNT(*) as c FROM HeuristicTracking').get().c;
  if (count === 0) {
    const insert = db.prepare('INSERT INTO HeuristicTracking (ProblemName, SolutionApplied, SuccessCount) VALUES (?, ?, 0)');
    const seedData = [
      ['Sequence Out of Order', 'Moore-Neighbor Rearrange'],
      ['Intersecting Boundary', 'Bowtie Inversion Auto-Fix'],
      ['Ambiguous Arc Concavity', 'Convexity Right Turn Rule'],
      ['Shoreline Centerline Meanders', 'Shoreline Gap Solver'],
      ['Pixel Dimension guessing', 'Explicit Chord Parsing'],
    ];
    for (const [p, s] of seedData) insert.run(p, s);
  }
}

function _seedPlanSettings() {
  const count = db.prepare('SELECT COUNT(*) as c FROM PlanSettings').get().c;
  if (count === 0) {
    const insert = db.prepare('INSERT INTO PlanSettings (Plan, Name, DailyDeedLimit, Price, Features, Description) VALUES (?, ?, ?, ?, ?, ?)');
    insert.run('free', 'Free', 5, 0, JSON.stringify(['5 deed solves/day', 'Traverse Compute', 'Legal Writer', 'Basic Dashboard']), 'Basic free tier for lightweight needs.');
    insert.run('basic', 'Basic', 50, 500, JSON.stringify(['50 deed solves/day', 'Traverse Compute (full)', 'Legal Writer (pro)', 'Batch Deed processing (basic)']), 'Great for small teams or individual surveyors.');
    insert.run('pro', 'Pro', -1, 1999, JSON.stringify(['Unlimited deed solves', 'Full Batch Deed processing', 'Plat Extraction with AI', 'Full Analytics Dashboard', 'Priority support']), 'Our most popular plan for professional workflows.');
    insert.run('enterprise', 'Enterprise', -1, 9900, JSON.stringify(['Everything in Pro', '5 team members', 'Custom AI model configuration', 'Full REST API access', 'Dedicated SLA support']), 'For corporate and larger engineering operations.');
  }
}

function _purgeOldLogs(retentionDays) {
  const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare('DELETE FROM DeedLogs WHERE Timestamp < ?').run(cutoff);
  db.prepare('DELETE FROM BatchRuns WHERE Timestamp < ?').run(cutoff);
}

// ── Shared row mapper ─────────────────────────────────────────────────────────

export function mapDeedLog(r) {
  return {
    id: r.Id, batchId: r.BatchId, fileName: r.FileName, parcelName: r.ParcelName,
    geoCallCount: r.GeoCallCount, linearError: r.LinearError, precisionRatio: r.PrecisionRatio,
    status: r.Status, repairStageUsed: r.RepairStageUsed, timestamp: r.Timestamp,
    extractionJson: r.ExtractionJson, traverseJson: r.TraverseJson,
    agentTurnsJson: r.AgentTurnsJson, trustScore: r.TrustScore,
    solutionStepsJson: r.SolutionStepsJson ?? null,
    referencePointName: r.ReferencePointName,
    referencePointNorthing: r.ReferencePointNorthing,
    referencePointEasting: r.ReferencePointEasting,
    pobNorthing: r.PobNorthing,
    pobEasting: r.PobEasting,
    fileHash: r.FileHash,
  };
}
