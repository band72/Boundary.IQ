using BoundaryIQ.Api.Models;
using BoundaryIQ.Api.Services;
using Microsoft.AspNetCore.Mvc;

namespace BoundaryIQ.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public class BatchDeedController : ControllerBase
{
    private readonly GeminiVisionService _gemini;
    private readonly TraverseService _traverse;
    private readonly LegalDescriptionWriter _writer;
    private readonly DiagnosticsDatabaseService _db;
    private readonly RepairService _repair;
    private readonly DocConversionService _docConvert;
    private readonly ILogger<BatchDeedController> _log;

    private const long MaxFileSizeBytes = 51L * 1024 * 1024;

    public BatchDeedController(
        GeminiVisionService gemini,
        TraverseService traverse,
        LegalDescriptionWriter writer,
        DiagnosticsDatabaseService db,
        RepairService repair,
        DocConversionService docConvert,
        ILogger<BatchDeedController> log)
    {
        _gemini     = gemini;
        _traverse   = traverse;
        _writer     = writer;
        _db         = db;
        _repair     = repair;
        _docConvert = docConvert;
        _log        = log;
    }

    /// <summary>
    /// Process multiple plat images — extract + compute + write legal description for each.
    /// </summary>
    [HttpPost("process")]
    [RequestSizeLimit(500 * 1024 * 1024)]  // 500 MB total for batch
    public async Task<IActionResult> Process(
        [FromForm] IFormFileCollection images,
        [FromQuery] double pobN = 5000,
        [FromQuery] double pobE = 5000,
        [FromQuery] string units = "Feet",
        [FromQuery] string? county = null,
        [FromQuery] string? state = null,
        [FromQuery] int concurrency = 5,
        CancellationToken ct = default)
    {
        if (images is null || images.Count == 0)
            return BadRequest(new { error = "No images provided." });

        if (images.Count > 20)
            return BadRequest(new { error = "Maximum 20 images per batch." });

        var batchId = Guid.NewGuid().ToString();
        var resultsArray = new BatchDeedItemResult[images.Count];

        // Pre-save batch run to satisfy SQLite Foreign Key constraints on DeedLogs
        _db.SaveBatchRun(batchId, images.Count, 0.0);

        using var semaphore = new System.Threading.SemaphoreSlim(concurrency);
        var tasks = images.Select(async (image, index) =>
        {
            await semaphore.WaitAsync(ct);
            try
            {
                if (ct.IsCancellationRequested) return;

                _log.LogInformation("Batch processing: {name}", image.FileName);

                try
                {
                    if (image.Length > MaxFileSizeBytes)
                        throw new Exception($"File exceeds 20 MB ({image.Length / 1024 / 1024:F1} MB).");

                    // Check Case Finder SQLite Database first for a solved PASS run
                    var solvedCase = _db.FindSolvedCase(image.FileName);
                    if (solvedCase != null && !string.IsNullOrEmpty(solvedCase.ExtractionJson) && !string.IsNullOrEmpty(solvedCase.TraverseJson))
                    {
                        _log.LogInformation("SQLite Case Finder: Found previously solved PASS run for {name}. Re-using cached geometry.", image.FileName);
                        
                        var cachedExtraction = System.Text.Json.JsonSerializer.Deserialize<PlatExtractResult>(solvedCase.ExtractionJson);
                        var cachedTraverse = System.Text.Json.JsonSerializer.Deserialize<TraverseResult>(solvedCase.TraverseJson);

                        if (cachedExtraction != null && cachedTraverse != null)
                        {
                            // Write legal description
                            WriteResult? cachedWriteResult = null;
                            if (cachedExtraction.Courses.Count > 0)
                            {
                                try
                                {
                                    var writeReq = new WriteRequest(
                                        Courses: cachedExtraction.Courses,
                                        PobNorthing: pobN,
                                        PobEasting: pobE,
                                        ParcelDescription: null,
                                        County: county,
                                        State: state,
                                        Units: units.ToLower(),
                                        BasisOfBearings: null,
                                        BearingSystem: null,
                                        AreaAcres: cachedTraverse.AreaAcres,
                                        Perimeter: cachedTraverse.Perimeter);
                                    string text = _writer.Write(writeReq);
                                    cachedWriteResult = new WriteResult(text, cachedExtraction.Courses.Count);
                                }
                                catch { /* write failure is non-fatal */ }
                            }

                            resultsArray[index] = new BatchDeedItemResult(
                                image.FileName, "success",
                                cachedExtraction, cachedTraverse, cachedWriteResult,
                                null);

                            // Log success to SQLite Diagnostics DB under "Stage 5: SQLite Case Finder Solved"
                            _db.SaveDeedLog(
                                batchId: batchId,
                                fileName: image.FileName,
                                parcelName: county != null && state != null ? $"{county}, {state}" : (solvedCase.ParcelName ?? "REUSED PARCEL"),
                                geoCallCount: cachedExtraction.Courses.Count,
                                linearError: cachedTraverse.Closure?.LinearError ?? 0.0,
                                precisionRatio: ParsePrecisionRatio(cachedTraverse.Closure?.PrecisionRatio),
                                status: "PASS",
                                repairStageUsed: "Stage 5: SQLite Case Finder Solved",
                                extractionJson: solvedCase.ExtractionJson,
                                traverseJson: solvedCase.TraverseJson
                            );

                            // Increment Case Finder solved count in heuristic telemetry
                            _db.IncrementHeuristic("SQLite Case Finder Solved", "Auto-retrieve Solved Boundary");

                            return;
                        }
                    }

                    // 1. Read file bytes once — pipeline needs multiple reads
                    await using var imageStream = image.OpenReadStream();
                    using var ms = new MemoryStream();
                    await imageStream.CopyToAsync(ms, ct);
                    byte[] imageBytes = ms.ToArray();
                    string mime = NormalizeMime(image);

                    // Convert Word docs (.doc/.docx) to PDF via LibreOffice
                    if (DocConversionService.IsWordDocument(image.FileName))
                    {
                        _log.LogInformation("Converting Word doc {name} to PDF...", image.FileName);
                        imageBytes = await _docConvert.ConvertToPdfAsync(imageBytes, image.FileName, ct);
                        mime = "application/pdf";
                    }

                    bool isOpenEnded = false;
                    var upperName = image.FileName.ToUpperInvariant();
                    if (upperName.Contains("EASEMENT") || upperName.Contains("EAESMENT") || upperName.Contains("EASMENT") ||
                        upperName.Contains("ROAD") || upperName.Contains("BLVD") || upperName.Contains("R/W") ||
                        upperName.Contains("RIGHT OF WAY") || upperName.Contains("CENTERLINE"))
                    {
                        isOpenEnded = true;
                    }

                    // 2. Run 4-stage repair pipeline
                    var pob = new CoordDto(pobN, pobE);
                    var repairResult = await _repair.RunRepairPipelineAsync(
                        imageBytes, mime, pob, units, isOpenEnded, ct);

                    var extraction    = repairResult.FinalExtraction;
                    var traverse      = repairResult.FinalTraverse;
                    var traverseError = repairResult.TraverseError;
                    string status     = repairResult.Status;
                    string stageUsed  = repairResult.RepairStageUsed;

                    // 3. Write legal description
                    WriteResult? writeResult = null;
                    if (extraction.Courses.Count > 0)
                    {
                        try
                        {
                            var writeReq = new WriteRequest(
                                Courses: extraction.Courses,
                                PobNorthing: pobN,
                                PobEasting: pobE,
                                ParcelDescription: null,
                                County: county,
                                State: state,
                                Units: units.ToLower(),
                                BasisOfBearings: null,
                                BearingSystem: null,
                                AreaAcres: traverse?.AreaAcres,
                                Perimeter: traverse?.Perimeter);
                            string text = _writer.Write(writeReq);
                            writeResult = new WriteResult(text, extraction.Courses.Count);
                        }
                        catch { /* write failure is non-fatal */ }
                    }

                    resultsArray[index] = new BatchDeedItemResult(
                        image.FileName, status == "PASS" ? "success" : "success",
                        extraction, traverse, writeResult,
                        traverseError, repairResult.OriginalExtraction);

                    // 4. Log to SQLite Diagnostics DB
                    double linearError    = traverse?.Closure?.LinearError ?? 0.0;
                    double precisionRatio = ParsePrecisionRatio(traverse?.Closure?.PrecisionRatio);
                    string parcelLabel    = county != null && state != null
                        ? $"{county}, {state}"
                        : $"[{extraction.Classification}] SUBJECT PARCEL";

                    string? extractionJson = extraction != null ? System.Text.Json.JsonSerializer.Serialize(extraction) : null;
                    string? traverseJson   = traverse  != null ? System.Text.Json.JsonSerializer.Serialize(traverse)   : null;

                    _db.SaveDeedLog(
                        batchId: batchId,
                        fileName: image.FileName,
                        parcelName: parcelLabel,
                        geoCallCount: extraction?.Courses?.Count ?? 0,
                        linearError: linearError,
                        precisionRatio: precisionRatio,
                        status: status,
                        repairStageUsed: stageUsed,
                        extractionJson: extractionJson,
                        traverseJson: traverseJson
                    );

                    // Heuristic telemetry
                    if (extraction?.Courses?.Count > 0)
                        _db.IncrementHeuristic(stageUsed, "Auto-repair pipeline");
                }
                catch (Exception ex)
                {
                    _log.LogError(ex, "Batch item failed: {name}", image.FileName);
                    resultsArray[index] = new BatchDeedItemResult(
                        image.FileName, "error",
                        null, null, null, ex.Message);

                    // Log error to SQLite Diagnostics DB
                    _db.SaveDeedLog(
                        batchId: batchId,
                        fileName: image.FileName,
                        parcelName: "ERROR PARCEL",
                        geoCallCount: 0,
                        linearError: 999.0,
                        precisionRatio: 0.0,
                        status: "ERROR",
                        repairStageUsed: "AI Extraction Error",
                        extractionJson: null,
                        traverseJson: null
                    );
                }
            }
            finally
            {
                semaphore.Release();
            }
        });

        await Task.WhenAll(tasks);
        var results = resultsArray.ToList();

        int succeeded = results.Count(r => r != null && r.Status == "success");
        double passRate = results.Count > 0 ? (double)succeeded / results.Count : 0.0;
        _db.SaveBatchRun(batchId, results.Count, passRate);

        return Ok(new BatchDeedResult(results, results.Count, succeeded, results.Count - succeeded));
    }

