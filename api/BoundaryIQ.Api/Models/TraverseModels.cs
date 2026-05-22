namespace BoundaryIQ.Api.Models;

// ── Inbound ────────────────────────────────────────────────────────────────────

public record TraverseRequest(
    CoordDto PointOfBeginning,
    List<CourseDto> Courses,
    string Units = "Feet"   // "Feet" | "Meters"
);

public record CoordDto(double Northing, double Easting);

public record CourseDto(
    string Type,            // "Line" | "Curve"
    // Line fields
    string? Bearing,        // e.g. "N45°30'00\"E"  or  "N 45-30-00 E"
    double? Distance,
    // Curve fields
    double? Delta,          // central angle (DMS)
    double? Radius,
    double? ArcLength,
    string? CurveDirection, // "Left" | "Right"
    string? ChordBearing,
    double? ChordDistance
);

// ── Outbound ───────────────────────────────────────────────────────────────────

public record TraverseResult(
    List<StationRow> Stations,
    ClosureDto Closure,
    double Perimeter,
    double AreaSqFt,
    double AreaAcres,
    List<AdjustedRow> AdjustedStations
);

public record StationRow(
    int Seq,
    string Course,
    double Northing,
    double Easting,
    double DepDN,   // departure north
    double DepDE    // departure east
);

public record ClosureDto(
    double ErrorNorthing,
    double ErrorEasting,
    double LinearError,
    double Perimeter,
    string PrecisionRatio,
    string Status    // e.g. "PASSES  1:28,450"
);

public record AdjustedRow(
    int Seq,
    double Northing,
    double Easting
);

// ── Plat Extraction ────────────────────────────────────────────────────────────

public record PlatExtractResult(
    string RawJson,
    List<CourseDto> Courses,
    string Message
);
