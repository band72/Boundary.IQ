using BoundaryIQ.Api.Models;
using RCS.Cogo.Core.Maths;
using RCS.Cogo.Core.Primitives;

namespace BoundaryIQ.Api.Services;

public class TraverseService
{
    /// <summary>
    /// Computes a full traverse: raw coordinates, closure, compass rule adjustment, area.
    /// </summary>
    public TraverseResult Compute(TraverseRequest req)
    {
        var pob = new Point3D(req.PointOfBeginning.Northing, req.PointOfBeginning.Easting, 0);
        var stations = new List<StationRow>();
        var current = pob;
        int seq = 0;

        // Add POB
        stations.Add(new StationRow(seq++, "POB", pob.Northing, pob.Easting, 0, 0));

        double perimeter = 0;

        foreach (var course in req.Courses)
        {
            Point3D next;
            double dn, de;
            string label;

            if (course.Type.Equals("Line", StringComparison.OrdinalIgnoreCase))
            {
                if (string.IsNullOrWhiteSpace(course.Bearing) || course.Distance is null)
                    throw new ArgumentException($"Course {seq}: Line requires Bearing and Distance.");

                var (az, _) = BearingParser.Parse(course.Bearing);
                double dist = course.Distance.Value;
                next = GeometryEngine.Forward(current, az, dist);
                dn = next.Northing - current.Northing;
                de = next.Easting - current.Easting;
                perimeter += dist;
                label = $"{BearingParser.ToDisplayString(az)} {dist:F2}'";
            }
            else if (course.Type.Equals("Curve", StringComparison.OrdinalIgnoreCase))
            {
                (next, dn, de, perimeter) = ComputeCurve(course, current, perimeter);
                label = $"Curve R={course.Radius:F2} Δ={course.Delta:F4}";
            }
            else
            {
                throw new ArgumentException($"Unknown course type: {course.Type}");
            }

            stations.Add(new StationRow(seq++, label, next.Northing, next.Easting, dn, de));
            current = next;
        }

        // Closure
        double errorN = pob.Northing - current.Northing;
        double errorE = pob.Easting - current.Easting;
        double linearError = Math.Sqrt(errorN * errorN + errorE * errorE);
        double precision = perimeter > 0 && linearError > 0
            ? perimeter / linearError
            : double.MaxValue;

        string ratio = precision >= 999999
            ? "1:∞ (Perfect)"
            : $"1:{precision:N0}";

        string status = precision >= 10000
            ? $"✓ PASSES  {ratio}"
            : $"✗ FAILS   {ratio}  (min 1:10,000)";

        var closure = new ClosureDto(errorN, errorE, linearError, perimeter, ratio, status);

        // Compass Rule Adjustment
        var adjusted = CompassRuleAdjust(stations, errorN, errorE, perimeter);

        // Area via Shoelace (adjusted coords)
        double area = ShoelaceArea(adjusted);
        double areaAcres = area / 43560.0;

        return new TraverseResult(stations, closure, perimeter, area, areaAcres, adjusted);
    }

    // ── Curve computation using chord bearing + arc length ────────────────────────
    private static (Point3D next, double dn, double de, double perim) ComputeCurve(
        CourseDto c, Point3D current, double perim)
    {
        // Prefer arc length; fall back to radius + delta
        double arcLen = c.ArcLength ?? (c.Radius!.Value * Angle.FromDMS(c.Delta!.Value).Radians);
        perim += arcLen;

        // Use chord bearing + chord distance to get next point
        if (!string.IsNullOrWhiteSpace(c.ChordBearing) && c.ChordDistance.HasValue)
        {
            var (az, _) = BearingParser.Parse(c.ChordBearing);
            var next = GeometryEngine.Forward(current, az, c.ChordDistance.Value);
            return (next, next.Northing - current.Northing, next.Easting - current.Easting, perim);
        }

        // Fallback: approximate via midpoint chord from delta + radius
        if (c.Radius.HasValue && c.Delta.HasValue)
        {
            double halfDelta = Angle.FromDMS(c.Delta.Value).Radians / 2.0;
            double chord = 2 * c.Radius.Value * Math.Sin(halfDelta);
            // Without chord bearing we cannot resolve direction — require ChordBearing for curves
            throw new ArgumentException("Curve requires ChordBearing and ChordDistance for direction resolution.");
        }

        throw new ArgumentException("Curve requires ArcLength (or Radius+Delta) and ChordBearing+ChordDistance.");
    }

    // ── Compass Rule (Bowditch) Adjustment ────────────────────────────────────────
    private static List<AdjustedRow> CompassRuleAdjust(
        List<StationRow> stations, double errN, double errE, double perimeter)
    {
        var result = new List<AdjustedRow>();
        double cumDist = 0;
        var first = stations[0];
        result.Add(new AdjustedRow(0, first.Northing, first.Easting));

        for (int i = 1; i < stations.Count; i++)
        {
            var s = stations[i];
            double legDist = Math.Sqrt(s.DepDN * s.DepDN + s.DepDE * s.DepDE);
            cumDist += legDist;
            double k = perimeter > 0 ? cumDist / perimeter : 0;
            result.Add(new AdjustedRow(i,
                s.Northing + errN * k,
                s.Easting + errE * k));
        }
        return result;
    }

    // ── Shoelace Area ─────────────────────────────────────────────────────────────
    private static double ShoelaceArea(List<AdjustedRow> pts)
    {
        double area = 0;
        int n = pts.Count;
        for (int i = 0; i < n; i++)
        {
            var p1 = pts[i];
            var p2 = pts[(i + 1) % n];
            area += (p1.Easting * p2.Northing) - (p2.Easting * p1.Northing);
        }
        return Math.Abs(area) / 2.0;
    }
}
