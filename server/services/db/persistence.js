import { GoogleAuth } from 'google-auth-library';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import logger from '../../logger.js';

const BUCKET_NAME = 'boundary-iq-db-318563891368';
const OBJECT_NAME = 'diagnostics.db';

let lastBackupTime = 0;
const BACKUP_DEBOUNCE_MS = 10000; // debounce backups to prevent spamming GCS

async function getAccessToken() {
  // Only attempt to authenticate and sync with GCS if running in Cloud Run,
  // or if explicitly requested via environment variable.
  if (!process.env.K_SERVICE && !process.env.ENABLE_GCS_SYNC) {
    return null;
  }

  try {
    const auth = new GoogleAuth({
      scopes: 'https://www.googleapis.com/auth/devstorage.read_write',
    });
    const client = await auth.getClient();
    const tokenResponse = await client.getAccessToken();
    return tokenResponse.token;
  } catch (e) {
    try {
      return execSync('gcloud auth print-access-token').toString().trim();
    } catch (err) {
      logger.warn('Could not acquire Google access token. GCS sync will be disabled.');
      return null;
    }
  }
}

/**
 * Downloads the database backup from GCS if it exists, writing it to targetPath.
 */
export async function downloadDb(targetPath) {
  const token = await getAccessToken();
  if (!token) return false;

  logger.info(`Checking GCS for database backup in gs://${BUCKET_NAME}/${OBJECT_NAME}...`);
  const url = `https://storage.googleapis.com/storage/v1/b/${BUCKET_NAME}/o/${encodeURIComponent(OBJECT_NAME)}?alt=media`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (response.status === 404) {
      logger.info('No existing database backup found on GCS. Starting with a fresh database.');
      return false;
    }

    if (!response.ok) {
      const errorText = await response.text();
      logger.error({ error: errorText, status: response.status }, 'Failed to download database from GCS');
      return false;
    }

    const parent = path.dirname(targetPath);
    fs.mkdirSync(parent, { recursive: true });

    const buffer = await response.arrayBuffer();
    fs.writeFileSync(targetPath, Buffer.from(buffer));
    logger.info(`✓ Successfully restored database from GCS to ${targetPath}`);
    return true;
  } catch (err) {
    logger.error({ err }, 'Error downloading database from GCS');
    return false;
  }
}

/**
 * Backs up the SQLite database and uploads it to GCS.
 */
export async function uploadDb(db, dbPath, force = false) {
  const now = Date.now();
  if (!force && (now - lastBackupTime < BACKUP_DEBOUNCE_MS)) {
    return;
  }
  lastBackupTime = now;

  const token = await getAccessToken();
  if (!token) return;

  const tempBackupPath = `${dbPath}.tmp_backup`;
  try {
    logger.debug('Creating SQLite backup file...');
    await db.backup(tempBackupPath);

    logger.debug('Uploading SQLite backup to GCS...');
    const url = `https://storage.googleapis.com/upload/storage/v1/b/${BUCKET_NAME}/o?uploadType=media&name=${encodeURIComponent(OBJECT_NAME)}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
      },
      body: fs.readFileSync(tempBackupPath),
    });

    if (!response.ok) {
      const errText = await response.text();
      logger.error({ status: response.status, response: errText }, 'Failed to upload database backup to GCS');
    } else {
      logger.info('✓ SQLite database backup successfully uploaded to GCS');
    }
  } catch (err) {
    logger.error({ err }, 'Error during SQLite database backup/upload');
  } finally {
    if (fs.existsSync(tempBackupPath)) {
      try {
        fs.unlinkSync(tempBackupPath);
      } catch (e) {}
    }
  }
}
