using BoundaryIQ.Api.Models;
using BoundaryIQ.Api.Services;
using Microsoft.AspNetCore.Mvc;
using System.Text.Json;
using UglyToad.PdfPig;

namespace BoundaryIQ.Api.Controllers;

/// <summary>
/// Scans a server-side folder path, pre-classifies documents by filename or PDF text search,
/// and batch-processes deed-type PDFs through the 4-stage repair pipeline.
/// </summary>
[ApiController]
[Route("api/[controller]")]
public class FolderScanController : ControllerBase
{
    private readonly RepairService _repair;
    private readonly LegalDescriptionWriter _writer;
    private readonly DiagnosticsDatabaseService _db;
    private readonly ILogger<FolderScanController> _log;

    private const long MaxFileSizeBytes = 51L * 1024 * 1024; // 51 MB per file

    // Configurable allowed root directories for folder scanning.
    // Prevents path traversal attacks — only paths under these roots are permitted.
    private static readonly string[] AllowedRoots = GetAllowedRoots();

    private static string[] GetAllowedRoots()
    {
        var envRoots = Environment.GetEnvironmentVariable("BOUNDARY_SCAN_ROOTS");
        if (!string.IsNullOrEmpty(envRoots))
            return envRoots.Split(';', StringSplitOptions.RemoveEmptyEntries)
                          .Select(r => Path.GetFullPath(r.Trim()))
                          .ToArray();

        // Default: user's home directory
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        return new[] { home };
    }

