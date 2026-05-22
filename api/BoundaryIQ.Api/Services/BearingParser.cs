using System.Text.RegularExpressions;
using RCS.Cogo.Core.Primitives;

namespace BoundaryIQ.Api.Services;

/// <summary>
/// Parses surveyor bearing strings into RCS Angle + quadrant number.
/// Supports formats:  "N45°30'00\"E", "N45-30-00E", "N 45 30 00 E", "N45.3000E"
/// </summary>
public static class BearingParser
{
    // Pattern captures: direction1, degrees, minutes, seconds, direction2
    private static readonly Regex _pattern = new(
        @"^\s*([NSns])\s*(\d{1,3})[°\-\s](\d{1,2})['\-\s](\d{1,2}(?:\.\d+)?)[\""\s]*([EWew])\s*$",
        RegexOptions.Compiled);

    // DMS packed: "N45.3000E" where format is DDD.MMSS
    private static readonly Regex _packedDms = new(
        @"^\s*([NSns])\s*(\d+\.\d+)\s*([EWew])\s*$",
        RegexOptions.Compiled);

    /// <summary>
    /// Returns (Azimuth, QuadrantNumber) where quadrant: 1=NE, 2=SE, 3=SW, 4=NW
    /// </summary>
    public static (Angle Azimuth, int Quadrant) Parse(string bearing)
    {
        bearing = bearing.Trim();

        // Try DMS expanded format
        var m = _pattern.Match(bearing);
        if (m.Success)
        {
            string ns = m.Groups[1].Value.ToUpper();
            double deg = double.Parse(m.Groups[2].Value);
            double min = double.Parse(m.Groups[3].Value);
            double sec = double.Parse(m.Groups[4].Value);
            string ew = m.Groups[5].Value.ToUpper();

            double decDeg = deg + min / 60.0 + sec / 3600.0;
            int quadrant = GetQuadrant(ns, ew);
            var az = Angle.FromQuadrant(quadrant, PackDms(deg, min, sec));
            return (az, quadrant);
        }

        // Try packed DMS
        m = _packedDms.Match(bearing);
        if (m.Success)
        {
            string ns = m.Groups[1].Value.ToUpper();
            double dms = double.Parse(m.Groups[2].Value);
            string ew = m.Groups[3].Value.ToUpper();
            int quadrant = GetQuadrant(ns, ew);
            var az = Angle.FromQuadrant(quadrant, dms);
            return (az, quadrant);
        }

        throw new ArgumentException($"Cannot parse bearing: '{bearing}'. Expected format: N45°30'00\"E");
    }

    private static int GetQuadrant(string ns, string ew) => (ns, ew) switch
    {
        ("N", "E") => 1,
        ("S", "E") => 2,
        ("S", "W") => 3,
        ("N", "W") => 4,
        _ => throw new ArgumentException($"Invalid quadrant: {ns}{ew}")
    };

    // Pack degrees/minutes/seconds into DDD.MMSS format
    private static double PackDms(double d, double m, double s)
        => Math.Abs(d) + m / 100.0 + s / 10000.0;

    public static string ToDisplayString(Angle az)
    {
        double dms = az.ToDMS();
        // Convert azimuth back to bearing quadrant display
        double deg = az.Degrees;
        string ns, ew;
        double brg;

        if (deg <= 90) { ns = "N"; ew = "E"; brg = deg; }
        else if (deg <= 180) { ns = "S"; ew = "E"; brg = 180 - deg; }
        else if (deg <= 270) { ns = "S"; ew = "W"; brg = deg - 180; }
        else { ns = "N"; ew = "W"; brg = 360 - deg; }

        int d = (int)brg;
        double rem = (brg - d) * 60;
        int mn = (int)rem;
        double sec = (rem - mn) * 60;

        return $"{ns}{d:D2}°{mn:D2}'{sec:00.00}\"{ew}";
    }
}
