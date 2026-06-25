// tests/traverseMapPan.test.js
// Unit tests for TraverseMap pan + coordinate projection math.
// These are pure-function extractions of the logic inside TraverseMap.jsx
// so they can be verified without a DOM or canvas.

import { describe, it, expect } from 'vitest';

const PAD = 50;

function buildProjection({ pts, W, H, panOffset = { x: 0, y: 0 } }) {
  const ns = pts.map(p => p.northing);
  const es = pts.map(p => p.easting);
  const minN = Math.min(...ns), maxN = Math.max(...ns);
  const minE = Math.min(...es), maxE = Math.max(...es);
  const rangeN = maxN - minN || 1;
  const rangeE = maxE - minE || 1;
  const scaleX = (W - PAD * 2) / rangeE;
  const scaleY = (H - PAD * 2) / rangeN;
  const scale  = Math.min(scaleX, scaleY);
  const tx = e => PAD + (e - minE) * scale + panOffset.x;
  const ty = n => H - PAD - (n - minN) * scale + panOffset.y;
  return { tx, ty, scale, minN, minE };
}

function findClosestVertex(mouseX, mouseY, pts, tx, ty, threshold = 10) {
  let best = null, bestDist = threshold;
  pts.forEach((p, idx) => {
    const dist = Math.hypot(mouseX - tx(p.easting), mouseY - ty(p.northing));
    if (dist < bestDist) { bestDist = dist; best = idx; }
  });
  return best;
}

function applyPanDelta({ dragStartClient, currentClient, panAtStart, canvasW, cssW, damping = 0.55 }) {
  const scaleRatio = (canvasW / cssW) * damping;
  return {
    x: panAtStart.x + (currentClient.x - dragStartClient.x) * scaleRatio,
    y: panAtStart.y + (currentClient.y - dragStartClient.y) * scaleRatio,
  };
}

const SQUARE_PTS = [
  { northing: 5000, easting: 5000 },
  { northing: 5100, easting: 5000 },
  { northing: 5100, easting: 5100 },
  { northing: 5000, easting: 5100 },
  { northing: 5000, easting: 5000 },
];
const W = 700, H = 340;

describe('TraverseMap — coordinate projection', () => {
  it('projects POB to bottom-left of padded canvas at zero pan', () => {
    const { tx, ty } = buildProjection({ pts: SQUARE_PTS, W, H });
    expect(tx(5000)).toBeCloseTo(PAD, 1);
    expect(ty(5000)).toBeCloseTo(H - PAD, 1);
  });

  it('positive panOffset.x shifts every projected x right by that amount', () => {
    const pan = { x: 30, y: 0 };
    const { tx: tx0 } = buildProjection({ pts: SQUARE_PTS, W, H });
    const { tx: txP } = buildProjection({ pts: SQUARE_PTS, W, H, panOffset: pan });
    SQUARE_PTS.forEach(p => {
      expect(txP(p.easting) - tx0(p.easting)).toBeCloseTo(30, 5);
    });
  });

  it('positive panOffset.y shifts every projected y down by that amount', () => {
    const pan = { x: 0, y: 20 };
    const { ty: ty0 } = buildProjection({ pts: SQUARE_PTS, W, H });
    const { ty: tyP } = buildProjection({ pts: SQUARE_PTS, W, H, panOffset: pan });
    SQUARE_PTS.forEach(p => {
      expect(tyP(p.northing) - ty0(p.northing)).toBeCloseTo(20, 5);
    });
  });

  it('scale is symmetric — equal-distance N and E steps produce same pixel shift', () => {
    const { tx, ty } = buildProjection({ pts: SQUARE_PTS, W, H });
    const dPxE = Math.abs(tx(5100) - tx(5000));
    const dPxN = Math.abs(ty(5000) - ty(5100));
    expect(dPxE).toBeCloseTo(dPxN, 4);
  });
});

