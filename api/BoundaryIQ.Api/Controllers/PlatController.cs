using BoundaryIQ.Api.Models;
using BoundaryIQ.Api.Services;
using Microsoft.AspNetCore.Mvc;

namespace BoundaryIQ.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public class PlatController : ControllerBase
{
    private readonly GeminiVisionService _gemini;
    private readonly TraverseService _traverse;
    private readonly ILogger<PlatController> _log;

    // 51 MB max — large plat scans can be substantial
    private const long MaxFileSizeBytes = 51L * 1024 * 1024;
    private static readonly HashSet<string> AllowedMime = ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"];

    public PlatController(GeminiVisionService gemini, TraverseService traverse, ILogger<PlatController> log)
    {
        _gemini = gemini;
        _traverse = traverse;
        _log = log;
    }

    /// <summary>
    /// Upload a plat image or PDF → Gemini Vision extracts boundary courses → returns structured data.
    /// </summary>
    [HttpPost("extract")]
    [RequestSizeLimit(60 * 1024 * 1024)]
    [ProducesResponseType(typeof(PlatExtractResult), 200)]
    [ProducesResponseType(typeof(object), 400)]
    public async Task<IActionResult> Extract(IFormFile image, CancellationToken ct)
    {
        if (image is null || image.Length == 0)
            return BadRequest(new { error = "No file provided." });

        if (image.Length > MaxFileSizeBytes)
            return BadRequest(new { error = $"File exceeds 51 MB limit ({image.Length / 1024 / 1024:F1} MB)." });

        // Normalize content type
        string mime = image.ContentType.ToLowerInvariant();
        if (!AllowedMime.Contains(mime))
        {
            var ext = Path.GetExtension(image.FileName).ToLowerInvariant();
            mime = ext switch { 
                ".jpg" or ".jpeg" => "image/jpeg", 
                ".png" => "image/png", 
                ".webp" => "image/webp", 
                ".pdf" => "application/pdf",
                _ => mime 
            };
        }

        _log.LogInformation("Plat extract — file: {name}, size: {kb} KB, mime: {mime}",
            image.FileName, image.Length / 1024, mime);

        try
        {
            await using var stream = image.OpenReadStream();
            var result = await _gemini.ExtractBoundaryAsync(stream, mime, ct);
            return Ok(result);
        }
        catch (OperationCanceledException)
        {
            return StatusCode(499, new { error = "Request cancelled." });
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "Plat extraction failed");
            return StatusCode(500, new { error = ex.Message });
        }
    }

    /// <summary>
    /// Extract boundary AND immediately compute traverse — one-shot endpoint.
    /// </summary>
    [HttpPost("extract-and-compute")]
    [RequestSizeLimit(60 * 1024 * 1024)]
    public async Task<IActionResult> ExtractAndCompute(
        IFormFile image,
        [FromQuery] double pobN = 5000,
        [FromQuery] double pobE = 5000,
        [FromQuery] string units = "Feet",
        CancellationToken ct = default)
    {
        if (image is null || image.Length == 0)
            return BadRequest(new { error = "No image file provided." });

        try
        {
            await using var stream = image.OpenReadStream();
            string mime = image.ContentType.ToLowerInvariant();
            if (!AllowedMime.Contains(mime))
            {
                var ext = Path.GetExtension(image.FileName).ToLowerInvariant();
                mime = ext switch { 
                    ".jpg" or ".jpeg" => "image/jpeg", 
                    ".png" => "image/png", 
                    ".webp" => "image/webp", 
                    ".pdf" => "application/pdf",
                    _ => mime 
                };
            }
            var extracted = await _gemini.ExtractBoundaryAsync(stream, mime, ct);

            TraverseResult? traverse = null;
            string? traverseError = null;

            if (extracted.Courses.Count > 0)
            {
                try
                {
                    var req = new TraverseRequest(
                        new CoordDto(pobN, pobE),
                        extracted.Courses,
                        units);
                    traverse = _traverse.Compute(req);
                }
                catch (Exception tex)
                {
                    traverseError = $"Traverse computation failed: {tex.Message}";
                }
            }

            return Ok(new { extraction = extracted, traverse, traverseError });
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "Extract-and-compute failed");
            return StatusCode(500, new { error = ex.Message });
        }
    }
}
