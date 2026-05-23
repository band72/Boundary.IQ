using System;
using System.Collections.Generic;
using Microsoft.AspNetCore.Mvc;
using BoundaryIQ.Api.Services;
using BoundaryIQ.Api.Models;

namespace BoundaryIQ.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public class DiagnosticsController : ControllerBase
{
    private readonly DiagnosticsDatabaseService _db;

    public DiagnosticsController(DiagnosticsDatabaseService db)
    {
        _db = db;
    }

    [HttpGet("recent-batches")]
    public ActionResult<List<BatchRunDto>> GetRecentBatches()
    {
        try
        {
            var data = _db.GetRecentBatchRuns();
            return Ok(data);
        }
        catch (Exception ex)
        {
            return BadRequest(new { error = ex.Message });
        }
    }

    [HttpGet("search")]
    public ActionResult<List<DeedLogDto>> Search(
        [FromQuery] string? query = null,
        [FromQuery] string? status = null,
        [FromQuery] double? maxError = null)
    {
        try
        {
            var data = _db.SearchDeedLogs(query, status, maxError);
            return Ok(data);
        }
        catch (Exception ex)
        {
            return BadRequest(new { error = ex.Message });
        }
    }

    [HttpGet("heuristics")]
    public ActionResult<List<HeuristicTrackerDto>> GetHeuristics()
    {
        try
        {
            var data = _db.GetHeuristicTracking();
            return Ok(data);
        }
        catch (Exception ex)
        {
            return BadRequest(new { error = ex.Message });
        }
    }
}
