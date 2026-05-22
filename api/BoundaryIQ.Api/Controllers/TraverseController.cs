using BoundaryIQ.Api.Models;
using BoundaryIQ.Api.Services;
using Microsoft.AspNetCore.Mvc;

namespace BoundaryIQ.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public class TraverseController : ControllerBase
{
    private readonly TraverseService _svc;
    private readonly ILogger<TraverseController> _log;

    public TraverseController(TraverseService svc, ILogger<TraverseController> log)
    {
        _svc = svc;
        _log = log;
    }

    /// <summary>
    /// Computes a traverse: stations, closure, compass-rule adjusted coordinates, and area.
    /// </summary>
    [HttpPost("compute")]
    [ProducesResponseType(typeof(TraverseResult), 200)]
    [ProducesResponseType(typeof(string), 400)]
    public IActionResult Compute([FromBody] TraverseRequest req)
    {
        try
        {
            var result = _svc.Compute(req);
            return Ok(result);
        }
        catch (ArgumentException ex)
        {
            _log.LogWarning("Traverse validation error: {msg}", ex.Message);
            return BadRequest(new { error = ex.Message });
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "Unexpected error in traverse computation");
            return StatusCode(500, new { error = "Internal computation error. " + ex.Message });
        }
    }
}
