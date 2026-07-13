/**
 * db/core.js — Database connection, initialization, migrations, and shared helpers.
 *
 * This module owns the single database instance / connection pool. All other db/*
 * modules import `query()` to execute queries — never run queries on their own connection.
 */

import Database from 'better-sqlite3';
import pg from 'pg';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { DATABASE_PATH, DATABASE_URL } from '../../config.js';
import { downloadDb, uploadDb } from './persistence.js';
import pgConnectionString from 'pg-connection-string';

let db = null;
let pool = null;
let isPostgres = false;
let dbPath = '';

const COLUMN_CASING_MAP = {
  batchid: 'BatchId',
  timestamp: 'Timestamp',
  totalfiles: 'TotalFiles',
  passrate: 'PassRate',
  userid: 'UserId',
  id: 'Id',
  filename: 'FileName',
  parcelname: 'ParcelName',
  geocallcount: 'GeoCallCount',
  linearerror: 'LinearError',
  precisionratio: 'PrecisionRatio',
  status: 'Status',
  repairstageused: 'RepairStageUsed',
  extractionjson: 'ExtractionJson',
  traversejson: 'TraverseJson',
  agentturnsjson: 'AgentTurnsJson',
  trustscore: 'TrustScore',
  solutionstepsjson: 'SolutionStepsJson',
  filehash: 'FileHash',
  referencepointname: 'ReferencePointName',
  referencepointnorthing: 'ReferencePointNorthing',
  referencepointeasting: 'ReferencePointEasting',
  pobnorthing: 'PobNorthing',
  pobeasting: 'PobEasting',
  problemname: 'ProblemName',
  solutionapplied: 'SolutionApplied',
  successcount: 'SuccessCount',
  username: 'Username',
  passwordhash: 'PasswordHash',
  role: 'Role',
  plan: 'Plan',
  lastlogin: 'LastLogin',
  displayname: 'DisplayName',
  avatarurl: 'AvatarUrl',
  forceresetpw: 'ForceResetPw',
  token: 'Token',
  expiresat: 'ExpiresAt',
  useragent: 'UserAgent',
  ipaddress: 'IpAddress',
  createdat: 'CreatedAt',
  stripecustomerid: 'StripeCustomerId',
  stripesubscriptionid: 'StripeSubscriptionId',
  updatedat: 'UpdatedAt',
  periodend: 'PeriodEnd',
  date: 'Date',
  deedsolves: 'DeedSolves',
  provider: 'Provider',
  model: 'Model',
  inputtokens: 'InputTokens',
  outputtokens: 'OutputTokens',
  totaltokens: 'TotalTokens',
  type: 'Type',
  actorid: 'ActorId',
  action: 'Action',
  target: 'Target',
  detail: 'Detail',
  createdbyuserid: 'CreatedByUserId',
  email: 'Email',
  note: 'Note',
  usedbyuserid: 'UsedByUserId',
  usedat: 'UsedAt',
  activeprovider: 'ActiveProvider',
  activemodel: 'ActiveModel',
  openaibaseurl: 'OpenaiBaseUrl',
  allowapifallback: 'AllowApiFallback',
  enforcenoselfintersection: 'EnforceNoSelfIntersection',
  geminiapikey: 'GeminiApiKey',
  openaiapikey: 'OpenaiApiKey',
  mappansensitivity: 'MapPanSensitivity',
  code: 'Code',
  attempts: 'Attempts',
  invitetoken: 'InviteToken',
  keyhash: 'KeyHash',
  redeemedbyuserid: 'RedeemedByUserId',
  redeemedat: 'RedeemedAt',
  rawkey: 'RawKey',
  dailydeedlimit: 'DailyDeedLimit',
  price: 'Price',
  features: 'Features',
  description: 'Description',
  avgprecision: 'avgPrecision',
  bestprecision: 'bestPrecision',
  avglinearerr: 'avgLinearErr',
  maxlinearerr: 'maxLinearErr',
  avgtrustscore: 'avgTrustScore',
  avgclosure: 'avgClosure',
  maxclosure: 'maxClosure',
  avgprecisionratio: 'avgPrecisionRatio',
  maxprecisionratio: 'maxPrecisionRatio',
  c: 'c',
};

