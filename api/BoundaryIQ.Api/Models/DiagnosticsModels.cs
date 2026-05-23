namespace BoundaryIQ.Api.Models;

public record DeedLogDto(
    int Id,
    string BatchId,
    string FileName,
    string? ParcelName,
    int GeoCallCount,
    double LinearError,
    double PrecisionRatio,
    string Status,
    string? RepairStageUsed,
    string Timestamp,
    string? ExtractionJson = null,
    string? TraverseJson = null
);

public record BatchRunDto(
    string BatchId,
    string Timestamp,
    int TotalFiles,
    double PassRate
);

public record HeuristicTrackerDto(
    int Id,
    string ProblemName,
    string SolutionApplied,
    int SuccessCount
);
