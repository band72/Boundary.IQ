import { describe, it, expect } from 'vitest';
import { createCanvas } from 'canvas';
import { resolveLabels, getLeaderIntersection } from '../services/labelLayout.js';

describe('labelLayout Utility Tests', () => {
  const canvas = createCanvas(720, 480);
  const ctx = canvas.getContext('2d');
  const W = 720;
  const H = 480;

  describe('getLeaderIntersection', () => {
    it('correctly calculates intersection on the right boundary of the box', () => {
      // Box centered at (0, 0), size 20x10. Anchor is at (50, 0)
      const res = getLeaderIntersection(50, 0, 0, 0, 20, 10);
      expect(res.x).toBeCloseTo(10);
      expect(res.y).toBeCloseTo(0);
    });

    it('correctly calculates intersection on the top boundary of the box', () => {
      // Box centered at (0, 0), size 20x10. Anchor is at (0, -30)
      const res = getLeaderIntersection(0, -30, 0, 0, 20, 10);
      expect(res.x).toBeCloseTo(0);
      expect(res.y).toBeCloseTo(-5);
    });

    it('correctly calculates diagonal intersection', () => {
      // Box centered at (0, 0), size 20x20. Anchor is at (50, 50)
      const res = getLeaderIntersection(50, 50, 0, 0, 20, 20);
      expect(res.x).toBeCloseTo(10);
      expect(res.y).toBeCloseTo(10);
    });

    it('returns the center if anchor is at the center', () => {
      const res = getLeaderIntersection(0, 0, 0, 0, 20, 20);
      expect(res.x).toBe(0);
      expect(res.y).toBe(0);
    });
  });

  describe('resolveLabels', () => {
    // 4-point square traverse points
    const points = [
      { x: 100, y: 100 },
      { x: 200, y: 100 },
      { x: 200, y: 200 },
      { x: 100, y: 200 }
    ];

    const courses = [
      { type: 'Line', bearing: 'E', distance: 100 },
      { type: 'Line', bearing: 'S', distance: 100 },
      { type: 'Line', bearing: 'W', distance: 100 },
      { type: 'Line', bearing: 'N', distance: 100 }
    ];

    it('successfully places station and segment labels in non-overlapping positions', () => {
      const resolved = resolveLabels(ctx, points, courses, W, H, {
        showStations: true,
        showSegments: true
      });

      // We expect 4 station labels (POB, 1, 2, 3) and 4 segment labels (L1, L2, L3, L4)
      expect(resolved).toHaveLength(8);

      const stations = resolved.filter(lbl => lbl.type === 'station');
      const segments = resolved.filter(lbl => lbl.type === 'segment');

      expect(stations).toHaveLength(4);
      expect(segments).toHaveLength(4);

      expect(stations[0].text).toBe('POB');
      expect(stations[1].text).toBe('1');
      expect(segments[0].text).toBe('L1');
    });

    it('resolves overlap by pushing labels away and setting needsLeader', () => {
      // Two points extremely close to each other
      const closePoints = [
        { x: 100, y: 100 },
        { x: 102, y: 100 }
      ];
      const closeCourses = [
        { type: 'Line', bearing: 'E', distance: 2 }
      ];

      const resolved = resolveLabels(ctx, closePoints, closeCourses, W, H, {
        showStations: true,
        showSegments: false,
        vertexRadius: 5
      });

      expect(resolved).toHaveLength(2);
      
      const lbl1 = resolved[0];
      const lbl2 = resolved[1];

      // Verify they do not occupy the same space
      const distance = Math.hypot(lbl1.x - lbl2.x, lbl1.y - lbl2.y);
      expect(distance).toBeGreaterThan(10); // Minimum separation

      // At least one of them should have been pushed far enough to need a leader
      const hasLeader = lbl1.needsLeader || lbl2.needsLeader;
      expect(hasLeader).toBe(true);
    });

    it('enforces boundary constraints so labels do not clip off canvas', () => {
      // Vertex near top-left boundary corner (1, 1)
      const borderPoints = [
        { x: 1, y: 1 },
        { x: 100, y: 1 }
      ];
      const borderCourses = [
        { type: 'Line', bearing: 'E', distance: 99 }
      ];

      const resolved = resolveLabels(ctx, borderPoints, borderCourses, W, H, {
        showStations: true,
        showSegments: false
      });

      resolved.forEach(lbl => {
        const minX = lbl.x - lbl.width / 2;
        const minY = lbl.y - lbl.height / 2;
        const maxX = lbl.x + lbl.width / 2;
        const maxY = lbl.y + lbl.height / 2;

        expect(minX).toBeGreaterThanOrEqual(2);
        expect(minY).toBeGreaterThanOrEqual(2);
        expect(maxX).toBeLessThanOrEqual(W - 2);
        expect(maxY).toBeLessThanOrEqual(H - 2);
      });
    });

    it('gracefully handles zero-length segments without crashing', () => {
      const degeneratePoints = [
        { x: 100, y: 100 },
        { x: 100, y: 100 } // Same point
      ];
      const degenerateCourses = [
        { type: 'Line', bearing: 'N', distance: 0 }
      ];

      expect(() => {
        resolveLabels(ctx, degeneratePoints, degenerateCourses, W, H, {
          showStations: true,
          showSegments: true
        });
      }).not.toThrow();
    });
  });
});