function normalizeRow(row) {
  if (!row) return row;
  const normalized = { ...row };
  for (const key of Object.keys(row)) {
    const lowerKey = key.toLowerCase();
    const targetKey = COLUMN_CASING_MAP[lowerKey];
    if (targetKey && targetKey !== key) {
      normalized[targetKey] = row[key];
    }
  }
  return normalized;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Returns the current time as a sortable ISO-like string (SQLite TEXT / Postgres TIMESTAMP). */
export function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 23);
}

/** Returns the shared db instance. Throws if init() has not been called. */
export function getDb() {
  if (isPostgres) throw new Error('Using PostgreSQL connection pool. Do not use getDb() direct reference.');
  if (!db) throw new Error('Database not initialized. Call init() first.');
  return db;
}

export function getDbPath() {
  return dbPath;
}

export function getIsPostgres() {
  return isPostgres;
}

// ── Unified Asynchronous Query Interface ──────────────────────────────────────

function translateQuery(sql) {
  let index = 1;
  return sql.replace(/\?/g, () => `$${index++}`);
}

export async function query(sql, params = []) {
  if (isPostgres) {
    const translatedSql = translateQuery(sql);
    const res = await pool.query(translatedSql, params);
    return {
      rows: res.rows.map(normalizeRow),
      changes: res.rowCount,
    };
  } else {
    if (!db) throw new Error('Database not initialized. Call init() first.');
    const stmt = db.prepare(sql);
    const isSelectOrReturning = /^\s*(SELECT|WITH)/i.test(sql) || /RETURNING/i.test(sql);
    if (isSelectOrReturning) {
      const rows = stmt.all(...params);
      return { rows: rows.map(normalizeRow), changes: 0 };
    } else {
      const info = stmt.run(...params);
      return { rows: [], changes: info.changes, lastInsertRowid: info.lastInsertRowid };
    }
  }
}

// ── DDL Syntax Translator ────────────────────────────────────────────────────

function translateDdlForPostgres(ddl) {
  return ddl
    .replace(/INTEGER PRIMARY KEY AUTOINCREMENT/gi, 'SERIAL PRIMARY KEY')
    .replace(/COLLATE NOCASE/gi, '')
    .replace(/TEXT\s+PRIMARY\s+KEY\s+COLLATE\s+NOCASE/gi, 'TEXT PRIMARY KEY')
    .replace(/ExtractionJson TEXT/gi, 'ExtractionJson JSONB')
    .replace(/TraverseJson TEXT/gi, 'TraverseJson JSONB')
    .replace(/AgentTurnsJson TEXT/gi, 'AgentTurnsJson JSONB')
    .replace(/SolutionStepsJson TEXT/gi, 'SolutionStepsJson JSONB')
    .replace(/Features TEXT/gi, 'Features JSONB');
}

// ── Initialization ────────────────────────────────────────────────────────────

export async function init() {
  if (DATABASE_URL && (DATABASE_URL.startsWith('postgres://') || DATABASE_URL.startsWith('postgresql://'))) {
    isPostgres = true;
    console.log('Connecting to PostgreSQL database...');
    const config = pgConnectionString.parse(DATABASE_URL);
    delete config.sslmode;
    config.ssl = { rejectUnauthorized: false };
    pool = new pg.Pool(config);
    // Test connection
    await pool.query('SELECT NOW()');
    console.log('✓ PostgreSQL connected successfully.');

    await _initializeSchema();
    await _runMigrations();
    await _seedHeuristics();
    await _seedPlanSettings();

    // Setup periodic log purging every 24 h
    setTimeout(() => _purgeOldLogs(90), 5000);
    setInterval(() => _purgeOldLogs(90), 24 * 60 * 60 * 1000);
  } else {
    isPostgres = false;
    if (DATABASE_PATH) {
      dbPath = path.resolve(DATABASE_PATH);
    } else {
      const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
      const folder = path.join(configDir, 'BoundaryQC');
      dbPath = path.join(folder, 'BoundaryQCDiagnostics.db');
    }

    const parent = path.dirname(dbPath);
    fs.mkdirSync(parent, { recursive: true });

    try {
      await downloadDb(dbPath);
    } catch (err) {
      console.error('Failed to download database backup from GCS:', err);
    }

    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    await _initializeSchema();
    await _runMigrations();
    await _seedHeuristics();
    await _seedPlanSettings();

    // Setup periodic database backup to GCS every 30 seconds
    setInterval(async () => {
      try {
        await uploadDb(db, dbPath);
      } catch (err) {
        console.error('Periodic database backup upload to GCS failed:', err);
      }
    }, 30000);

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

    setTimeout(() => _purgeOldLogs(90), 5000);
    setInterval(() => _purgeOldLogs(90), 24 * 60 * 60 * 1000);
  }
}

