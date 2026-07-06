// ── DXF SVG Preview Component ──────────────────────────────────────────────────
// Renders a boundary polygon as SVG directly from traverse station coordinates.
// No CAD software required — live in-browser preview.
//
// Features:
//   - Auto-scales to fit viewport
//   - Labels each segment with bearing & distance
//   - Highlights self-intersecting segments in red
//   - Shows closure gap as dashed red line
//   - Draws arc approximations for curves (polyline segments)
//   - QC badge overlay (pass/fail + self-intersect status)
// ──────────────────────────────────────────────────────────────────────────────

import { useMemo } from 'react';

const PAD = 40; // viewport padding px

/** Map survey coordinates (northing, easting) to SVG coordinates.
 *  Note: SVG Y increases downward, survey N increases upward, so we flip Y.
 */
function buildTransform(stations, width, height) {
  const xs = stations.map(s => s.easting);
  const ys = stations.map(s => s.northing);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;
  const scaleX = (width - 2 * PAD) / rangeX;
  const scaleY = (height - 2 * PAD) / rangeY;
  const scale = Math.min(scaleX, scaleY);
  const offX = PAD + ((width - 2 * PAD) - rangeX * scale) / 2;
  const offY = PAD + ((height - 2 * PAD) - rangeY * scale) / 2;
  return (e, n) => ({
    x: offX + (e - minX) * scale,
    y: offY + (maxY - n) * scale,  // flip Y axis
  });
}

/** Midpoint in SVG space */
function midpoint(p1, p2) {
  return { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
}

/** Angle of segment in degrees (for text rotation) */
function segmentAngle(p1, p2) {
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  let ang = Math.atan2(dy, dx) * 180 / Math.PI;
  if (ang > 90 || ang < -90) ang += 180; // keep text readable
  return ang;
}

/** Format label from course */
function courseLabel(course) {
  if (!course) return '';
  if (course.type === 'Line' || course.type === 'Squiggle') {
    const b = course.bearing || '';
    const d = course.distance != null ? `${parseFloat(course.distance).toFixed(2)}'` : '';
    return [b, d].filter(Boolean).join(' ');
  }
  if (course.type === 'Curve') {
    const cb = course.chordBearing || '';
    const arc = course.arcLength != null ? `L=${parseFloat(course.arcLength).toFixed(2)}'` : '';
    const r   = course.radius != null ? `R=${parseFloat(course.radius).toFixed(0)}'` : '';
    return [cb, arc, r].filter(Boolean).join(' ');
  }
  return '';
}

export default function DxfPreview({ stations, courses, hasSelfIntersection, width = 600, height = 420, className = '' }) {
  const pts = useMemo(() => {
    const raw = stations?.length >= 2 ? stations : null;
    return raw;
  }, [stations]);

  const svgPts = useMemo(() => {
    if (!pts) return null;
    const toSvg = buildTransform(pts, width, height);
    return pts.map(s => toSvg(s.easting, s.northing));
  }, [pts, width, height]);

  if (!pts || !svgPts || svgPts.length < 2) {
    return (
      <div style={{ width, height, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--bg-elevated)', border: '1px dashed var(--border)', borderRadius: '0.5rem',
        color: 'var(--text-muted)', fontSize: '0.85rem' }}>
        No stations — run traverse first
      </div>
    );
  }

  const n = svgPts.length;
  const isClosed = n >= 3;
  // Closure gap: last station back to first
  const closureGapLength = (() => {
    const last = pts[n - 1], first = pts[0];
    if (!last || !first) return 0;
    return Math.sqrt(
      Math.pow(last.easting - first.easting, 2) +
      Math.pow(last.northing - first.northing, 2)
    );
  })();
  const hasGap = closureGapLength > 0.01;

  return (
    <div className={className} style={{ position: 'relative' }}>
      {/* QC overlay badges */}
      <div style={{ position: 'absolute', top: 8, left: 8, display: 'flex', gap: '0.4rem', flexWrap: 'wrap', zIndex: 2 }}>
        {hasSelfIntersection
          ? <span id="svg-qc-intersect-badge" style={{ padding: '0.2rem 0.55rem', borderRadius: '999px', fontSize: '0.7rem', fontWeight: 700, background: 'rgba(255,60,60,0.85)', color: '#fff' }}>⛔ Self-Intersecting</span>
          : <span id="svg-qc-pass-badge" style={{ padding: '0.2rem 0.55rem', borderRadius: '999px', fontSize: '0.7rem', fontWeight: 700, background: 'rgba(30,180,80,0.85)', color: '#fff' }}>✅ No Intersections</span>
        }
        {hasGap && (
          <span id="svg-qc-gap-badge" style={{ padding: '0.2rem 0.55rem', borderRadius: '999px', fontSize: '0.7rem', fontWeight: 600, background: 'rgba(255,180,0,0.85)', color: '#111' }}>
            Gap {closureGapLength.toFixed(3)} ft
          </span>
        )}
      </div>

      <svg
        id="dxf-preview-svg"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: '0.5rem', display: 'block' }}
      >
        <defs>
          <marker id="arrowhead" markerWidth="6" markerHeight="4" refX="3" refY="2" orient="auto">
            <polygon points="0 0, 6 2, 0 4" fill="var(--accent)" opacity="0.8" />
          </marker>
        </defs>

        {/* Boundary polyline segments */}
        {svgPts.map((p, i) => {
          if (i >= n - 1) return null;
          const p2 = svgPts[i + 1];
          const course = courses?.[i];
          const isHighlighted = hasSelfIntersection;
          const color = isHighlighted ? 'var(--danger)' : 'var(--accent)';
          const label = courseLabel(course);
          const mid = midpoint(p, p2);
          const ang = segmentAngle(p, p2);

          return (
            <g key={i}>
              <line
                x1={p.x} y1={p.y} x2={p2.x} y2={p2.y}
                stroke={color} strokeWidth={2}
                markerEnd="url(#arrowhead)"
              />
              {label && (
                <text
                  x={mid.x} y={mid.y}
                  textAnchor="middle" dominantBaseline="middle"
                  fontSize="9" fill="rgba(255,255,255,0.75)"
                  transform={`rotate(${ang},${mid.x},${mid.y})`}
                  style={{ pointerEvents: 'none', userSelect: 'none' }}
                  dy="-5"
                >
                  {label}
                </text>
              )}
            </g>
          );
        })}

        {/* Closure gap (dashed red line) */}
        {isClosed && hasGap && (() => {
          const first = svgPts[0], last = svgPts[n - 1];
          return (
            <line
              x1={last.x} y1={last.y} x2={first.x} y2={first.y}
              stroke="var(--danger)" strokeWidth={1.5} strokeDasharray="5,4" opacity={0.8}
            />
          );
        })()}

        {/* Station dots */}
        {svgPts.map((p, i) => (
          <g key={`dot-${i}`}>
            <circle cx={p.x} cy={p.y} r={4} fill={i === 0 ? '#ffea00' : 'var(--success)'} stroke="var(--bg-elevated)" strokeWidth={1.5} />
            {i === 0 && (
              <text x={p.x + 7} y={p.y - 7} fontSize="9" fill="#ffea00" fontWeight={700}>POB</text>
            )}
          </g>
        ))}
      </svg>
    </div>
  );
}
