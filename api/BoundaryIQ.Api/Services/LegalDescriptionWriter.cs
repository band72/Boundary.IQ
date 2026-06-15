using BoundaryIQ.Api.Models;

namespace BoundaryIQ.Api.Services;

public class LegalDescriptionWriter
{
    /// <summary>
    /// Converts a computed traverse into a formatted metes-and-bounds legal description.
    /// </summary>
    public string Write(WriteRequest req)
    {
        var sb = new System.Text.StringBuilder();
        var courses = req.Courses;
        string units = req.Units ?? "feet";
        string county = req.County;
        if (string.IsNullOrEmpty(county) || county.Equals("Unknown", System.StringComparison.OrdinalIgnoreCase))
        {
            county = "Unknown County";
        }
        string state = req.State;
        if (string.IsNullOrEmpty(state) || state.Equals("Unknown", System.StringComparison.OrdinalIgnoreCase))
        {
            state = "Unknown State";
        }
        string parcel = req.ParcelDescription ?? "a parcel of land";

        // ── Header ──────────────────────────────────────────────────────────────
        sb.AppendLine($"A parcel of land being {parcel}, situated in {county}, {state}, more particularly described as follows:");
        sb.AppendLine();
        sb.AppendLine($"BEGINNING at a point, said point being the Point of Beginning (POB), having coordinates of Northing {req.PobNorthing:F2}, Easting {req.PobEasting:F2};");
        sb.AppendLine();

        // ── Courses ─────────────────────────────────────────────────────────────
        for (int i = 0; i < courses.Count; i++)
        {
            var c = courses[i];
            bool isLast = i == courses.Count - 1;
            string term = isLast ? "to the Point of Beginning." : ";";

            if (c.Type.Equals("Line", StringComparison.OrdinalIgnoreCase))
            {
                string brg = FormatBearing(c.Bearing ?? "");
                string dist = $"{c.Distance:F2}";
                sb.AppendLine($"THENCE {brg}, a distance of {dist} {units}{term}");
            }
            else // Curve
            {
                string dir    = c.CurveDirection ?? "Right";
                string delta  = FormatDMS(c.Delta  ?? 0);
                string radius = $"{c.Radius:F2}";
                string arc    = $"{c.ArcLength:F2}";
                string chord  = $"{c.ChordDistance:F2}";
                string chBrg  = FormatBearing(c.ChordBearing ?? "");

                sb.AppendLine($"THENCE along a curve to the {dir}, having a radius of {radius} {units}, a central angle of {delta}, an arc length of {arc} {units}, a chord bearing of {chBrg}, and a chord distance of {chord} {units}{term}");
            }

            if (!isLast) sb.AppendLine();
        }

        // ── Closure stats (if provided) ────────────────────────────────────────
        if (req.AreaAcres.HasValue || req.Perimeter.HasValue)
        {
            sb.AppendLine();
            sb.AppendLine($"Said parcel containing {req.AreaAcres:F4} acres, more or less, and having a perimeter of {req.Perimeter:F2} {units}.");
        }

        // ── Basis of bearings ──────────────────────────────────────────────────
        sb.AppendLine();
        sb.AppendLine($"Bearings are based on {req.BasisOfBearings ?? "the deed of record"} and are {req.BearingSystem ?? "grid bearings"}.");

        return sb.ToString().TrimEnd();
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    private static string FormatBearing(string raw)
    {
        // Already well-formatted bearings — just ensure they read as surveyor text
        // e.g. "N89°50'00\"E" → "North 89°50'00\" East"
        if (string.IsNullOrWhiteSpace(raw)) return raw;

        raw = raw.Trim();
        if (raw.Length < 3) return raw;

        string ns = raw[0].ToString().ToUpper() == "N" ? "North" : "South";
        string ew = raw[^1].ToString().ToUpper() == "E" ? "East"  : "West";
        string mid = raw[1..^1].Trim();
        // Normalize dash separators to degree/minute symbols
        if (mid.Contains('-'))
        {
            int i1 = mid.IndexOf('-');
            mid = mid[..i1] + "°" + mid[(i1 + 1)..];
            int i2 = mid.IndexOf('-');
            if (i2 >= 0) mid = mid[..i2] + "'" + mid[(i2 + 1)..];
        }

        return $"{ns} {mid} {ew}";
    }

    private static string FormatDMS(double dms)
    {
        // dms is in DDD.MMSS packed format
        int d = (int)Math.Abs(dms);
        double rem = (Math.Abs(dms) - d) * 100;
        int m = (int)rem;
        double s = (rem - m) * 100;
        return $"{d:D2}°{m:D2}'{s:00.00}\"";
    }
}
