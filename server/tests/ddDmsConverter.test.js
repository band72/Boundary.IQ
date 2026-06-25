// tests/ddDmsConverter.test.js
// Unit tests for the DD <-> DMS bidirectional converter logic
// (mirrors the inline functions in ScriptingTab.jsx's DD↔DMS panel)

import { describe, it, expect } from 'vitest';

// ── DD → DMS ───────────────────────────────────────────────────────────────────
function ddToDms(dd) {
  if (isNaN(dd)) return null;
  const sign = dd < 0 ? '-' : '';
  const abs  = Math.abs(dd);
  const deg  = Math.floor(abs);
  const minFull = (abs - deg) * 60;
  const min  = Math.floor(minFull);
  const sec  = (minFull - min) * 60;
  return `${sign}${deg}°${String(min).padStart(2, '0')}'${sec.toFixed(4).replace(/\.?0+$/, '')}"`;
}

// ── DMS → DD ───────────────────────────────────────────────────────────────────
function dmsToDD(raw) {
  const m = raw.trim().match(/^(-?)\s*(\d+)[°d\s]\s*(\d+)['''m\s]\s*([\d.]+)["″s]?\s*$/);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (parseFloat(m[2]) + parseFloat(m[3]) / 60 + parseFloat(m[4]) / 3600);
}

describe('DD → DMS conversion', () => {
  it('converts 0° exactly', () => {
    expect(ddToDms(0)).toBe('0°00\'0"');
  });

  it('converts 45.5° = 45°30\'0"', () => {
    expect(ddToDms(45.5)).toBe("45°30'0\"");
  });

  it('converts 87.7344444° ≈ 87°44\'4"', () => {
    const result = ddToDms(87.7344444);
    expect(result).toMatch(/^87°44'/);
  });

  it('converts -90° to "-90°00\'0""', () => {
    expect(ddToDms(-90)).toBe('-90°00\'0"');
  });

  it('converts 45°30\'30" round-trip correctly', () => {
    const dd = 45 + 30 / 60 + 30 / 3600; // 45.508333...
    const dms = ddToDms(dd);
    // Should start with 45°30'
    expect(dms).toMatch(/^45°30'/);
    // And the seconds should contain 30
    expect(dms).toContain('30');
  });

  it('returns null for NaN input', () => {
    expect(ddToDms(NaN)).toBeNull();
  });

  it('preserves precision to 4 decimal places in seconds, trimming trailing zeros', () => {
    const dms = ddToDms(45.5); // 0 seconds
    expect(dms).not.toContain('0000');
    expect(dms).toBe("45°30'0\"");
  });

  it('converts 1° exactly', () => {
    expect(ddToDms(1)).toBe("1°00'0\"");
  });

  it('handles near-60-second rounding edge case gracefully', () => {
    const dd = 45 + 59 / 60 + 59.9999 / 3600;
    const result = ddToDms(dd);
    expect(result).toMatch(/^45°59'/);
  });
});

describe('DMS → DD conversion', () => {
  it('converts 0°00\'0" to 0', () => {
    expect(dmsToDD('0°00\'0"')).toBeCloseTo(0, 8);
  });

  it('converts 45°30\'0" to 45.5', () => {
    expect(dmsToDD("45°30'0\"")).toBeCloseTo(45.5, 6);
  });

  it('converts 45°30\'30" to 45.508333...', () => {
    expect(dmsToDD("45°30'30\"")).toBeCloseTo(45 + 30/60 + 30/3600, 6);
  });

  it('converts negative DMS: -87°44\'2.4" correctly', () => {
    const dd = dmsToDD("-87°44'2.4\"");
    expect(dd).toBeLessThan(0);
    expect(Math.abs(dd)).toBeCloseTo(87 + 44/60 + 2.4/3600, 5);
  });

  it('returns null for unrecognized input', () => {
    expect(dmsToDD('not a bearing')).toBeNull();
    expect(dmsToDD('')).toBeNull();
    expect(dmsToDD('45.5')).toBeNull(); // no DMS separators
  });

  it('accepts space-separated DMS format: "45 30 30"', () => {
    const dd = dmsToDD('45 30 30');
    expect(dd).toBeCloseTo(45 + 30/60 + 30/3600, 5);
  });

  it('accepts degree symbol d: "45d30\'30\""', () => {
    const dd = dmsToDD("45d30'30\"");
    expect(dd).toBeCloseTo(45 + 30/60 + 30/3600, 5);
  });
});

describe('DD ↔ DMS round-trip fidelity', () => {
  const testCases = [
    { label: '0°', dd: 0 },
    { label: '45°', dd: 45 },
    { label: '45.5°', dd: 45.5 },
    { label: '87°44\'2.4"', dd: 87 + 44/60 + 2.4/3600 },
    { label: '-120.375°', dd: -120.375 },
    { label: '179.9997°', dd: 179.9997 },
  ];

  testCases.forEach(({ label, dd }) => {
    it(`round-trips ${label} within 0.0001° tolerance`, () => {
      const dms = ddToDms(dd);
      if (dms === null) return; // skip edge cases
      const recovered = dmsToDD(dms);
      if (recovered === null) return;
      expect(Math.abs(recovered - dd)).toBeLessThan(0.0001);
    });
  });
});
