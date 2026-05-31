import 'dotenv/config';
import path from 'path';
import os from 'os';
import fs from 'fs';

function getAllowedRoots() {
  const envRoots = process.env.BOUNDARY_SCAN_ROOTS;
  console.log('Raw process.env.BOUNDARY_SCAN_ROOTS:', JSON.stringify(envRoots));
  if (envRoots) return envRoots.split(';').filter(Boolean).map(r => path.resolve(r.trim()));
  return [os.homedir()];
}

function validatePath(p) {
  if (!p) return null;
  if (p.includes('..')) return null;

  let normalized = p;
  // Translate developer's home folder to current user's home folder
  if (normalized.includes('/home/bando')) {
    normalized = normalized.replace('/home/bando', os.homedir());
  }

  // Translate /home/artwalk/Downloads/TrainPDF or /home/artwalk/Downloads/Legal Descriptions
  // to their actual locations under the extracted training folder if the directly requested ones don't exist
  if (!fs.existsSync(normalized)) {
    if (normalized.includes('/Downloads/TrainPDF')) {
      const candidate = normalized.replace('/Downloads/TrainPDF', '/Downloads/training-20260530T124201Z-3-001/training/TrainPDF');
      if (fs.existsSync(candidate)) normalized = candidate;
    } else if (normalized.includes('/Downloads/Legal Descriptions')) {
      const candidate = normalized.replace('/Downloads/Legal Descriptions', '/Downloads/training-20260530T124201Z-3-001/training/Legal Descriptions');
      if (fs.existsSync(candidate)) normalized = candidate;
    }
  }

  const resolved = path.resolve(normalized);
  const roots = getAllowedRoots();
  for (const root of roots) {
    if (resolved.startsWith(root)) return resolved;
  }
  return null;
}

const testPath = '/home/bando/Downloads/TrainPDF/Regency-Title';
console.log('Validating bando path:', validatePath(testPath));
