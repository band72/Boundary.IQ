import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';

const configDir = path.join(os.homedir(), '.config');
const oldPath = path.join(configDir, 'BoundaryQC', 'BoundaryQCDiagnostics.db');
const tempPath = '/tmp/repaired.db';

if (fs.existsSync(tempPath)) {
  fs.unlinkSync(tempPath);
}

console.log('Connecting to old DB:', oldPath);
const oldDb = new Database(oldPath);

console.log('Creating new DB:', tempPath);
const newDb = new Database(tempPath);
newDb.pragma('journal_mode = WAL');

// Get all user tables
const tables = oldDb.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();

for (const t of tables) {
  console.log(`Creating table ${t.name}...`);
  try {
    newDb.exec(t.sql);
  } catch (err) {
    console.error(`Failed to create table ${t.name}: ${err.message}`);
  }
}

newDb.pragma('foreign_keys = OFF');

for (const t of tables) {
  const table = t.name;
  try {
    // Inspect table info
    const columnsInfo = oldDb.prepare(`PRAGMA table_info(${table})`).all();
    const defaults = {};
    const pkCols = [];
    for (const col of columnsInfo) {
      if (col.pk) {
        pkCols.push(col.name);
      }
      if (col.notnull) {
        if (col.dflt_value !== null) {
          defaults[col.name] = col.dflt_value;
        } else {
          // Infer type-based default
          const type = (col.type || '').toUpperCase();
          if (type.includes('INT') || type.includes('NUM') || type.includes('REAL') || type.includes('DOUBLE')) {
            defaults[col.name] = 0;
          } else if (type.includes('CHAR') || type.includes('TEXT') || type.includes('CLOB')) {
            if (col.name.toLowerCase().includes('time') || col.name.toLowerCase().includes('date')) {
              defaults[col.name] = new Date().toISOString();
            } else {
              defaults[col.name] = '';
            }
          } else {
            defaults[col.name] = '';
          }
        }
      }
    }

    const rows = oldDb.prepare(`SELECT * FROM ${table}`).all();
    console.log(`Copying ${rows.length} rows from table ${table}...`);
    if (rows.length === 0) continue;

    const cols = Object.keys(rows[0]);
    const placeholders = cols.map(() => '?').join(', ');
    const insertStmt = newDb.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`);

    const insertedKeys = new Set();

    const transaction = newDb.transaction((data) => {
      for (const row of data) {
        // Build primary key identifier to detect corrupt duplicates
        let pkKey = '';
        if (pkCols.length > 0) {
          pkKey = pkCols.map(c => String(row[c])).join('|');
        } else {
          pkKey = cols.map(c => String(row[c])).join('|');
        }

        if (insertedKeys.has(pkKey)) {
          console.log(`  -> Skipping corrupt duplicate row in ${table}: ${pkKey}`);
          continue;
        }
        insertedKeys.add(pkKey);

        const values = cols.map(c => {
          let val = row[c];
          if (val === null || val === undefined) {
            if (c in defaults) {
              val = defaults[c];
            }
          }
          return val;
        });
        insertStmt.run(...values);
      }
    });

    transaction(rows);
    console.log(`✓ Table ${table} successfully copied.`);
  } catch (err) {
    console.error(`❌ Failed to copy table ${table}: ${err.message}`);
  }
}

newDb.pragma('foreign_keys = ON');

// Check integrity of new DB
const integrity = newDb.prepare('PRAGMA integrity_check').get();
console.log('New DB integrity:', integrity);

oldDb.close();
newDb.close();

if (integrity.integrity_check === 'ok') {
  console.log('Copying new DB over old DB...');
  fs.copyFileSync(tempPath, oldPath);
  console.log('✓ Local database successfully repaired.');
} else {
  console.error('❌ Repaired database failed integrity check!');
  process.exit(1);
}
