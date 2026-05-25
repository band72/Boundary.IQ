using System;
using System.Collections.Generic;
using System.IO;
using netDxf;
using netDxf.Entities;
using netDxf.Tables;
using netDxf.Header;
using BoundaryIQ.Api.Models;

namespace BoundaryIQ.Api.Services;

/// <summary>
/// Generates professional surveyor-grade DXF files from traverse geometry.
/// Ported and enhanced from BoundaryQC/Services/DxfRedrawer.cs.
/// </summary>
public static class DxfExportService
{
    // ── DXF Layer definitions (match BoundaryQC convention) ──────────────────
    private const string LayerBoundary = "AI-BNDY";       // Red  — lines + arcs
    private const string LayerText     = "AI-BNDY-TEXT";  // Cyan — bearing/dist labels
    private const string LayerPoints   = "AI-BNDY-PTS";   // Green — POB + station dots
    private const string LayerAnnot    = "AI-BNDY-ANNOT"; // White — title block, north arrow

    /// <summary>
    /// Builds a DXF MemoryStream from the traverse result and courses.
    /// </summary>
    public static MemoryStream GenerateDxf(
        List<StationRow>  stations,
        List<AdjustedRow> adjusted,
        List<CourseDto>   courses,
        DxfMetadata       meta)
    {
        // ── Prefer adjusted stations; fall back to raw ────────────────────────
        var pts = (adjusted?.Count >= 2)
            ? ToVec2List(adjusted)
            : (stations?.Count >= 2 ? ToVec2List(stations) : null);

        if (pts == null || pts.Count < 2)
            throw new InvalidOperationException("Need at least 2 stations to generate DXF.");

        var doc = new DxfDocument();

        // ── Setup layers ───────────────────────────────────────────────────────
        var lyrBndy  = new Layer(LayerBoundary) { Color = AciColor.Red };
        var lyrText  = new Layer(LayerText)     { Color = AciColor.Cyan };
        var lyrPts   = new Layer(LayerPoints)   { Color = AciColor.Green };
        var lyrAnnot = new Layer(LayerAnnot)    { Color = new AciColor(7) };
        doc.Layers.Add(lyrBndy);
        doc.Layers.Add(lyrText);
        doc.Layers.Add(lyrPts);
        doc.Layers.Add(lyrAnnot);

        var textStyle = TextStyle.Default;

        // ── Draw each course segment ───────────────────────────────────────────
        int lineCount  = 0;
        int curveCount = 0;

        for (int i = 0; i < courses.Count; i++)
        {
            var course = courses[i];
            var p1 = (i < pts.Count)     ? pts[i]     : pts[^1];
            var p2 = (i + 1 < pts.Count) ? pts[i + 1] : pts[0]; // close to POB

            // ── Corner marker + label ─────────────────────────────────────────
            string cornerLbl = (i == 0) ? "POB" : $"PT-{i + 1}";
            doc.Entities.Add(new Text(cornerLbl,
                new Vector2(p1.X + 1.0, p1.Y + 1.0), 1.8)
                { Layer = lyrPts, Style = textStyle });

            doc.Entities.Add(new Circle(
                new Vector3(p1.X, p1.Y, 0), 0.4)
                { Layer = lyrPts });

            // ── Line segment ──────────────────────────────────────────────────
            if (!string.Equals(course.Type, "Curve", StringComparison.OrdinalIgnoreCase))
            {
                lineCount++;
                doc.Entities.Add(new Line(p1, p2) { Layer = lyrBndy });

                // Bearing + distance label at midpoint, rotated to line direction
                double midX   = (p1.X + p2.X) / 2.0;
                double midY   = (p1.Y + p2.Y) / 2.0;
                double azRad  = AzimuthRad(p1, p2);
                double angDeg = 90.0 - azRad * 180.0 / Math.PI;

                string brg  = course.Bearing ?? "??";
                string dist = course.Distance.HasValue ? $"{course.Distance.Value:F2}'" : "?";
                string lbl  = $"L{lineCount}  {brg}  {dist}";

                doc.Entities.Add(new Text(lbl,
                    new Vector2(midX, midY + 1.2), 1.6)
                    { Layer = lyrText, Style = textStyle, Rotation = angDeg });
            }
            // ── Arc segment ───────────────────────────────────────────────────
            else
            {
                curveCount++;
                bool solved    = false;
                bool curveLeft = string.Equals(course.CurveDirection, "Left",
                    StringComparison.OrdinalIgnoreCase);
                double r = course.Radius ?? 0;

                if (r > 0.001)
                {
                    try
                    {
                        // Chord midpoint + half-length
                        double cx    = (p1.X + p2.X) / 2.0;
                        double cy    = (p1.Y + p2.Y) / 2.0;
                        double chord = Math.Sqrt(
                            Math.Pow(p2.X - p1.X, 2) +
                            Math.Pow(p2.Y - p1.Y, 2));

                        double halfChord = chord / 2.0;

                        // d = sqrt(R² - (chord/2)²)
                        double dSq = r * r - halfChord * halfChord;
                        if (dSq < 0) dSq = 0;
                        double d = Math.Sqrt(dSq);

                        // Perpendicular unit vector (left of chord direction)
                        double chordDx  = p2.X - p1.X;
                        double chordDy  = p2.Y - p1.Y;
                        double chordLen = chord > 1e-9 ? chord : 1e-9;
                        double perpX    = -chordDy / chordLen;
                        double perpY    =  chordDx / chordLen;

                        // Left curve: center on left of chord; Right curve: opposite
                        double sign  = curveLeft ? 1.0 : -1.0;
                        double centX = cx + sign * perpX * d;
                        double centY = cy + sign * perpY * d;

                        // Start/end angles (Math convention: CCW from +X)
                        double startAng = Math.Atan2(p1.Y - centY, p1.X - centX) * 180.0 / Math.PI;
                        double endAng   = Math.Atan2(p2.Y - centY, p2.X - centX) * 180.0 / Math.PI;
                        if (startAng < 0) startAng += 360.0;
                        if (endAng   < 0) endAng   += 360.0;

                        // netDxf Arc is always CCW; swap for Right (CW) curves
                        if (!curveLeft)
                        {
                            double tmp = startAng;
                            startAng   = endAng;
                            endAng     = tmp;
                        }

                        doc.Entities.Add(new Arc(
                            new Vector3(centX, centY, 0), r, startAng, endAng)
                            { Layer = lyrBndy });

                        // Curve data label at chord midpoint
                        string delta = course.Delta.HasValue ? $"Δ={course.Delta.Value:F4}°" : "";
                        string arcL  = course.ArcLength.HasValue   ? $"L={course.ArcLength.Value:F2}'" : "";
                        string radS  = $"R={r:F2}'";
                        string chd   = course.ChordDistance.HasValue ? $"CH={course.ChordDistance.Value:F2}'" : "";
                        string curveLbl = $"C{curveCount}  {delta}  {arcL}  {radS}  {chd}".Trim();

                        doc.Entities.Add(new Text(curveLbl,
                            new Vector2(cx, cy + 1.2), 1.5)
                            { Layer = lyrText, Style = textStyle });

                        solved = true;
                    }
                    catch { /* fall through to chord fallback */ }
                }

                if (!solved)
                {
                    // Fallback: dashed chord line
                    doc.Entities.Add(new Line(p1, p2)
                        { Layer = lyrBndy, Linetype = Linetype.Dashed });

                    double mxF = (p1.X + p2.X) / 2.0;
                    double myF = (p1.Y + p2.Y) / 2.0;
                    string fb  = $"C{curveCount} [CHORD-APPROX] L={course.ArcLength:F2}' R={r:F2}'";
                    doc.Entities.Add(new Text(fb,
                        new Vector2(mxF, myF + 1.2), 1.5)
                        { Layer = lyrText, Style = textStyle });
                }
            }
        }

        // ── Closing POB dot ───────────────────────────────────────────────────
        doc.Entities.Add(new Circle(
            new Vector3(pts[0].X, pts[0].Y, 0), 0.8)
            { Layer = lyrPts });

        // ── Compute bounding box ──────────────────────────────────────────────
        double minX = double.MaxValue, maxX = double.MinValue;
        double minY = double.MaxValue, maxY = double.MinValue;
        foreach (var p in pts)
        {
            if (p.X < minX) minX = p.X; if (p.X > maxX) maxX = p.X;
            if (p.Y < minY) minY = p.Y; if (p.Y > maxY) maxY = p.Y;
        }
        double rangeX = maxX - minX;
        double rangeY = maxY - minY;

        // ── North Arrow (upper-right of bounding box + margin) ─────────────────
        double naX = maxX + rangeX * 0.08 + 20;
        double naY = maxY;
        double naLen = Math.Max(rangeX, rangeY) * 0.06 + 10;

        // Arrow shaft
        doc.Entities.Add(new Line(
            new Vector2(naX, naY - naLen),
            new Vector2(naX, naY + naLen))
            { Layer = lyrAnnot });

        // Arrowhead (solid triangle)
        doc.Entities.Add(new Text("N",
            new Vector2(naX, naY + naLen + 2), naLen * 0.25)
            { Layer = lyrAnnot, Style = textStyle,
              Alignment = TextAlignment.BaselineCenter });

        // ── Scale bar (lower-left) ─────────────────────────────────────────────
        double sbLen = Math.Round((rangeX + rangeY) / 2.0 / 4.0 / 10.0) * 10.0; // Round to nearest 10
        if (sbLen < 10) sbLen = 10;
        double sbX = minX;
        double sbY = minY - rangeY * 0.06 - 10;

        // Half 1 (solid fill via 2D polyline)
        var sb1 = new Polyline2D(new[]
        {
            new Polyline2DVertex(new Vector2(sbX,              sbY)),
            new Polyline2DVertex(new Vector2(sbX + sbLen / 2,  sbY)),
            new Polyline2DVertex(new Vector2(sbX + sbLen / 2,  sbY + sbLen * 0.04)),
            new Polyline2DVertex(new Vector2(sbX,              sbY + sbLen * 0.04)),
        }) { Layer = lyrAnnot, IsClosed = true };
        doc.Entities.Add(sb1);

        // Half 2
        var sb2 = new Polyline2D(new[]
        {
            new Polyline2DVertex(new Vector2(sbX + sbLen / 2,  sbY)),
            new Polyline2DVertex(new Vector2(sbX + sbLen,      sbY)),
            new Polyline2DVertex(new Vector2(sbX + sbLen,      sbY + sbLen * 0.04)),
            new Polyline2DVertex(new Vector2(sbX + sbLen / 2,  sbY + sbLen * 0.04)),
        }) { Layer = lyrAnnot, IsClosed = true };
        doc.Entities.Add(sb2);

        doc.Entities.Add(new Text($"0",             new Vector2(sbX,             sbY - 2), sbLen * 0.035) { Layer = lyrAnnot, Alignment = TextAlignment.BaselineCenter });
        doc.Entities.Add(new Text($"{sbLen/2:0}",   new Vector2(sbX + sbLen / 2, sbY - 2), sbLen * 0.035) { Layer = lyrAnnot, Alignment = TextAlignment.BaselineCenter });
        doc.Entities.Add(new Text($"{sbLen:0} {meta.Units}", new Vector2(sbX + sbLen, sbY - 2), sbLen * 0.035) { Layer = lyrAnnot, Alignment = TextAlignment.BaselineCenter });

        // ── Title block (lower-right) ─────────────────────────────────────────
        double tbX = maxX + rangeX * 0.08 + 5;
        double tbY = minY;
        double ts  = Math.Max(rangeY / 40.0, 1.5);

        string[] titleLines =
        {
            "BOUNDARY.IQ PLATFORM",
            $"PARCEL: {meta.Parcel ?? "SUBJECT PARCEL"}",
            $"COUNTY: {meta.County ?? "—"}",
            $"STATE:  {meta.State  ?? "—"}",
            $"AREA:   {meta.AreaAcres:F4} AC",
            $"PERIM:  {meta.Perimeter:F2} FT",
            $"BASIS:  {meta.BasisOfBearings ?? "DEED OF RECORD"}",
            $"DATE:   {DateTime.UtcNow:yyyy-MM-dd}",
            "MATH COMPILATION ONLY.",
            "NO FIELD SURVEY PERFORMED.",
        };

        for (int ti = 0; ti < titleLines.Length; ti++)
        {
            doc.Entities.Add(new Text(titleLines[ti],
                new Vector2(tbX, tbY + ti * ts * 1.4), ts)
                { Layer = lyrAnnot, Style = textStyle });
        }

        // ── Save to MemoryStream ──────────────────────────────────────────────
        var ms = new MemoryStream();
        doc.Save(ms);
        ms.Position = 0;
        return ms;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private static List<Vector2> ToVec2List(List<AdjustedRow> rows)
        => rows.ConvertAll(r => new Vector2(r.Easting, r.Northing));

    private static List<Vector2> ToVec2List(List<StationRow> rows)
        => rows.ConvertAll(r => new Vector2(r.Easting, r.Northing));

    /// <summary>North-based azimuth (0=N, CW), in radians.</summary>
    private static double AzimuthRad(Vector2 p1, Vector2 p2)
    {
        double dx   = p2.X - p1.X;
        double dy   = p2.Y - p1.Y;
        double atan = Math.Atan2(dx, dy); // dx first → North-based
        if (atan < 0) atan += 2 * Math.PI;
        return atan;
    }
}

/// <summary>Metadata for the DXF title block and annotations.</summary>
public class DxfMetadata
{
    public string? Parcel          { get; set; }
    public string? County          { get; set; }
    public string? State           { get; set; }
    public string  Units           { get; set; } = "Feet";
    public double  AreaAcres       { get; set; }
    public double  Perimeter       { get; set; }
    public string? BasisOfBearings { get; set; }
}
