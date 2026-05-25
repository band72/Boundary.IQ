using BoundaryIQ.Api.Models;

namespace BoundaryIQ.Api.Models;

// ── Writer ─────────────────────────────────────────────────────────────────────

public record WriteRequest(
    List<CourseDto> Courses,
    double PobNorthing,
    double PobEasting,
    string? ParcelDescription,
    string? County,
    string? State,
    string? Units,
    string? BasisOfBearings,
    string? BearingSystem,
    double? AreaAcres,
    double? Perimeter
);

public record WriteResult(string LegalDescription, int CourseCount);

// ── Batch Deed ─────────────────────────────────────────────────────────────────

public record BatchDeedItemResult(
    string FileName,
    string Status,              // "success" | "error"
    PlatExtractResult? Extraction,
    TraverseResult? Traverse,
    WriteResult? LegalDescription,
    string? Error,
    PlatExtractResult? OriginalExtraction = null  // Pre-repair Stage 0 extraction
);

public record BatchDeedResult(
    List<BatchDeedItemResult> Results,
    int TotalProcessed,
    int Succeeded,
    int Failed
);