    private static double ParsePrecisionRatio(string? precisionStr)
    {
        if (string.IsNullOrEmpty(precisionStr)) return 0;
        try
        {
            var parts = precisionStr.Split(':');
            if (parts.Length > 1)
            {
                var cleaned = parts[1].Replace(",", "").Replace(" ", "").Trim();
                if (double.TryParse(cleaned, out double val)) return val;
            }
        }
        catch {}
        return 0;
    }

    private static string NormalizeMime(IFormFile f)
    {
        string mime = f.ContentType.ToLowerInvariant();
        if (mime.Contains("jpeg") || mime.Contains("jpg")) return "image/jpeg";
        if (mime.Contains("png"))  return "image/png";
        if (mime.Contains("webp")) return "image/webp";
        if (mime.Contains("pdf"))  return "application/pdf";
        if (mime.Contains("msword") || mime.Contains("wordprocessing")) return "application/msword";
        var ext = Path.GetExtension(f.FileName).ToLowerInvariant();
        return ext switch 
        { 
            ".jpg" or ".jpeg" => "image/jpeg", 
            ".png" => "image/png", 
            ".webp" => "image/webp",
            ".pdf" => "application/pdf",
            ".doc" => "application/msword",
            ".docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            _ => "image/jpeg" 
        };
    }
}