export function switchDbPath(newPath) {
  if (isPostgres) {
    console.warn('Database is in PostgreSQL mode; switchDbPath is ignored.');
    return;
  }
  if (!newPath) throw new Error('New database path cannot be empty.');
  const resolved = path.resolve(newPath);
  const parent = path.dirname(resolved);
  fs.mkdirSync(parent, { recursive: true });

  if (db) db.close();

  dbPath = resolved;
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  _initializeSchemaSync();
  _runMigrationsSync();
  _seedHeuristicsSync();
  _seedPlanSettingsSync();
  console.log(`✓ SQLite Database path successfully switched to: ${dbPath}`);
}

// ── Schema & migrations ───────────────────────────────────────────────────────

async function _initializeSchema() {
  if (!isPostgres) {
    try {
      const check = db.prepare('PRAGMA integrity_check').all();
      if (check.some(row => row.integrity_check !== 'ok')) {
        console.warn('Database corruption detected! Dropping corrupted AuditLog table to recover.');
        db.prepare('DROP TABLE IF EXISTS AuditLog').run();
      }
    } catch (err) {
      console.error('Failed to run integrity check', err);
    }
  }

  const ddl = `
    CREATE TABLE IF NOT EXISTS BatchRuns (
      BatchId TEXT PRIMARY KEY,
      Timestamp TEXT NOT NULL,
      TotalFiles INTEGER NOT NULL,
      PassRate REAL NOT NULL,
      UserId INTEGER
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
  `;

  if (isPostgres) {
    const postgresDdl = translateDdlForPostgres(ddl);
    await pool.query(postgresDdl);
  } else {
    db.exec(ddl);
  }
}

// Synchronous fallback for switchDbPath (SQLite only)
function _initializeSchemaSync() {
  _initializeSchema().catch(console.error);
}

