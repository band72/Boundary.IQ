import fs from 'fs';
import path from 'path';

/**
 * Resolves a file path case-insensitively segment by segment on case-sensitive filesystems.
 * @param {string} fullPath The path to resolve.
 * @returns {string} The resolved path (with correct casing if it exists), or the original path as fallback.
 */
export function resolvePathCaseInsensitive(fullPath) {
  if (!fullPath) return fullPath;
  if (fs.existsSync(fullPath)) return fullPath;

  const resolvedPath = path.resolve(fullPath);
  const parts = resolvedPath.split(path.sep);
  let current = parts[0] === '' ? path.sep : parts[0];

  for (let i = (parts[0] === '' ? 1 : 1); i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;

    const nextPath = path.join(current, part);
    if (fs.existsSync(nextPath)) {
      current = nextPath;
    } else {
      try {
        if (!fs.existsSync(current)) return fullPath;
        const stat = fs.statSync(current);
        if (!stat.isDirectory()) return fullPath;

        const entries = fs.readdirSync(current);
        const partLower = part.toLowerCase();
        const matched = entries.find(e => e.toLowerCase() === partLower);
        if (matched) {
          current = path.join(current, matched);
        } else {
          // Not found even case-insensitively, return original path as fallback
          return fullPath;
        }
      } catch (err) {
        return fullPath;
      }
    }
  }
  return current;
}