    /// <summary>
    /// Validates that a user-supplied path is safe (no traversal, within allowed roots).
    /// Returns the resolved absolute path or null if invalid.
    /// </summary>
    private string? ValidatePath(string path)
    {
        if (string.IsNullOrWhiteSpace(path)) return null;

        // Reject obvious traversal attempts
        if (path.Contains("..")) return null;

        // Resolve to absolute path
        var resolved = Path.GetFullPath(path);

        // Check against allowed roots
        foreach (var root in AllowedRoots)
        {
            if (resolved.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                return resolved;
        }

        return null;
    }

    // Document types that are likely to contain boundary traverses
    private static readonly string[] BoundaryKeywords = new[]
    {
        " - WD", " - SWD", " - LWD", " - QCD",
        "Deed", "Easement", "Right of Way", "Monument Road",
        "Deed of Dedication", "Grant of Easement", "Utility Easement",
        "Road", "Blvd", "Order of Taking", "Closing of Pt"
    };

    // Document types to skip — not boundary geometry documents
    private static readonly string[] SkipKeywords = new[]
    {
        "Memo of Lease", "Short Form Lease", "Operating Agreement",
        "Administrative Fine", "Adminstrative Fine", "Lis Pendens", "Bankruptcy",
        "Letters of Administration", "Order Admitting Will",
        "Petition for Administration", "Memo of Management",
        "Memo of ROFR", "Memo of Transfer", "Affidavit",
        "Aff-Cert", "Commitment", "Committment", "Electric Service",
        "Assign & Assump", "REA Assign", "Agreement Concerning Lease",
        "Fourth Amendment", "2nd Amend", "Vendor_s Lien", 
        "Certificate", "Contribution Agreement", "Utility Agreement",
        "Dec of Expiration"
    };

    public FolderScanController(
        RepairService repair,
        LegalDescriptionWriter writer,
        DiagnosticsDatabaseService db,
        DocConversionService docConvert,
        OutputService output,
        ILogger<FolderScanController> log)
    {
        _repair     = repair;
        _writer     = writer;
        _db         = db;
        _docConvert = docConvert;
        _output     = output;
        _log        = log;
    }

    private readonly DocConversionService _docConvert;
    private readonly OutputService _output;

    // Supported extensions for scanning
    private static readonly string[] SupportedExtensions = { ".pdf", ".doc", ".docx" };

    /// <summary>Returns all supported files (pdf, doc, docx) in a directory, sorted.</summary>
    private static string[] GetSupportedFiles(string dirPath)
    {
        return Directory.GetFiles(dirPath)
            .Where(f => SupportedExtensions.Contains(Path.GetExtension(f).ToLowerInvariant()))
            .OrderBy(f => f)
            .ToArray();
    }

    /// <summary>
    /// Scan a folder and return a manifest of all PDFs with pre-classification.
    /// </summary>
    [HttpGet("scan")]
    public IActionResult Scan([FromQuery] string path)
    {
        var validPath = ValidatePath(path);
        if (validPath == null)
            return StatusCode(403, new { error = "Path is not allowed. Set BOUNDARY_SCAN_ROOTS env var to configure allowed directories." });

        if (!Directory.Exists(validPath))
            return NotFound(new { error = $"Directory not found: {validPath}" });

        var files = GetSupportedFiles(validPath)
            .Select(f =>
            {
                var info     = new FileInfo(f);
                var docType  = GetDocType(f, info.Name);
                return new
                {
                    fileName    = info.Name,
                    fullPath    = f,
                    sizeBytes   = info.Length,
                    sizeMb      = Math.Round(info.Length / 1048576.0, 2),
                    docType,
                    willProcess = docType != "SKIP" && info.Length <= MaxFileSizeBytes,
                    skipReason  = docType == "SKIP" ? "Non-boundary document (no legal description found)" :
                                  info.Length > MaxFileSizeBytes ? "Exceeds 20 MB" : null
                };
            })
            .ToList();

        int total      = files.Count;
        int toProcess  = files.Count(f => f.willProcess);
        int toSkip     = total - toProcess;

        return Ok(new
        {
            path,
            total,
            toProcess,
            toSkip,
            batchesNeeded = (int)Math.Ceiling(toProcess / 20.0),
            files
        });
    }

    /// <summary>
    /// Debugs skipped files in a directory, performing a deep analysis of why they were skipped.
    /// </summary>
    [HttpGet("debug-skipped")]
    public IActionResult DebugSkipped([FromQuery] string path)
    {
        var validPath = ValidatePath(path);
        if (validPath == null)
            return StatusCode(403, new { error = "Path is not allowed. Set BOUNDARY_SCAN_ROOTS env var to configure allowed directories." });

        if (!Directory.Exists(validPath))
            return NotFound(new { error = $"Directory not found: {validPath}" });

        var files = GetSupportedFiles(validPath)
            .Select(f =>
            {
                var info = new FileInfo(f);
                var docType = GetDocType(f, info.Name);
                
                // Deep scan the PDF to see why it skipped
                bool isTextReadable = false;
                int totalChars = 0;
                bool hasThence = false;
                bool hasPOB = false;
                bool hasDegrees = false;
                bool hasLotBlock = false;
                bool hasPLSS = false;
                string? pdfError = null;

                try
                {
                    using var document = UglyToad.PdfPig.PdfDocument.Open(f);
                    isTextReadable = document.NumberOfPages > 0;
                    foreach (var page in document.GetPages())
                    {
                        var text = page.Text;
                        if (string.IsNullOrWhiteSpace(text)) continue;

                        totalChars += text.Length;
                        var upperText = text.ToUpperInvariant();

                        if (upperText.Contains("THENCE")) hasThence = true;
                        if (upperText.Contains("POINT OF BEGINNING") || upperText.Contains(" P.O.B.") || upperText.Contains(" POB")) hasPOB = true;
                        if (upperText.Contains("DEGREE") || upperText.Contains("°") || upperText.Contains("MINUTE") || upperText.Contains("SECOND")) hasDegrees = true;
                        if (upperText.Contains("LOT") && (upperText.Contains("BLOCK") || upperText.Contains("SUBDIVISION") || upperText.Contains("PLAT"))) hasLotBlock = true;
                        if (upperText.Contains("SECTION") && (upperText.Contains("TOWNSHIP") || upperText.Contains("RANGE"))) hasPLSS = true;
                    }
                }
                catch (Exception ex)
                {
                    pdfError = ex.Message;
                }

                // Check filename matches
                string? matchedSkipKeyword = null;
                var upperName = info.Name.ToUpperInvariant();
                foreach (var skip in SkipKeywords)
                {
                    if (upperName.Contains(skip.ToUpperInvariant()))
                    {
                        matchedSkipKeyword = skip;
                        break;
                    }
                }

                return new
                {
                    fileName = info.Name,
                    sizeMb = Math.Round(info.Length / 1048576.0, 2),
                    docType,
                    willProcess = docType != "SKIP" && info.Length <= MaxFileSizeBytes,
                    isTextReadable,
                    totalChars,
                    hasThence,
                    hasPOB,
                    hasDegrees,
                    hasLotBlock,
                    hasPLSS,
                    matchedSkipKeyword,
                    pdfError
                };
            })
            .ToList();

        var skippedList = files.Where(f => !f.willProcess).ToList();

        return Ok(new
        {
            path,
            totalFiles = files.Count,
            totalProcessable = files.Count(f => f.willProcess),
            totalSkipped = skippedList.Count,
            skippedFiles = skippedList
        });
    }

    /// <summary>
    /// Process one batch (by 0-based batchIndex) from a server-side folder.
    /// Each batch contains up to 20 processable PDFs.
    /// </summary>
    [HttpPost("process-batch")]
    [RequestSizeLimit(500 * 1024 * 1024)]
    public async Task<IActionResult> ProcessBatch(
        [FromQuery] string path,
        [FromQuery] int batchIndex = 0,
        [FromQuery] double pobN = 5000,
        [FromQuery] double pobE = 5000,
        [FromQuery] string units = "Feet",
        [FromQuery] string? county = null,
        [FromQuery] string? state  = null,
        [FromQuery] int concurrency = 5,
        [FromQuery] bool autoOutput = false,
        CancellationToken ct = default)
    {
        var validPath = ValidatePath(path);
        if (validPath == null)
            return StatusCode(403, new { error = "Path is not allowed. Set BOUNDARY_SCAN_ROOTS env var to configure allowed directories." });

        if (!Directory.Exists(validPath))
            return NotFound(new { error = $"Directory not found: {validPath}" });

        // Build the same processable file list as Scan()
        var allProcessable = GetSupportedFiles(validPath)
            .Where(f =>
            {
                var info    = new FileInfo(f);
                var docType = GetDocType(f, info.Name);
                return docType != "SKIP" && info.Length <= MaxFileSizeBytes;
            })
            .ToList();

        if (allProcessable.Count == 0)
            return Ok(new { message = "No processable deed PDFs found in folder.", results = new List<object>() });

        int totalBatches = (int)Math.Ceiling(allProcessable.Count / 20.0);
        if (batchIndex >= totalBatches)
            return BadRequest(new { error = $"batchIndex {batchIndex} out of range (0–{totalBatches - 1})." });

        var batch = allProcessable.Skip(batchIndex * 20).Take(20).ToList();
        var batchId = Guid.NewGuid().ToString();
        var resultsArray = new BatchDeedItemResult[batch.Count];

        _db.SaveBatchRun(batchId, batch.Count, 0.0);

        _log.LogInformation("FolderScan batch {idx}/{total}: {count} files from {path}",
            batchIndex, totalBatches - 1, batch.Count, path);

        using var semaphore = new System.Threading.SemaphoreSlim(concurrency);
        var tasks = batch.Select(async (filePath, index) =>
        {
            await semaphore.WaitAsync(ct);
            try
            {
                if (ct.IsCancellationRequested) return;

                string fileName = Path.GetFileName(filePath);
                _log.LogInformation("FolderScan processing: {name}", fileName);

                try
                {
                    // Check SQLite cache first
                    var solvedCase = _db.FindSolvedCase(fileName);
                    if (solvedCase != null &&
                        !string.IsNullOrEmpty(solvedCase.ExtractionJson) &&
                        !string.IsNullOrEmpty(solvedCase.TraverseJson))
                    {
                        _log.LogInformation("Cache hit for {name}", fileName);
                        var cachedEx = JsonSerializer.Deserialize<PlatExtractResult>(solvedCase.ExtractionJson);
                        var cachedTr = JsonSerializer.Deserialize<TraverseResult>(solvedCase.TraverseJson);
                        if (cachedEx != null && cachedTr != null)
                        {
                            WriteResult? cachedWrite = null;
                            if (cachedEx.Courses.Count > 0)
                            {
                                try
                                {
                                    cachedWrite = new WriteResult(
                                        _writer.Write(new WriteRequest(
                                            cachedEx.Courses, pobN, pobE, null, county, state,
                                            units.ToLower(), null, null,
                                            cachedTr.AreaAcres, cachedTr.Perimeter)),
                                        cachedEx.Courses.Count);
                                }
                                catch (Exception ex) { _log.LogWarning(ex, "Legal description generation failed for cached {name}", fileName); }
                            }
                            resultsArray[index] = new BatchDeedItemResult(
                                fileName, "success", cachedEx, cachedTr, cachedWrite, null);
                            _db.SaveDeedLog(batchId, fileName,
                                solvedCase.ParcelName ?? "CACHED",
                                cachedEx.Courses.Count,
                                cachedTr.Closure?.LinearError ?? 0,
                                ParsePrecisionRatio(cachedTr.Closure?.PrecisionRatio),
                                "PASS", "Stage 5: SQLite Case Finder Solved",
                                solvedCase.ExtractionJson, solvedCase.TraverseJson);
                            return;
                        }
                    }

                    bool isOpenEnded = false;
                    var upperName = fileName.ToUpperInvariant();
                    if (upperName.Contains("EASEMENT") || upperName.Contains("EAESMENT") || upperName.Contains("EASMENT") ||
                        upperName.Contains("ROAD") || upperName.Contains("BLVD") || upperName.Contains("R/W") ||
                        upperName.Contains("RIGHT OF WAY") || upperName.Contains("CENTERLINE"))
                    {
                        isOpenEnded = true;
                    }

                    // Read file and run pipeline
                    byte[] imageBytes = await System.IO.File.ReadAllBytesAsync(filePath, ct);
                    string mime = InferMimeType(fileName);

                    // Convert Word docs to PDF via LibreOffice before sending to Gemini
                    if (DocConversionService.IsWordDocument(fileName))
                    {
                        _log.LogInformation("Converting Word doc {name} to PDF...", fileName);
                        imageBytes = await _docConvert.ConvertToPdfAsync(imageBytes, fileName, ct);
                    }

                    var pob = new CoordDto(pobN, pobE);
                    var repairResult = await _repair.RunRepairPipelineAsync(
                        imageBytes, mime, pob, units, isOpenEnded, ct);

                    var extraction    = repairResult.FinalExtraction;
                    var traverse      = repairResult.FinalTraverse;
                    var traverseError = repairResult.TraverseError;
                    string status     = repairResult.Status;
                    string stageUsed  = repairResult.RepairStageUsed;

                    // Write legal description
                    WriteResult? writeResult = null;
                    if (extraction.Courses.Count > 0)
                    {
                        try
                        {
                            writeResult = new WriteResult(
                                _writer.Write(new WriteRequest(
                                    extraction.Courses, pobN, pobE, null, county, state,
                                    units.ToLower(), null, null,
                                    traverse?.AreaAcres, traverse?.Perimeter)),
                                extraction.Courses.Count);
                        }
                        catch (Exception ex) { _log.LogWarning(ex, "Legal description generation failed for {name}", fileName); }
                    }

                    resultsArray[index] = new BatchDeedItemResult(
                        fileName, status == "PASS" ? "success" : "error", extraction, traverse, writeResult, traverseError,
                        repairResult.OriginalExtraction);

                    string parcelLabel = county != null && state != null
                        ? $"{county}, {state}"
                        : $"[{extraction.Classification}] {Path.GetFileNameWithoutExtension(fileName)}";

                    _db.SaveDeedLog(batchId, fileName, parcelLabel,
                        extraction.Courses?.Count ?? 0,
                        traverse?.Closure?.LinearError ?? 0,
                        ParsePrecisionRatio(traverse?.Closure?.PrecisionRatio),
                        status, stageUsed,
                        JsonSerializer.Serialize(extraction),
                        traverse != null ? JsonSerializer.Serialize(traverse) : null);

                    if (extraction.Courses?.Count > 0)
                        _db.IncrementHeuristic(stageUsed, "FolderScan auto-repair");
                }
                catch (Exception ex)
                {
                    _log.LogError(ex, "FolderScan item failed: {name}", fileName);
                    resultsArray[index] = new BatchDeedItemResult(fileName, "error", null, null, null, ex.Message);
                    _db.SaveDeedLog(batchId, fileName, "ERROR", 0, 999, 0,
                        "ERROR", "AI Extraction Error", null, null);
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

        // ── Auto-Output: write files to dated subfolder ──────────────────────
        string? outputFolder = null;
        if (autoOutput)
        {
            try
            {
                var sw = System.Diagnostics.Stopwatch.StartNew();
                outputFolder = _output.CreateOutputFolder(path);
                foreach (var r in results)
                {
                    if (r == null) continue;
                    _output.WriteResultFiles(outputFolder, r.FileName, r, r.LegalDescription);
                }
                sw.Stop();
                _output.WriteBatchSummary(outputFolder, path, results, sw.Elapsed);
                _log.LogInformation("Auto-output: wrote {count} result files to {folder}", results.Count, outputFolder);
            }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "Auto-output failed for batch {id}", batchId);
            }
        }

        return Ok(new
        {
            batchId,
            batchIndex,
            totalBatches,
            filesInBatch = batch.Count,
            outputFolder,
            results = new BatchDeedResult(results, results.Count, succeeded, results.Count - succeeded)
        });
    }

    // ── Filename-based pre-classification ────────────────────────────────────────
    private static string ClassifyByFilename(string fileName)
    {
        var upper = fileName.ToUpperInvariant();

        foreach (var skip in SkipKeywords)
            if (upper.Contains(skip.ToUpperInvariant())) return "SKIP";

        if (ContainsWord(upper, "WD") || ContainsWord(upper, "SWD") || ContainsWord(upper, "LWD"))
            return "WARRANTY_DEED";

        if (ContainsWord(upper, "QCD") || ContainsWord(upper, "QC"))
            return "QUIT_CLAIM_DEED";

        if (upper.Contains("EASEMENT") || upper.Contains("EAESMENT") || upper.Contains("EASMENT"))
            return "EASEMENT";

        if (upper.Contains("DEED OF DEDICATION") || upper.Contains("DEDICATION"))
            return "DEDICATION";

        if (upper.Contains("ORDER OF TAKING"))
            return "CONDEMNATION";

        if (upper.Contains("ROAD") || upper.Contains("BLVD"))
            return "ROAD_CLOSING";

        if (upper.Contains("DEED") || upper.Contains("GRANT"))
            return "DEED";

        return "SKIP";
    }

    /// <summary>
    /// Searches PDF document text pages for typical surveyor / boundary legal description terminology.
    /// </summary>
    private static bool ContainsLegalDescription(string filePath)
    {
        try
        {
            using var document = UglyToad.PdfPig.PdfDocument.Open(filePath);
            foreach (var page in document.GetPages())
            {
                var text = page.Text;
                if (string.IsNullOrWhiteSpace(text)) continue;

                var upperText = text.ToUpperInvariant();

                // Common indicators of boundary legal description courses (bearing and distance)
                bool hasThence    = upperText.Contains("THENCE");
                bool hasPOB       = upperText.Contains("POINT OF BEGINNING") || upperText.Contains(" P.O.B.") || upperText.Contains(" POB");
                bool hasDegrees   = upperText.Contains("DEGREE") || upperText.Contains("°") || upperText.Contains("MINUTE") || upperText.Contains("SECOND");

                if (hasThence || hasPOB || (hasDegrees && (upperText.Contains("FEET") || upperText.Contains("DISTANCE") || upperText.Contains("CHORD"))))
                {
                    return true;
                }
            }
        }
        catch
        {
            // Failure parsing PDF text — ignore and fallback to filename check
        }
        return false;
    }

    /// <summary>
    /// Checks for a complete standalone word boundary to prevent accidental matching inside substrings.
    /// </summary>
    private static bool ContainsWord(string source, string word)
    {
        int index = 0;
        while ((index = source.IndexOf(word, index, StringComparison.OrdinalIgnoreCase)) != -1)
        {
            int prevCharIndex = index - 1;
            int nextCharIndex = index + word.Length;

            bool isPrevSeparator = prevCharIndex < 0 || !char.IsLetterOrDigit(source[prevCharIndex]);
            bool isNextSeparator = nextCharIndex >= source.Length || !char.IsLetterOrDigit(source[nextCharIndex]);

            if (isPrevSeparator && isNextSeparator)
            {
                return true;
            }
            index += word.Length;
        }
        return false;
    }

    /// <summary>
    /// Evaluates both filename tags and internal text content to classify documents.
    /// </summary>
    private static string GetDocType(string filePath, string fileName)
    {
        // Word documents can't be text-scanned by PdfPig — classify by filename only.
        // Default to DEED unless a skip keyword matches, since the user put them in the folder for processing.
        if (DocConversionService.IsWordDocument(fileName))
        {
            var upperName = fileName.ToUpperInvariant();
            foreach (var skip in SkipKeywords)
            {
                if (upperName.Contains(skip.ToUpperInvariant()))
                    return "SKIP";
            }
            return "DEED";
        }

        // Check text readability (PDF only)
        bool isTextReadable = false;
        int totalChars = 0;
        try
        {
            using var document = UglyToad.PdfPig.PdfDocument.Open(filePath);
            isTextReadable = document.NumberOfPages > 0;
            foreach (var page in document.GetPages())
            {
                var text = page.Text;
                if (!string.IsNullOrWhiteSpace(text))
                {
                    totalChars += text.Length;
                }
            }
        }
        catch (Exception ex) { System.Diagnostics.Debug.WriteLine($"PDF text inspection failed for {filePath}: {ex.Message}"); }

        // 1. Unconditional Pass: If it contains a verifiable legal description in its text content
        if (ContainsLegalDescription(filePath))
        {
            return "DEED";
        }

        // If the text is readable and quite substantive, but has NO metes & bounds courses,
        // it is a reference-only document (e.g. pure LOT_BLOCK or PLSS). Skip it to prevent Stage 0 failures.
        if (isTextReadable && totalChars > 150)
        {
            return "SKIP";
        }

        // 2. Fallback: Robust filename boundary matching
        return ClassifyByFilename(fileName);
    }

    /// <summary>
    /// Infers MIME type from file extension (fixes the bug where all files were sent as application/pdf).
    /// </summary>
    private static string InferMimeType(string fileName)
    {
        var ext = Path.GetExtension(fileName).ToLowerInvariant();
        return ext switch
        {
            ".jpg" or ".jpeg" => "image/jpeg",
            ".png" => "image/png",
            ".webp" => "image/webp",
            ".gif" => "image/gif",
            ".tiff" or ".tif" => "image/tiff",
            ".bmp" => "image/bmp",
            ".doc" or ".docx" => "application/pdf", // Will be converted to PDF first
            _ => "application/pdf",
        };
    }

    private static double ParsePrecisionRatio(string? precisionStr)
    {
        if (string.IsNullOrEmpty(precisionStr)) return 0;
        try
        {
            var parts = precisionStr.Split(':');
            if (parts.Length > 1)
            {
                var cleaned = parts[1].Replace(",", "").Replace("∞", "999999999").Trim();
                if (double.TryParse(cleaned, out double val)) return val;
            }
        }
        catch (Exception ex) 
        {
            System.Diagnostics.Debug.WriteLine($"ParsePrecisionRatio failed for '{precisionStr}': {ex.Message}");
        }
        return 0;
    }
}
