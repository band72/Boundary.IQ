using BoundaryIQ.Api.Models;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace BoundaryIQ.Api.Services;

/// <summary>
/// Writes output files (corrected legal description, original legal description,
/// and JSON report) to a dated subfolder inside the source directory.
/// Folder naming: DDMMYYYY.fff (day-month-year.milliseconds for uniqueness).
/// </summary>
public class OutputService
{
    private readonly ILogger<OutputService> _log;

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    public OutputService(ILogger<OutputService> log)
    {
        _log = log;
    }

    /// <summary>
    /// Creates a dated output subfolder and returns its path.
    /// Format: DDMMYYYY.fff  (e.g. 25052026.142)
    /// </summary>
    public string CreateOutputFolder(string sourceFolder)
    {
        var now = DateTime.Now;
        // DDMMYYYY.fff — day, month, full year, dot, milliseconds
        string folderName = now.ToString("ddMMyyyy.fff");
        string outputPath = Path.Combine(sourceFolder, folderName);

        // If folder already exists (same millisecond), append a counter
        if (Directory.Exists(outputPath))
        {
            int counter = 1;
            while (Directory.Exists($"{outputPath}_{counter}"))
                counter++;
            outputPath = $"{outputPath}_{counter}";
        }

        Directory.CreateDirectory(outputPath);
        _log.LogInformation("Created output folder: {path}", outputPath);
        return outputPath;
    }

    /// <summary>
    /// Writes output files for a single processed deed result.
    /// </summary>
    public void WriteResultFiles(
        string outputFolder,
        string sourceFileName,
        BatchDeedItemResult result,
        WriteResult? writeResult)
    {
        string baseName = Path.GetFileNameWithoutExtension(sourceFileName);

        try
        {
            // 1. Corrected legal description text
            if (writeResult?.LegalDescription != null)
            {
                string correctedPath = Path.Combine(outputFolder, $"{baseName}_corrected.txt");
                File.WriteAllText(correctedPath, writeResult.LegalDescription);
                _log.LogDebug("Wrote corrected legal: {path}", correctedPath);
            }

            // 2. Original legal description (from original extraction courses — 
            //    we reconstruct it from the original extraction if available)
            if (result.OriginalExtraction?.Courses?.Count > 0)
            {
                string originalPath = Path.Combine(outputFolder, $"{baseName}_original.txt");
                // Write a summary of the original extraction courses
                var lines = new List<string>
                {
                    $"ORIGINAL EXTRACTION — {sourceFileName}",
                    $"Classification: {result.OriginalExtraction.Classification}",
                    $"Course Count: {result.OriginalExtraction.Courses.Count}",
                    $"Preamble Found: {result.OriginalExtraction.PreambleFound}",
                    "",
                    "ORIGINAL COURSES:",
                    "─────────────────────────────────────────────────"
                };

                for (int i = 0; i < result.OriginalExtraction.Courses.Count; i++)
                {
                    var c = result.OriginalExtraction.Courses[i];
                    if (c.Type?.Equals("Curve", StringComparison.OrdinalIgnoreCase) == true)
                    {
                        lines.Add($"  C{i + 1}: {c.Type} — Chord: {c.ChordBearing} {c.ChordDistance:F2}' | Radius: {c.Radius:F2}' | Arc: {c.ArcLength:F2}' | Delta: {c.Delta} | Dir: {c.CurveDirection}");
                    }
                    else
                    {
                        lines.Add($"  L{i + 1}: {c.Type} — {c.Bearing}  {c.Distance:F2}'{(c.IsUnknown ? " [UNKNOWN/MEANDER]" : "")}");
                    }
                }

                File.WriteAllText(originalPath, string.Join(Environment.NewLine, lines));
                _log.LogDebug("Wrote original extraction: {path}", originalPath);
            }

            // 3. Full JSON report (extraction + traverse + closure data)
            string reportPath = Path.Combine(outputFolder, $"{baseName}_report.json");
            var report = new
            {
                sourceFile = sourceFileName,
                processedAt = DateTime.UtcNow.ToString("O"),
                status = result.Status,
                error = result.Error,
                extraction = result.Extraction,
                traverse = result.Traverse,
                legalDescription = writeResult?.LegalDescription,
                originalExtraction = result.OriginalExtraction,
            };
            File.WriteAllText(reportPath, JsonSerializer.Serialize(report, JsonOpts));
            _log.LogDebug("Wrote JSON report: {path}", reportPath);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Failed to write output files for {file}", sourceFileName);
        }
    }

    /// <summary>
    /// Writes a batch summary manifest to the output folder.
    /// </summary>
    public void WriteBatchSummary(
        string outputFolder,
        string sourcePath,
        List<BatchDeedItemResult> results,
        TimeSpan elapsed)
    {
        try
        {
            int total = results.Count;
            int passed = results.Count(r => r.Status == "success" || r.Status == "PASS");
            int failed = results.Count(r => r.Status == "error" || r.Status == "FAIL");
            int meander = results.Count(r => r.Status == "MEANDER");

            var summary = new
            {
                batchSummary = new
                {
                    sourcePath,
                    outputFolder,
                    processedAt = DateTime.UtcNow.ToString("O"),
                    elapsedSeconds = Math.Round(elapsed.TotalSeconds, 1),
                    totalFiles = total,
                    passed,
                    failed,
                    meander,
                    passRate = total > 0 ? $"{100.0 * passed / total:F1}%" : "N/A",
                },
                files = results.Select(r => new
                {
                    fileName = r.FileName,
                    status = r.Status,
                    courses = r.Extraction?.Courses?.Count ?? 0,
                    linearError = r.Traverse?.Closure?.LinearError,
                    precision = r.Traverse?.Closure?.PrecisionRatio,
                    error = r.Error,
                }).ToList()
            };

            string summaryPath = Path.Combine(outputFolder, "_BATCH_SUMMARY.json");
            File.WriteAllText(summaryPath, JsonSerializer.Serialize(summary, JsonOpts));
            _log.LogInformation("Wrote batch summary: {path}", summaryPath);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Failed to write batch summary");
        }
    }
}