describe('TraverseMap — hit-testing with pan offset', () => {
  it('finds vertex 0 when mouse is exactly on its projected position', () => {
    const { tx, ty } = buildProjection({ pts: SQUARE_PTS, W, H });
    const idx = findClosestVertex(tx(5000), ty(5000), SQUARE_PTS, tx, ty);
    expect(idx).toBe(0);
  });

  it('finds vertex 2 when mouse is 3 px from its position (within threshold)', () => {
    const { tx, ty } = buildProjection({ pts: SQUARE_PTS, W, H });
    const idx = findClosestVertex(tx(5100) + 3, ty(5100) + 3, SQUARE_PTS, tx, ty);
    expect(idx).toBe(2);
  });

  it('returns null when mouse is far from all vertices', () => {
    const { tx, ty } = buildProjection({ pts: SQUARE_PTS, W, H });
    expect(findClosestVertex(0, 0, SQUARE_PTS, tx, ty)).toBeNull();
  });

  it('hit-testing works correctly after panning 30 px right', () => {
    const pan = { x: 30, y: 0 };
    const { tx, ty } = buildProjection({ pts: SQUARE_PTS, W, H, panOffset: pan });
    const idx = findClosestVertex(tx(5000), ty(5000), SQUARE_PTS, tx, ty);
    expect(idx).toBe(0);
  });

  it('un-panned position misses vertex when map has been panned 100 px', () => {
    const { tx: tx0, ty: ty0 } = buildProjection({ pts: SQUARE_PTS, W, H });
    const { tx: txP, ty: tyP } = buildProjection({ pts: SQUARE_PTS, W, H, panOffset: { x: 100, y: 0 } });
    // Mouse at OLD vertex 0 position — should miss with panned projector
    const idx = findClosestVertex(tx0(5000), ty0(5000), SQUARE_PTS, txP, tyP);
    expect(idx).toBeNull();
  });
});

describe('TraverseMap — pan delta math', () => {
  const canvasW = 700, cssW = 700;

  it('zero drag produces zero pan offset', () => {
    const r = applyPanDelta({ dragStartClient: { x: 100, y: 100 }, currentClient: { x: 100, y: 100 }, panAtStart: { x: 0, y: 0 }, canvasW, cssW });
    expect(r.x).toBeCloseTo(0, 6);
    expect(r.y).toBeCloseTo(0, 6);
  });

  it('100 CSS px right drag produces 0.55 * 100 = 55 canvas px offset', () => {
    const r = applyPanDelta({ dragStartClient: { x: 0, y: 0 }, currentClient: { x: 100, y: 0 }, panAtStart: { x: 0, y: 0 }, canvasW, cssW });
    expect(r.x).toBeCloseTo(55, 4);
    expect(r.y).toBeCloseTo(0, 6);
  });

  it('50 CSS px down drag produces 0.55 * 50 = 27.5 canvas py offset', () => {
    const r = applyPanDelta({ dragStartClient: { x: 0, y: 0 }, currentClient: { x: 0, y: 50 }, panAtStart: { x: 0, y: 0 }, canvasW, cssW });
    expect(r.y).toBeCloseTo(27.5, 4);
    expect(r.x).toBeCloseTo(0, 6);
  });

  it('accumulates correctly from a non-zero starting offset', () => {
    const r = applyPanDelta({ dragStartClient: { x: 100, y: 100 }, currentClient: { x: 160, y: 80 }, panAtStart: { x: 20, y: -10 }, canvasW, cssW });
    expect(r.x).toBeCloseTo(20 + 60 * 0.55, 4);
    expect(r.y).toBeCloseTo(-10 + (-20) * 0.55, 4);
  });

  it('halving CSS display width doubles sensitivity (scaleRatio)', () => {
    const full = applyPanDelta({ dragStartClient: { x: 0, y: 0 }, currentClient: { x: 100, y: 0 }, panAtStart: { x: 0, y: 0 }, canvasW: 700, cssW: 700 });
    const half = applyPanDelta({ dragStartClient: { x: 0, y: 0 }, currentClient: { x: 100, y: 0 }, panAtStart: { x: 0, y: 0 }, canvasW: 700, cssW: 350 });
    expect(half.x / full.x).toBeCloseTo(2, 4);
  });
});
