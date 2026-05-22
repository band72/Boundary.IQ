using BoundaryIQ.Api.Models;
using BoundaryIQ.Api.Services;
using Microsoft.AspNetCore.Mvc;

namespace BoundaryIQ.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public class WriterController : ControllerBase
{
    private readonly LegalDescriptionWriter _writer;

    public WriterController(LegalDescriptionWriter writer) => _writer = writer;

    /// <summary>
    /// Converts courses + metadata into a formatted metes-and-bounds legal description.
    /// </summary>
    [HttpPost("generate")]
    [ProducesResponseType(typeof(WriteResult), 200)]
    public IActionResult Generate([FromBody] WriteRequest req)
    {
        try
        {
            string text = _writer.Write(req);
            return Ok(new WriteResult(text, req.Courses.Count));
        }
        catch (Exception ex)
        {
            return BadRequest(new { error = ex.Message });
        }
    }
}
