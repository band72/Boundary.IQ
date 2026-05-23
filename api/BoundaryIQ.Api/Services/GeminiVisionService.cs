using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using BoundaryIQ.Api.Models;

namespace BoundaryIQ.Api.Services;

public class GeminiVisionService
{
    private readonly HttpClient _http;
    private readonly string _apiKey;
    private readonly ILogger<GeminiVisionService> _log;

    // Gemini model — flash is fast enough for structured extraction
    private const string Model = "gemini-3.5-flash";

    public GeminiVisionService(IHttpClientFactory factory, IConfiguration config, ILogger<GeminiVisionService> log)
    {
        _http = factory.CreateClient("gemini");
        _apiKey = config["Gemini:ApiKey"] ?? throw new InvalidOperationException("Gemini:ApiKey not configured.");
        _log = log;
    }

    public async Task<PlatExtractResult> ExtractBoundaryAsync(Stream imageStream, string mimeType, CancellationToken ct = default)
    {
        // Read image as base64
        using var ms = new MemoryStream();
        await imageStream.CopyToAsync(ms, ct);
        string b64 = Convert.ToBase64String(ms.ToArray());

        var prompt = BuildExtractionPrompt();

        var requestBody = new
        {
            contents = new[]
            {
                new
                {
                    parts = new object[]
                    {
                        new { text = prompt },
                        new { inlineData = new { mimeType, data = b64 } }
                    }
                }
            },
            generationConfig = new
            {
                temperature = 0.1,
                responseMimeType = "application/json"
            }
        };

        var url = $"https://generativelanguage.googleapis.com/v1beta/models/{Model}:generateContent?key={_apiKey}";
        var json = JsonSerializer.Serialize(requestBody);
        var content = new StringContent(json, Encoding.UTF8, "application/json");

        var response = await _http.PostAsync(url, content, ct);
        var responseJson = await response.Content.ReadAsStringAsync(ct);

        if (!response.IsSuccessStatusCode)
        {
            _log.LogError("Gemini API error {status}: {body}", response.StatusCode, responseJson);
            throw new Exception($"Gemini API returned {(int)response.StatusCode}: {responseJson}");
        }

        // Parse Gemini response
        var doc = JsonNode.Parse(responseJson);
        var rawText = doc?["candidates"]?[0]?["content"]?["parts"]?[0]?["text"]?.GetValue<string>()
            ?? throw new Exception("Unexpected Gemini response structure.");

        _log.LogInformation("Gemini raw extraction:\n{text}", rawText);

        // Parse the JSON array of courses from the response
        var courses = ParseCoursesFromJson(rawText, out string cleanJson);

        return new PlatExtractResult(cleanJson, courses,
            $"Extracted {courses.Count} courses using Gemini {Model}. Verify topology before computing.");
    }

    private static List<CourseDto> ParseCoursesFromJson(string raw, out string cleanJson)
    {
        // Strip markdown code fences if present
        cleanJson = raw.Trim();
        if (cleanJson.StartsWith("```")) cleanJson = cleanJson.Split('\n', 2)[1];
        if (cleanJson.EndsWith("```")) cleanJson = cleanJson[..cleanJson.LastIndexOf("```")];
        cleanJson = cleanJson.Trim();

        try
        {
            var arr = JsonSerializer.Deserialize<List<JsonElement>>(cleanJson,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });

            var courses = new List<CourseDto>();
            foreach (var el in arr ?? [])
            {
                string type = el.TryGetProperty("type", out var t) ? t.GetString() ?? "Line" : "Line";

                if (type.Equals("Curve", StringComparison.OrdinalIgnoreCase))
                {
                    courses.Add(new CourseDto(
                        Type: "Curve",
                        Bearing: null,
                        Distance: null,
                        Delta: GetDouble(el, "delta"),
                        Radius: GetDouble(el, "radius"),
                        ArcLength: GetDouble(el, "arcLength"),
                        CurveDirection: GetStr(el, "curveDirection"),
                        ChordBearing: GetStr(el, "chordBearing"),
                        ChordDistance: GetDouble(el, "chordDistance")
                    ));
                }
                else
                {
                    courses.Add(new CourseDto(
                        Type: "Line",
                        Bearing: GetStr(el, "bearing"),
                        Distance: GetDouble(el, "distance"),
                        Delta: null, Radius: null, ArcLength: null,
                        CurveDirection: null, ChordBearing: null, ChordDistance: null
                    ));
                }
            }
            return courses;
        }
        catch (Exception ex)
        {
            throw new Exception($"Could not parse extracted JSON from Gemini: {ex.Message}\n\nRaw output:\n{cleanJson}");
        }
    }

    private static string? GetStr(JsonElement el, string key)
        => el.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static double? GetDouble(JsonElement el, string key)
    {
        if (!el.TryGetProperty(key, out var v)) return null;
        return v.ValueKind switch
        {
            JsonValueKind.Number => v.GetDouble(),
            JsonValueKind.String => double.TryParse(v.GetString(), out double d) ? d : null,
            _ => null
        };
    }

    private static string BuildExtractionPrompt() => """
        You are an expert land surveyor AI assistant. Analyze this survey plat image and extract
        the boundary call-outs (metes and bounds) for the PRIMARY parcel boundary.

        === EXTRACTION RULES ===

        1. TOPOLOGICAL SEQUENCE — Physical re-trace required:
           Mentally walk the perimeter CLOCKWISE starting from the Point of Beginning (POB).
           Verify that Segment[N].endpoint geometrically touches Segment[N+1].startpoint.
           If your path jumps across the page or reverses direction, you have the wrong sequence — reorder until the path is continuous.

        2. BOW-TIE PREVENTION:
           After sequencing, mentally project the coordinate geometry. A single-family parcel
           boundary can NEVER cross its own path. If you detect crossing lines, flip the N/S or
           E/W quadrant of the offending bearing, or reorder segments, until no crossings exist.

        3. CURVE DIRECTION (Left vs Right):
           Imagine driving a car clockwise along the chord bearing direction.
           - If the arc bows OUT to the LEFT of the driver (away from lot center) → "Left"
           - If the arc bows OUT to the RIGHT of the driver (toward lot center) → "Right"

        4. ROAD RIGHT-OF-WAY CURVES:
           If a curve is labeled as part of a road R/W, include only the portion that forms
           the actual parcel boundary. Do NOT include tie lines as boundary segments.

        5. UNITS: Return distances in the units shown on the plat (feet unless labeled otherwise).

        6. BEARING FORMAT: Use exactly this format: "N45°30'00\"E" (quadrant + DMS + quadrant).
           Acceptable separators: degree symbol, dash, or space between D-M-S components.

        === OUTPUT FORMAT ===
        Return ONLY a valid JSON array. No explanation, no markdown, no preamble.
        Each element is one course in clockwise sequential order from POB:

        For a LINE segment:
        { "type": "Line", "bearing": "N45°30'00\"E", "distance": 150.25 }

        For a CURVE segment:
        {
          "type": "Curve",
          "delta": 12.3015,
          "radius": 200.00,
          "arcLength": 43.02,
          "chordBearing": "N51°15'30\"E",
          "chordDistance": 42.88,
          "curveDirection": "Right"
        }

        Begin the array with the first course AFTER the POB and end at the last course
        that returns to the POB (do not duplicate the POB as a course).
        """;
}
