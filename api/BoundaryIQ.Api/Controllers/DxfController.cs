using Microsoft.AspNetCore.Mvc;
using BoundaryIQ.Api.Models;
using BoundaryIQ.Api.Services;

namespace BoundaryIQ.Api.Controllers;

[ApiController]
[Route("api/dxf")]
public class DxfController : ControllerBase
{
    /// <summary>
    /// Generates a professional surveyor-grade DXF file from traverse geometry.
    /// POST /api/dxf/generate
    /// </summary>
    [HttpPost("generate")]
    public IActionResult Generate([FromBody] DxfGenerateRequest req)
    {
        if (req == null)
            return BadRequest("Request body is required.");

        var stations  = req.Stations  ?? new List<StationRow>();
        var adjusted  = req.Adjusted  ?? new List<AdjustedRow>();
        var courses   = req.Courses   ?? new List<CourseDto>();

        if (stations.Count < 2 && adjusted.Count < 2)
            return BadRequest("At least 2 stations are required to generate a DXF.");

        try
        {
            var meta = new DxfMetadata
            {
                Parcel          = req.Parcel,
                County          = req.County,
                State           = req.State,
                Units           = req.Units ?? "Feet",
                AreaAcres       = req.AreaAcres,
                Perimeter       = req.Perimeter,
                BasisOfBearings = req.BasisOfBearings,
            };

            using var stream = DxfExportService.GenerateDxf(stations, adjusted, courses, meta);

            string safeFileName = string.IsNullOrWhiteSpace(req.Parcel)
                ? "boundary_sketch.dxf"
                : req.Parcel.Replace(" ", "_").Replace("/", "-") + ".dxf";

            return File(stream.ToArray(), "application/dxf", safeFileName);
        }
        catch (Exception ex)
        {
            return BadRequest($"DXF generation failed: {ex.Message}");
        }
    }
}

/// <summary>Request body for DXF generation.</summary>
public class DxfGenerateRequest
{
    public List<StationRow>?  Stations        { get; set; }
    public List<AdjustedRow>? Adjusted        { get; set; }
    public List<CourseDto>?   Courses         { get; set; }

    // Title block metadata
    public string? Parcel          { get; set; }
    public string? County          { get; set; }
    public string? State           { get; set; }
    public string? Units           { get; set; }
    public double  AreaAcres       { get; set; }
    public double  Perimeter       { get; set; }
    public string? BasisOfBearings { get; set; }
}