async function _runMigrations() {
  let appliedMigrations = new Set();
  if (isPostgres) {
    const res = await pool.query('SELECT Name FROM _Migrations');
    appliedMigrations = new Set(res.rows.map(r => r.name || r.Name));
  } else {
    appliedMigrations = new Set(
      db.prepare('SELECT Name FROM _Migrations').all().map(r => r.Name)
    );
  }

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

  if (isPostgres) {
    for (const m of migrations) {
      if (!appliedMigrations.has(m.name)) {
        const client = await pool.connect();
        try {
          try {
            await client.query(translateDdlForPostgres(m.sql));
          } catch (e) {
            // 42701 is duplicate column, 42P07 is duplicate table
            if (e.code !== '42701' && e.code !== '42P07' && !e.message.includes('already exists')) {
              throw e;
            }
          }
          await client.query('INSERT INTO _Migrations (Name, AppliedAt) VALUES ($1, $2) ON CONFLICT (Name) DO NOTHING', [m.name, now()]);
          console.log(`  ✓ Migration applied: ${m.name}`);
        } catch (err) {
          console.error(`Failed to apply migration ${m.name}:`, err);
        } finally {
          client.release();
        }
      }
    }

    const rlsMigrationName = 'enable_rls_all_tables';
    if (!appliedMigrations.has(rlsMigrationName)) {
      const client = await pool.connect();
      try {
        const tables = [
          'BatchRuns', 'DeedLogs', 'HeuristicTracking', 'Users', 'Sessions',
          'Subscriptions', 'UsageTracking', 'TokenUsage', 'AuditLog',
          'InviteTokens', 'UserSettings', '_Migrations', 'PendingRegistrations',
          'LicenseKeys', 'PlanSettings'
        ];
        for (const t of tables) {
          try {
            await client.query(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY;`);
          } catch (e) {
            console.error(`Failed to enable RLS on ${t}:`, e.message);
          }
        }
        await client.query('INSERT INTO _Migrations (Name, AppliedAt) VALUES ($1, $2) ON CONFLICT (Name) DO NOTHING', [rlsMigrationName, now()]);
        console.log(`  ✓ Migration applied: ${rlsMigrationName}`);
      } catch (err) {
        console.error(`Failed to apply migration ${rlsMigrationName}:`, err);
      } finally {
        client.release();
      }
    }
  } else {
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
}

function _runMigrationsSync() {
  _runMigrations().catch(console.error);
}

async function _seedHeuristics() {
  let count = 0;
  if (isPostgres) {
    const res = await pool.query('SELECT COUNT(*) as c FROM HeuristicTracking');
    count = parseInt(res.rows[0].c || res.rows[0].C || 0);
  } else {
    count = db.prepare('SELECT COUNT(*) as c FROM HeuristicTracking').get().c;
  }

  if (count === 0) {
    const seedData = [
      ['Sequence Out of Order', 'Moore-Neighbor Rearrange'],
      ['Intersecting Boundary', 'Bowtie Inversion Auto-Fix'],
      ['Ambiguous Arc Concavity', 'Convexity Right Turn Rule'],
      ['Shoreline Centerline Meanders', 'Shoreline Gap Solver'],
      ['Pixel Dimension guessing', 'Explicit Chord Parsing'],
    ];

    for (const [p, s] of seedData) {
      await query('INSERT INTO HeuristicTracking (ProblemName, SolutionApplied, SuccessCount) VALUES (?, ?, 0)', [p, s]);
    }
  }
}

function _seedHeuristicsSync() {
  _seedHeuristics().catch(console.error);
}

async function _seedPlanSettings() {
  let count = 0;
  if (isPostgres) {
    const res = await pool.query('SELECT COUNT(*) as c FROM PlanSettings');
    count = parseInt(res.rows[0].c || res.rows[0].C || 0);
  } else {
    count = db.prepare('SELECT COUNT(*) as c FROM PlanSettings').get().c;
  }

  if (count === 0) {
    await query('INSERT INTO PlanSettings (Plan, Name, DailyDeedLimit, Price, Features, Description) VALUES (?, ?, ?, ?, ?, ?)',
      ['free', 'Free', 5, 0, JSON.stringify(['5 deed solves/day', 'Traverse Compute', 'Legal Writer', 'Basic Dashboard']), 'Basic free tier for lightweight needs.']
    );
    await query('INSERT INTO PlanSettings (Plan, Name, DailyDeedLimit, Price, Features, Description) VALUES (?, ?, ?, ?, ?, ?)',
      ['basic', 'Basic', 25, 500, JSON.stringify(['25 deed solves/day', 'Traverse Compute (full)', 'Legal Writer (pro)', 'Batch Deed processing (basic)']), 'Great for small teams or individual surveyors.']
    );
    await query('INSERT INTO PlanSettings (Plan, Name, DailyDeedLimit, Price, Features, Description) VALUES (?, ?, ?, ?, ?, ?)',
      ['pro', 'Pro', 50, 1999, JSON.stringify(['50 deed solves/day', 'Full Batch Deed processing', 'Plat Extraction with AI', 'Full Analytics Dashboard', 'Priority support']), 'Our most popular plan for professional workflows.']
    );
    await query('INSERT INTO PlanSettings (Plan, Name, DailyDeedLimit, Price, Features, Description) VALUES (?, ?, ?, ?, ?, ?)',
      ['enterprise', 'Enterprise', 100, 9900, JSON.stringify(['100 deed solves/day', '5 team members', 'Custom AI model configuration', 'Full REST API access', 'Dedicated SLA support']), 'For corporate and larger engineering operations.']
    );
  } else {
    // Enforce updated limits on existing installations
    await query("UPDATE PlanSettings SET DailyDeedLimit = 25, Features = '[\"25 deed solves/day\",\"Traverse Compute (full)\",\"Legal Writer (pro)\",\"Batch Deed processing (basic)\"]' WHERE Plan = 'basic'");
    await query("UPDATE PlanSettings SET DailyDeedLimit = 50, Features = '[\"50 deed solves/day\",\"Full Batch Deed processing\",\"Plat Extraction with AI\",\"Full Analytics Dashboard\",\"Priority support\"]' WHERE Plan = 'pro'");
    await query("UPDATE PlanSettings SET DailyDeedLimit = 100, Features = '[\"100 deed solves/day\",\"5 team members\",\"Custom AI model configuration\",\"Full REST API access\",\"Dedicated SLA support\"]' WHERE Plan = 'enterprise'");
  }
}

function _seedPlanSettingsSync() {
  _seedPlanSettings().catch(console.error);
}

async function _purgeOldLogs(retentionDays) {
  const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString().replace('T', ' ').slice(0, 19);
  await query('DELETE FROM DeedLogs WHERE Timestamp < ?', [cutoff]);
  await query('DELETE FROM BatchRuns WHERE Timestamp < ?', [cutoff]);
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
