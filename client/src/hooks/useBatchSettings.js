/**
 * useBatchSettings — centralized localStorage state for all BatchDeedTab settings.
 *
 * Replaces the ~9 scattered localStorage.getItem() calls (some duplicated on
 * every render) across BatchDeedTab.jsx and PrintBlueprint.jsx with a single
 * hook that reads all keys once on mount and exposes a unified setter.
 *
 * PERF-5: Eliminates repeated synchronous localStorage reads per render.
 */
import { useState, useCallback } from 'react';

const KEYS = {
  autoOutput:          'boundaryiq_auto_output',
  shortFileNames:      'boundaryiq_short_file_names',
  showConceptualDetail:'boundaryiq_show_conceptual_detail',
  blueprintTheme:      'boundaryiq_blueprint_theme',
  folderPath:          'boundaryiq_folder_path',
};

function readBool(key, defaultValue = true) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return defaultValue;
    return JSON.parse(raw);
  } catch {
    return defaultValue;
  }
}

function readString(key, defaultValue = '') {
  try {
    return localStorage.getItem(key) ?? defaultValue;
  } catch {
    return defaultValue;
  }
}

/**
 * @returns {{
 *   autoOutput: boolean,
 *   shortFileNames: boolean,
 *   showConceptualDetail: boolean,
 *   blueprintTheme: boolean,
 *   folderPath: string,
 *   setSetting: (key: keyof typeof KEYS, value: any) => void,
 * }}
 */
export function useBatchSettings() {
  const [settings, setSettings] = useState(() => ({
    autoOutput:           readBool(KEYS.autoOutput, true),
    shortFileNames:       readBool(KEYS.shortFileNames, true),
    showConceptualDetail: readBool(KEYS.showConceptualDetail, true),
    blueprintTheme:       readBool(KEYS.blueprintTheme, false),
    folderPath:           readString(KEYS.folderPath, ''),
  }));

  const setSetting = useCallback((key, value) => {
    const storageKey = KEYS[key];
    if (!storageKey) {
      console.warn(`useBatchSettings: unknown key "${key}"`);
      return;
    }
    try {
      if (typeof value === 'boolean' || typeof value === 'number') {
        localStorage.setItem(storageKey, JSON.stringify(value));
      } else {
        localStorage.setItem(storageKey, value);
      }
    } catch (e) {
      console.warn('useBatchSettings: localStorage write failed:', e.message);
    }
    setSettings(prev => ({ ...prev, [key]: value }));
  }, []);

  return { ...settings, setSetting };
}
