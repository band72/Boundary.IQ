/**
 * labelLayout.js — Canvas Label Anti-Overlap Layout Helper
 * Computes non-overlapping positions for station and segment labels,
 * introducing leader lines when labels are pushed away from their anchors.
 */

export function resolveLabels(ctx, pts, courses, W, H, options = {}) {
  const {
    stationFont = 'bold 9px "JetBrains Mono", monospace',
    segmentFont = 'bold 9px "JetBrains Mono", monospace',
    stationPadding = 3,
    segmentPaddingX = 4,
    segmentPaddingY = 2,
    vertexRadius = 6.5,
    showStations = true,
    showSegments = true,
    showConceptualDetail = false,
    leaderStyle = 'arc',
    labelContentMode = 'auto',
  } = options;

  const placedBoxes = [];

  // Helper to check collision
  function hasCollision(box) {
    for (const b of placedBoxes) {
      if (!(box.maxX < b.minX || box.minX > b.maxX ||
            box.maxY < b.minY || box.minY > b.maxY)) {
        return true;
      }
    }
    return false;
  }

  // Helper to check canvas boundary clip
  function isOutOfBounds(box) {
    return box.minX < 2 || box.maxX > W - 2 || box.minY < 2 || box.maxY > H - 2;
  }

  // 1. Mark vertex areas as blocked so labels don't cover them
  pts.forEach(p => {
    placedBoxes.push({
      minX: p.x - vertexRadius - 3,
      maxX: p.x + vertexRadius + 3,
      minY: p.y - vertexRadius - 3,
      maxY: p.y + vertexRadius + 3,
    });
  });

  const resolvedLabels = [];

  // --- Place Station Labels (POB, 1, 2...) ---
  if (showStations && pts.length <= 35) {
    ctx.font = stationFont;
    pts.forEach((p, idx) => {
      const text = idx === 0 ? 'POB' : `${idx}`;
      const textWidth = ctx.measureText(text).width;
      const w = textWidth + stationPadding * 2;
      const h = 10 + stationPadding * 2;

      let placed = false;
      // Distances to search
      const distances = [12, 22, 32, 42];
      
      // 8 standard angles (starting with top-right, which is the preferred default)
      const angles = [
        -Math.PI / 4,     // Top-Right
        -3 * Math.PI / 4,  // Top-Left
        Math.PI / 4,      // Bottom-Right
        3 * Math.PI / 4,   // Bottom-Left
        -Math.PI / 2,     // Top
        Math.PI / 2,      // Bottom
        Math.PI,          // Left
        0                 // Right
      ];

      for (const d of distances) {
        for (const angle of angles) {
          const ox = d * Math.cos(angle);
          const oy = d * Math.sin(angle);
          const cx = p.x + ox;
          const cy = p.y + oy;

          const box = {
            minX: cx - w / 2,
            maxX: cx + w / 2,
            minY: cy - h / 2,
            maxY: cy + h / 2
          };

          if (!hasCollision(box) && !isOutOfBounds(box)) {
            resolvedLabels.push({
              type: 'station',
              text,
              anchorX: p.x,
              anchorY: p.y,
              x: cx,
              y: cy,
              width: w,
              height: h,
              rotated: false,
              angle: 0,
              needsLeader: d > 12,
              leaderStyle,
            });
            placedBoxes.push(box);
            placed = true;
            break;
          }
        }
        if (placed) break;
      }

      // Fallback
      if (!placed) {
        const cx = p.x + 12 * Math.cos(-Math.PI / 4);
        const cy = p.y + 12 * Math.sin(-Math.PI / 4);
        resolvedLabels.push({
          type: 'station',
          text,
          anchorX: p.x,
          anchorY: p.y,
          x: cx,
          y: cy,
          width: w,
          height: h,
          rotated: false,
          angle: 0,
          needsLeader: false,
          leaderStyle,
        });
      }
    });
  }

  // --- Place Segment Labels (L1, C1...) ---
  if (showSegments && courses && courses.length > 0) {
    ctx.font = segmentFont;

    // Compute centroid of the polygon to offset outwards
    const geomCenterX = pts.reduce((sum, p) => sum + p.x, 0) / pts.length;
    const geomCenterY = pts.reduce((sum, p) => sum + p.y, 0) / pts.length;

    let lineIndex = 1;
    let curveIndex = 1;

    courses.forEach((c, i) => {
      const p1 = pts[i];
      const p2 = pts[i + 1] || pts[0];
      if (!p1 || !p2) return;

      const isCurve = (c.type || '').toLowerCase() === 'curve';
      const tagText = isCurve ? `C${curveIndex++}` : `L${lineIndex++}`;

      // Format full label text (bearing + distance / radius + arcLength)
      let fullLabelText;
      if (isCurve) {
        const r = c.radius ? `R=${c.radius}'` : '';
        const l = (c.arcLength || c.distance) ? `L=${c.arcLength || c.distance}'` : '';
        fullLabelText = [r, l].filter(Boolean).join(' ');
      } else {
        const brg = c.bearing ? c.bearing.trim() : '';
        const dist = c.distance ? `${c.distance}'` : '';
        fullLabelText = [brg, dist].filter(Boolean).join(' ');
      }
      if (!fullLabelText) {
        fullLabelText = tagText;
      }

      // Midpoint & segment angle
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const len = Math.hypot(dx, dy) || 1e-9;
      const midX = (p1.x + p2.x) / 2;
      const midY = (p1.y + p2.y) / 2;

      let theta = Math.atan2(dy, dx);
      if (theta < -Math.PI / 2 || theta > Math.PI / 2) {
        theta += Math.PI;
      }

      // Perpendicular normal vector
      const px = -dy / len;
      const py = dx / len;

      // Determine outward direction from geom center
      let ox = px, oy = py;
      const dCenter1 = Math.hypot(midX + px * 5 - geomCenterX, midY + py * 5 - geomCenterY);
      const dCenter2 = Math.hypot(midX - px * 5 - geomCenterX, midY - py * 5 - geomCenterY);
      if (dCenter1 < dCenter2) {
        ox = -px;
        oy = -py;
      }

      // Side multiplier based on showConceptualDetail (inwards vs outwards)
      const sideMultiplier = showConceptualDetail ? -1 : 1;

      let placed = false;

      // Try placing full label if mode is 'auto' and segment is long enough
      if (labelContentMode === 'auto' && fullLabelText !== tagText) {
        const textWidth = ctx.measureText(fullLabelText).width;
        const w_full = textWidth + segmentPaddingX * 2;
        const h_full = 12 + segmentPaddingY * 2;

        // Try parallel close placement only if line is long enough to fit text
        if (len >= w_full + 15) {
          const testDistances = [11 * sideMultiplier, -11 * sideMultiplier];
          for (const distVal of testDistances) {
            const cx = midX + distVal * ox;
            const cy = midY + distVal * oy;

            // Rotated bounding box calculation (AABB)
            const ex = Math.abs(w_full / 2 * Math.cos(theta)) + Math.abs(h_full / 2 * Math.sin(theta));
            const fillY = Math.abs(w_full / 2 * Math.sin(theta)) + Math.abs(h_full / 2 * Math.cos(theta));

            const box = {
              minX: cx - ex,
              maxX: cx + ex,
              minY: cy - fillY,
              maxY: cy + fillY
            };

            if (!hasCollision(box) && !isOutOfBounds(box)) {
              resolvedLabels.push({
                type: 'segment',
                text: fullLabelText,
                isCurve,
                courseIndex: i,
                useTable: false,
                leaderStyle,
                anchorX: midX,
                anchorY: midY,
                x: cx,
                y: cy,
                width: w_full,
                height: h_full,
                rotated: true,
                angle: theta,
                needsLeader: false
              });
              placedBoxes.push(box);
              placed = true;
              break;
            }
          }
        }
      }

      // If full text did not fit or mode is 'tags', use the tag (L1, C1...)
      if (!placed) {
        const textWidth = ctx.measureText(tagText).width;
        const w_tag = textWidth + segmentPaddingX * 2;
        const h_tag = 12 + segmentPaddingY * 2;

        // Try 1: Parallel rotated tag close to segment
        const testDistances = [11 * sideMultiplier, -11 * sideMultiplier];
        for (const distVal of testDistances) {
          const cx = midX + distVal * ox;
          const cy = midY + distVal * oy;

          const ex = Math.abs(w_tag / 2 * Math.cos(theta)) + Math.abs(h_tag / 2 * Math.sin(theta));
          const fillY = Math.abs(w_tag / 2 * Math.sin(theta)) + Math.abs(h_tag / 2 * Math.cos(theta));

          const box = {
            minX: cx - ex,
            maxX: cx + ex,
            minY: cy - fillY,
            maxY: cy + fillY
          };

          if (!hasCollision(box) && !isOutOfBounds(box)) {
            resolvedLabels.push({
              type: 'segment',
              text: tagText,
              isCurve,
              courseIndex: i,
              useTable: true,
              leaderStyle,
              anchorX: midX,
              anchorY: midY,
              x: cx,
              y: cy,
              width: w_tag,
              height: h_tag,
              rotated: true,
              angle: theta,
              needsLeader: false
            });
            placedBoxes.push(box);
            placed = true;
            break;
          }
        }

        // Try 2: Horizontal placement with leaders
        if (!placed) {
          const distances = [20, 30, 40, 50];
          const perpAngle = Math.atan2(oy, ox);
          
          // Try perp outward, perp inward, then oblique angles
          const candidateAngles = [
            perpAngle,
            perpAngle + Math.PI,
            perpAngle + Math.PI / 4,
            perpAngle - Math.PI / 4,
            perpAngle + 3 * Math.PI / 4,
            perpAngle - 3 * Math.PI / 4,
          ];

          for (const d of distances) {
            for (const angle of candidateAngles) {
              const cx = midX + d * Math.cos(angle);
              const cy = midY + d * Math.sin(angle);

              const box = {
                minX: cx - w_tag / 2,
                maxX: cx + w_tag / 2,
                minY: cy - h_tag / 2,
                maxY: cy + h_tag / 2
              };

              if (!hasCollision(box) && !isOutOfBounds(box)) {
                resolvedLabels.push({
                  type: 'segment',
                  text: tagText,
                  isCurve,
                  courseIndex: i,
                  useTable: true,
                  leaderStyle,
                  anchorX: midX,
                  anchorY: midY,
                  x: cx,
                  y: cy,
                  width: w_tag,
                  height: h_tag,
                  rotated: false,
                  angle: 0,
                  needsLeader: true
                });
                placedBoxes.push(box);
                placed = true;
                break;
              }
            }
            if (placed) break;
          }
        }

        // Fallback parallel placement
        if (!placed) {
          const cx = midX + 11 * ox * sideMultiplier;
          const cy = midY + 11 * oy * sideMultiplier;
          resolvedLabels.push({
            type: 'segment',
            text: tagText,
            isCurve,
            courseIndex: i,
            useTable: true,
            leaderStyle,
            anchorX: midX,
            anchorY: midY,
            x: cx,
            y: cy,
            width: w_tag,
            height: h_tag,
            rotated: true,
            angle: theta,
            needsLeader: false
          });
        }
      }
    });
  }

  return resolvedLabels;
}

export function getLeaderIntersection(anchorX, anchorY, cx, cy, w, h) {
  const dx = anchorX - cx;
  const dy = anchorY - cy;
  if (Math.abs(dx) < 1e-5 && Math.abs(dy) < 1e-5) {
    return { x: cx, y: cy };
  }
  const tx = dx !== 0 ? (Math.sign(dx) * w / 2) / dx : Infinity;
  const ty = dy !== 0 ? (Math.sign(dy) * h / 2) / dy : Infinity;
  const t = Math.min(Math.abs(tx), Math.abs(ty));
  return {
    x: cx + t * dx,
    y: cy + t * dy
  };
}

