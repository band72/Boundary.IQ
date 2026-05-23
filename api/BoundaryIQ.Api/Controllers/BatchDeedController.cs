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
    private readonly ILogger<BatchDeedController> _log;

    private const long MaxFileSizeBytes = 20 * 1024 * 1024;

    public BatchDeedController(
        GeminiVisionService gemini,
        TraverseService traverse,
        LegalDescriptionWriter writer,
        ILogger<BatchDeedController> log)
    {
        _gemini   = gemini;
        _traverse = traverse;
        _writer   = writer;
        _log      = log;
    }

    /// <summary>
    /// Process multiple plat images — extract + compute + write legal description for each.
    /// </summary>
    [HttpPost("process")]
    [RequestSizeLimit(200 * 1024 * 1024)]  // 200 MB total for batch
    public async Task<IActionResult> Process(
        [FromForm] IFormFileCollection images,
        [FromQuery] double pobN = 5000,
        [FromQuery] double pobE = 5000,
        [FromQuery] string units = "Feet",
        [FromQuery] string? county = null,
        [FromQuery] string? state = null,
        CancellationToken ct = default)
    {
        if (images is null || images.Count == 0)
            return BadRequest(new { error = "No images provided." });

        if (images.Count > 20)
            return BadRequest(new { error = "Maximum 20 images per batch." });

        var results = new List<BatchDeedItemResult>();

        foreach (var image in images)
        {
            if (ct.IsCancellationRequested) break;

            _log.LogInformation("Batch processing: {name}", image.FileName);

            try
            {
                if (image.Length > MaxFileSizeBytes)
                    throw new Exception($"File exceeds 20 MB ({image.Length / 1024 / 1024:F1} MB).");

                // 1. Extract
                await using var stream = image.OpenReadStream();
                string mime = NormalizeMime(image);
                var extraction = await _gemini.ExtractBoundaryAsync(stream, mime, ct);

                // 2. Compute traverse
                TraverseResult? traverse = null;
                string? traverseError = null;
                if (extraction.Courses.Count > 0)
                {
                    try
                    {
                        traverse = _traverse.Compute(new TraverseRequest(
                            new CoordDto(pobN, pobE),
                            extraction.Courses,
                            units));
                    }
                    catch (Exception tex) { traverseError = tex.Message; }
                }

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

                results.Add(new BatchDeedItemResult(
                    image.FileName, "success",
                    extraction, traverse, writeResult,
                    traverseError));
            }
            catch (Exception ex)
            {
                _log.LogError(ex, "Batch item failed: {name}", image.FileName);
                results.Add(new BatchDeedItemResult(
                    image.FileName, "error",
                    null, null, null, ex.Message));
            }
        }

        int succeeded = results.Count(r => r.Status == "success");
        return Ok(new BatchDeedResult(results, results.Count, succeeded, results.Count - succeeded));
    }

    private static string NormalizeMime(IFormFile f)
    {
        string mime = f.ContentType.ToLowerInvariant();
        if (mime.Contains("jpeg") || mime.Contains("jpg")) return "image/jpeg";
        if (mime.Contains("png"))  return "image/png";
        if (mime.Contains("webp")) return "image/webp";
        if (mime.Contains("pdf"))  return "application/pdf";
        var ext = Path.GetExtension(f.FileName).ToLowerInvariant();
        return ext switch 
        { 
            ".jpg" or ".jpeg" => "image/jpeg", 
            ".png" => "image/png", 
            ".webp" => "image/webp",
            ".pdf" => "application/pdf",
            _ => "image/jpeg" 
        };
    }
}
