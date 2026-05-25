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
        // ── Inverse Gap Solver: Auto-fix meander/unknown runs ────────────────────
        var courses = AutoFixUnknownRuns(req.Courses, req.PointOfBeginning);

        var pob = new Point3D(req.PointOfBeginning.Northing, req.PointOfBeginning.Easting, 0);
        var stations = new List<StationRow>();
        var current = pob;
        int seq = 0;

        // Add POB
        stations.Add(new StationRow(seq++, "POB", pob.Northing, pob.Easting, 0, 0));

        double perimeter = 0;

        foreach (var course in courses)
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

        string ratio;
        string status;

        if (req.IsOpenEnded)
        {
            ratio = "1:∞ (Open-Ended)";
            status = "✓ PASSES  (Open-Ended Traverse)";
        }
        else
        {
            ratio = precision >= 999999
                ? "1:∞ (Perfect)"
                : $"1:{precision:N0}";

            status = precision >= 10000
                ? $"✓ PASSES  {ratio}"
                : $"✗ FAILS   {ratio}  (min 1:10,000)";
        }

        var closure = new ClosureDto(errorN, errorE, linearError, perimeter, ratio, status);

        // Compass Rule Adjustment (Open-ended traverse raw geometry is not distorted back to start)
        var adjusted = req.IsOpenEnded
            ? CompassRuleAdjust(stations, 0, 0, perimeter)
            : CompassRuleAdjust(stations, errorN, errorE, perimeter);

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

    // ─────────────────────────────────────────────────────────────────────────
    // INVERSE GAP SOLVER (AutoFixUnknownRuns)
    //
    // Ported from BoundaryQC DeedDrafter.cs — Heuristic #6.
    //
    // When a meander/water boundary has no defined bearing (IsUnknown=true),
    // the solver:
    //   1. Groups consecutive unknown courses into "runs"
    //   2. Forward-marches known courses BEFORE the run from POB
    //   3. Backward-marches known courses AFTER the run from POB (reverse traverse)
    //   4. The gap between forward-end and backward-end IS the straight-line
    //      tie vector — compute bearing + distance
    //   5. Replace the unknown run with a single synthesized tie course
    //
    // Multi-run: handles multiple independent unknown runs in a single traverse.
    // ─────────────────────────────────────────────────────────────────────────
    private static List<CourseDto> AutoFixUnknownRuns(List<CourseDto> courses, CoordDto pob)
    {
        // Identify which courses are "unknown" — either explicitly marked or via keywords
        bool IsUnknownCourse(CourseDto c)
        {
            if (c.IsUnknown) return true;
            // Check if bearing is empty/missing on a Line (meander with no stated direction)
            if (c.Type.Equals("Line", StringComparison.OrdinalIgnoreCase) &&
                string.IsNullOrWhiteSpace(c.Bearing))
                return true;
            return false;
        }

        // Also detect meander courses that HAVE a bearing but it's approximate ("more or less")
        // These have IsUnknown=false but the AI gave them a plausible bearing+distance
        // from the deed text that says "more or less". We need to replace them.
        bool IsMeanderCourse(CourseDto c)
        {
            if (IsUnknownCourse(c)) return true;
            // No additional keyword detection here — the AI prompt should set IsUnknown
            return false;
        }

        // Build runs of consecutive unknown/meander courses
        var runs = new List<(int start, int end)>();
        int n = courses.Count;
        for (int i = 0; i < n;)
        {
            if (IsMeanderCourse(courses[i]))
            {
                int j = i;
                while (j < n && IsMeanderCourse(courses[j])) j++;
                runs.Add((i, j - 1));
                i = j;
            }
            else i++;
        }

        if (runs.Count == 0) return courses; // No unknowns — pass through unchanged

        // Work on a mutable copy
        var result = new List<CourseDto>(courses);

        // Process runs in reverse order to preserve index stability
        for (int r = runs.Count - 1; r >= 0; r--)
        {
            var (runStart, runEnd) = runs[r];

            // Gather prefix (known courses before the run) and suffix (known courses after)
            var prefix = result.Take(runStart).ToList();
            var suffix = result.Skip(runEnd + 1).ToList();

            // Validate: prefix and suffix must all be known (parseable)
            bool prefixAllKnown = prefix.All(c => !IsMeanderCourse(c) && HasValidBearing(c));
            bool suffixAllKnown = suffix.All(c => !IsMeanderCourse(c) && HasValidBearing(c));

            if (!prefixAllKnown || !suffixAllKnown)
                continue; // Skip — ambiguous with multiple unknown blocks

            // Forward march prefix from POB
            double pN = pob.Northing, pE = pob.Easting;
            foreach (var c in prefix)
            {
                var (fwd, dist) = ComputeVector(c);
                pN += fwd.northing;
                pE += fwd.easting;
            }

            // Backward march suffix from POB (reverse traverse)
            double sN = pob.Northing, sE = pob.Easting;
            var reversedSuffix = new List<CourseDto>(suffix);
            reversedSuffix.Reverse();
            foreach (var c in reversedSuffix)
            {
                // Walk backward = use reverse azimuth
                var (fwd, dist) = ComputeVector(c);
                sN -= fwd.northing;
                sE -= fwd.easting;
            }

            // Compute chord vector from forward-end to backward-end
            double dN = sN - pN;
            double dE = sE - pE;
            double chordDist = Math.Sqrt(dN * dN + dE * dE);

            if (chordDist < 0.01) continue; // Gap is essentially zero

            // Convert ΔN/ΔE to surveyor bearing string
            string tieBearing = VectorToBearing(dN, dE);

            // Create replacement tie course
            var replacement = new CourseDto(
                Type: "Line",
                Bearing: tieBearing,
                Distance: Math.Round(chordDist, 2),
                Delta: null,
                Radius: null,
                ArcLength: null,
                CurveDirection: null,
                ChordBearing: null,
                ChordDistance: null,
                IsUnknown: false // It's now solved!
            );

            // Replace the entire unknown run with the tie vector
            result.RemoveRange(runStart, runEnd - runStart + 1);
            result.Insert(runStart, replacement);
        }

        return result;
    }

    /// <summary>
    /// Checks if a course has a valid, parseable bearing.
    /// </summary>
    private static bool HasValidBearing(CourseDto c)
    {
        if (c.Type.Equals("Line", StringComparison.OrdinalIgnoreCase))
            return !string.IsNullOrWhiteSpace(c.Bearing) && c.Distance.HasValue;
        if (c.Type.Equals("Curve", StringComparison.OrdinalIgnoreCase))
            return !string.IsNullOrWhiteSpace(c.ChordBearing) && c.ChordDistance.HasValue;
        return false;
    }

    /// <summary>
    /// Computes the ΔN/ΔE vector for a single course.
    /// </summary>
    private static ((double northing, double easting) vector, double distance) ComputeVector(CourseDto c)
    {
        if (c.Type.Equals("Line", StringComparison.OrdinalIgnoreCase))
        {
            var (az, _) = BearingParser.Parse(c.Bearing!);
            double dist = c.Distance!.Value;
            double azRad = az.Degrees * Math.PI / 180.0;
            double dn = dist * Math.Cos(azRad);
            double de = dist * Math.Sin(azRad);
            return ((dn, de), dist);
        }
        else // Curve — use chord
        {
            var (az, _) = BearingParser.Parse(c.ChordBearing!);
            double dist = c.ChordDistance!.Value;
            double azRad = az.Degrees * Math.PI / 180.0;
            double dn = dist * Math.Cos(azRad);
            double de = dist * Math.Sin(azRad);
            return ((dn, de), dist);
        }
    }

    /// <summary>
    /// Converts a ΔN/ΔE vector to a surveyor bearing string (e.g., "N45°30'00\"E").
    /// </summary>
    private static string VectorToBearing(double dN, double dE)
    {
        // Compute azimuth from north (0-360)
        double azRad = Math.Atan2(dE, dN);
        double azDeg = azRad * 180.0 / Math.PI;
        if (azDeg < 0) azDeg += 360.0;

        // Convert azimuth to surveyor quadrant bearing
        string ns, ew;
        double bearingDeg;

        if (azDeg <= 90)       { ns = "N"; ew = "E"; bearingDeg = azDeg; }
        else if (azDeg <= 180) { ns = "S"; ew = "E"; bearingDeg = 180 - azDeg; }
        else if (azDeg <= 270) { ns = "S"; ew = "W"; bearingDeg = azDeg - 180; }
        else                   { ns = "N"; ew = "W"; bearingDeg = 360 - azDeg; }

        int deg = (int)bearingDeg;
        double rem = (bearingDeg - deg) * 60.0;
        int min = (int)rem;
        double sec = (rem - min) * 60.0;

        return $"{ns}{deg:D2}°{min:D2}'{sec:00.00}\"{ew}";
    }
}
