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

    // ── Database Management ──────────────────────────────────────────────────────

    [HttpGet("stats")]
    public IActionResult GetDatabaseStats()
    {
        try { return Ok(_db.GetDatabaseStats()); }
        catch (Exception ex) { return BadRequest(new { error = ex.Message }); }
    }

    [HttpPost("purge")]
    public IActionResult PurgeOldLogs([FromQuery] int days = 90)
    {
        if (days < 1) return BadRequest(new { error = "Retention days must be at least 1." });
        try
        {
            int deleted = _db.PurgeOldLogs(days);
            return Ok(new { deleted, message = $"Purged {deleted} records older than {days} days.", stats = _db.GetDatabaseStats() });
        }
        catch (Exception ex) { return BadRequest(new { error = ex.Message }); }
    }

    [HttpPost("clear-failed")]
    public IActionResult ClearFailedCache()
    {
        try
        {
            int deleted = _db.ClearFailedCache();
            return Ok(new { deleted, message = $"Cleared {deleted} failed deed entries. They will be retried on next batch run.", stats = _db.GetDatabaseStats() });
        }
        catch (Exception ex) { return BadRequest(new { error = ex.Message }); }
    }

    [HttpPost("clear-all")]
    public IActionResult ClearAllCache()
    {
        try
        {
            int deleted = _db.ClearAllCache();
            return Ok(new { deleted, message = $"Cleared {deleted} records. All deed logs and batch runs deleted. Heuristics preserved.", stats = _db.GetDatabaseStats() });
        }
        catch (Exception ex) { return BadRequest(new { error = ex.Message }); }
    }
}
