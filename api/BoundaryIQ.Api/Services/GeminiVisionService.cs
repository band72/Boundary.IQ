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

    // Retry config: up to 3 retries with jittered exponential backoff on 429
    private const int    MaxRetries      = 3;
    private const double BaseDelayMs     = 2_000;  // 2 s base
    private static readonly Random _jitter = new();

    public GeminiVisionService(IHttpClientFactory factory, IConfiguration config, ILogger<GeminiVisionService> log)
    {
        _http = factory.CreateClient("gemini");
        _apiKey = config["Gemini:ApiKey"] ?? throw new InvalidOperationException("Gemini:ApiKey not configured.");
        _log = log;
    }

    // ── Shared resilient POST with jittered exponential backoff ─────────────────────────────
    private async Task<(HttpResponseMessage response, string body)> PostWithRetryAsync(
        string url, string jsonPayload, CancellationToken ct)
    {
        for (int attempt = 0; attempt <= MaxRetries; attempt++)
        {
            // StringContent must be recreated each attempt (it is consumed on read)
            var content = new StringContent(jsonPayload, Encoding.UTF8, "application/json");
            var response = await _http.PostAsync(url, content, ct);
            var body = await response.Content.ReadAsStringAsync(ct);

            if (response.IsSuccessStatusCode)
                return (response, body);

            if ((int)response.StatusCode == 429 && attempt < MaxRetries)
            {
                double delay = BaseDelayMs * Math.Pow(2, attempt)
                             + _jitter.Next(0, 500);   // 2 s, 4 s, 8 s + jitter
                _log.LogWarning(
                    "Gemini 429 rate-limit on attempt {attempt}/{max}. Retrying in {delay:F0} ms.",
                    attempt + 1, MaxRetries, delay);
                await Task.Delay((int)delay, ct);
                continue;
            }

            // Non-retryable error — return immediately for caller to throw
            return (response, body);
        }
        // Should never reach here, but satisfy compiler
        throw new Exception("Exceeded maximum retry attempts.");
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

        var (response, responseJson) = await PostWithRetryAsync(url, json, ct);

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

        // Parse structured response: container object or legacy flat array
        var (courses, classification, preambleFound, cleanJson) = ParseStructuredResponse(rawText);

        return new PlatExtractResult(
            cleanJson, courses,
            $"Extracted {courses.Count} courses using Gemini {Model}. Classification: {classification}.",
            classification, preambleFound);
    }

    // ── Stage 3: AI Misclosure Repair ─────────────────────────────────────────────
    public async Task<PlatExtractResult> ExtractMisclosureRepairAsync(
        Stream imageStream, string mimeType,
        PlatExtractResult badExtraction, TraverseResult badTraverse,
        CancellationToken ct = default)
    {
        using var ms = new MemoryStream();
        await imageStream.CopyToAsync(ms, ct);
        string b64 = Convert.ToBase64String(ms.ToArray());

        var errorVector = $"LinearError={badTraverse.Closure.LinearError:F4}ft, " +
                          $"ErrorN={badTraverse.Closure.ErrorNorthing:F4}, " +
                          $"ErrorE={badTraverse.Closure.ErrorEasting:F4}, " +
                          $"Precision={badTraverse.Closure.PrecisionRatio}";

        var repairPrompt = $"""
            You are an elite Professional Land Surveyor performing a MISCLOSURE REPAIR operation.
            The boundary traverse below FAILED to close with the following error:
            {errorVector}

            The current extracted JSON segments are:
            {badExtraction.RawJson}

            Your task:
            1. Study the original plat image carefully.
            2. Identify which specific segment(s) contain transcription errors causing the closure failure.
            3. Apply Quadrant Inversion (flip N↔S or E↔W) to any reversed bearings.
            4. Correct any distances that appear to have OCR transcription errors (e.g., 1234.56 transcribed as 134.56).
            5. Return the COMPLETE corrected segment list — same format as the input but with corrections applied.

            Return ONLY the corrected JSON object (same schema as original extraction).
            """;

        var requestBody = new
        {
            contents = new[]
            {
                new
                {
                    parts = new object[]
                    {
                        new { text = repairPrompt },
                        new { inlineData = new { mimeType, data = b64 } }
                    }
                }
            },
            generationConfig = new { temperature = 0.05, responseMimeType = "application/json" }
        };

        var url = $"https://generativelanguage.googleapis.com/v1beta/models/{Model}:generateContent?key={_apiKey}";
        var (response, responseJson) = await PostWithRetryAsync(url, JsonSerializer.Serialize(requestBody), ct);

        if (!response.IsSuccessStatusCode)
            throw new Exception($"Gemini Stage-3 repair returned {(int)response.StatusCode}: {responseJson}");

        var doc = JsonNode.Parse(responseJson);
        var rawText = doc?["candidates"]?[0]?["content"]?["parts"]?[0]?["text"]?.GetValue<string>()
            ?? throw new Exception("Unexpected Gemini Stage-3 response structure.");

        _log.LogInformation("Stage 3 Repair raw output:\n{text}", rawText);
        var (courses, classification, preambleFound, cleanJson) = ParseStructuredResponse(rawText);
        return new PlatExtractResult(cleanJson, courses,
            $"Stage 3 AI Repair: {courses.Count} courses. Classification: {classification}.",
            classification, preambleFound);
    }

    // ── JSON Response Parser (handles container object or legacy flat array) ────────
    private static (List<CourseDto> Courses, string Classification, bool PreambleFound, string CleanJson)
        ParseStructuredResponse(string raw)
    {
        var cleanJson = raw.Trim();
        // Strip markdown fences
        if (cleanJson.StartsWith("```")) cleanJson = cleanJson.Split('\n', 2)[1];
        if (cleanJson.EndsWith("```"))  cleanJson = cleanJson[..cleanJson.LastIndexOf("```")];
        cleanJson = cleanJson.Trim();

        try
        {
            using var doc = JsonDocument.Parse(cleanJson);
            var root = doc.RootElement;

            // ── Container format: { "Classification": "...", "Segments": [...] }
            if (root.ValueKind == JsonValueKind.Object &&
                root.TryGetProperty("Segments", out var segsEl))
            {
                string classification = root.TryGetProperty("Classification", out var cl)
                    ? cl.GetString() ?? "METES_BOUNDS" : "METES_BOUNDS";
                bool preamble = root.TryGetProperty("PreambleFound", out var pf) && pf.GetBoolean();
                var courses = ParseSegmentArray(segsEl);
                return (courses, classification, preamble, cleanJson);
            }

            // ── Legacy flat array format: [ { "type": "Line", ... }, ... ]
            if (root.ValueKind == JsonValueKind.Array)
            {
                var courses = ParseSegmentArray(root);
                return (courses, "METES_BOUNDS", false, cleanJson);
            }

            throw new Exception("Response root is neither an object with Segments nor an array.");
        }
        catch (Exception ex)
        {
            throw new Exception($"Could not parse Gemini JSON response: {ex.Message}\n\nRaw:\n{cleanJson}");
        }
    }

    private static List<CourseDto> ParseSegmentArray(JsonElement arrayEl)
    {
        var courses = new List<CourseDto>();
        foreach (var el in arrayEl.EnumerateArray())
        {
            // Accept both "Type" (container schema) and "type" (legacy)
            string type = "Line";
            if (el.TryGetProperty("Type", out var tt) || el.TryGetProperty("type", out tt))
                type = tt.GetString() ?? "Line";

            bool isUnknown = el.TryGetProperty("IsUnknown", out var iu) && iu.GetBoolean();

            if (type.Equals("Curve", StringComparison.OrdinalIgnoreCase))
            {
                courses.Add(new CourseDto(
                    Type: "Curve",
                    Bearing: null,
                    Distance: null,
                    Delta: GetDouble(el, "delta") ?? GetDouble(el, "Delta"),
                    Radius: GetDouble(el, "radius") ?? GetDouble(el, "Radius"),
                    ArcLength: GetDouble(el, "arcLength") ?? GetDouble(el, "ArcLength"),
                    CurveDirection: GetStr(el, "curveDirection") ?? GetStr(el, "Direction"),
                    ChordBearing: GetStr(el, "chordBearing") ?? GetStr(el, "ChordBearing"),
                    ChordDistance: GetDouble(el, "chordDistance") ?? GetDouble(el, "ChordDistance"),
                    IsUnknown: isUnknown
                ));
            }
            else
            {
                // Map container schema DMS fields to bearing string when needed
                string? bearing = GetStr(el, "bearing") ?? GetStr(el, "Bearing");
                if (bearing == null)
                {
                    // Reconstruct from Quad+Degrees+Minutes+Seconds if container format
                    var quad    = GetStr(el, "Quad") ?? "";
                    var deg     = GetDouble(el, "Degrees");
                    var min     = GetDouble(el, "Minutes");
                    var sec     = GetDouble(el, "Seconds");
                    if (!string.IsNullOrEmpty(quad) && deg.HasValue)
                    {
                        bearing = $"{quad[0]}\u00b0{(int)deg}\u00b0{(int)(min ?? 0)}'{sec ?? 0:F1}\"{(quad.Length > 1 ? quad[1].ToString() : "")}";
                    }
                }
                courses.Add(new CourseDto(
                    Type: "Line",
                    Bearing: bearing,
                    Distance: GetDouble(el, "distance") ?? GetDouble(el, "Distance"),
                    Delta: null, Radius: null, ArcLength: null,
                    CurveDirection: null, ChordBearing: null, ChordDistance: null,
                    IsUnknown: isUnknown
                ));
            }
        }
        return courses;
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

    // Re-add GetDouble overload accepting nullable to simplify ?? chaining
    private static double? GetDouble(double? val) => val;

    private static string BuildExtractionPrompt() => """
        You are an elite, highly experienced Professional Land Surveyor and Computational Geometer.
        Your core directive is to translate this unstructured land document (deed, map, or plat image)
        into a mathematically perfect, logically sequential boundary traverse formatted as JSON.

        =========================================
        STEP 0 — DOCUMENT CLASSIFICATION
        =========================================
        First, classify the document into EXACTLY ONE of:
          - METES_BOUNDS     : Contains bearing + distance traverse calls (standard deed).
          - SECTION_BREAKDOWN: Pure PLSS aliquot description, no custom bearings.
          - QUALIFIED_PLSS   : Aliquot + road/line clip offset ("that part of...").
          - HYBRID           : PLSS location context + custom metes-and-bounds perimeter calls.
          - LOT_BLOCK        : Subdivision lot reference (Lot X, Block Y, Plat Name).
          - PLAT             : Full recorded plat image with multiple lots.

        Also detect if a preamble is present (ends with "more particularly described" or similar).
        Strip preamble text — extract ONLY the geometric boundary calls.

        =========================================
        STEP 1 — MENTAL MAP PRE-ANALYSIS
        =========================================
        Before generating JSON, perform these checks:
          a) Count the total number of segments (lines + curves) forming the PRIMARY boundary.
          b) Describe the general shape: "East side runs ~N, North side runs ~W," etc.
          c) Confirm path does NOT cross itself (no bow-tie). If it does, correct it now.
          d) Identify the Point of Beginning (POB) and confirm your last segment closes back to it.

        =========================================
        CORE MATHEMATICAL & DRAFTING RULES
        =========================================

        RULE 1 — TOPOLOGICAL SEQUENCE (Head-to-Tail):
          Physically re-trace the perimeter CLOCKWISE from POB. Verify Segment[N].endpoint
          geometrically touches Segment[N+1].startpoint. If a gap or backtrack is detected,
          automatically re-order the segment array until the path is continuous and returns to POB.

        RULE 2 — BOW-TIE (Self-Intersection) PREVENTION:
          A property boundary can NEVER cross its own path. Project coordinate geometry using
          vector cross-products. If lines cross, flip the N/S or E/W quadrant of the offending
          bearing using Quadrant Inversion until no crossings exist.

        RULE 3 — QUADRANT INVERSION:
          Place a mental crosshair at your current node. If the printed bearing points 180° AWAY
          from the actual line progression direction, invert both quadrants: N↔S and E↔W.
          Example: "N 45°22'10" E" becomes "S 45°22'10" W". Do NOT double-reverse.

        RULE 4 — CURVE DIRECTION (Left vs. Right):
          Imagine driving a vehicle CLOCKWISE along the chord bearing:
          - Arc bows OUT to the LEFT of the driver (away from lot center) → "Left"
          - Arc bows OUT to the RIGHT of the driver (toward lot center) → "Right"
          Standard exterior rounded corners in a clockwise traverse are always Right turns.
          Cuts into the property interior are Left turns.

        RULE 5 — EXPLICIT CHORD DATA (No Pixel Estimation):
          For ALL curve segments, you MUST extract the explicit CHORD BEARING and CHORD DISTANCE
          from the plat's curve table. NEVER estimate distances from pixel dimensions.
          Also extract: Delta (central angle), Radius, Arc Length.
          Hunt for hidden L-tag deflection curves (L1, L2, etc.) between straight segments.

        RULE 6 — MEANDER BOUNDARIES:
          If a segment follows a meandering waterway, creek, river boundary, shoreline, road
          centerline, or other irregular line with no defined bearing and/or distance, set
          "IsUnknown": true and set bearing/distance to null. Do NOT fabricate or guess a bearing
          or distance. The system will mathematically solve the straight-line tie vector using
          inverse gap computation.

        RULE 7 — DECOY ELIMINATION:
          IGNORE: dashed easement lines, setback lines, radial tie lines to circle centers,
          curve tables belonging to adjacent parcels. Only trace the HEAVY outer boundary.
          Before generating JSON, physically count boundary lines and state each quadrant direction
          to avoid transcribing decoy tables from adjacent lots.

        RULE 8 — STRICT JSON FORMATTING:
          No leading zeros on integers. No unescaped newlines inside strings.
          No trailing commas. Bearing strings must use degree symbol (°), apostrophe ('), and
          quote (") for DMS. Format: "N45°30'00\"E".

        =========================================
        OUTPUT JSON SCHEMA
        =========================================
        Return ONLY a valid JSON object in this EXACT format. No markdown fences, no explanation.

        {
          "Classification": "METES_BOUNDS",
          "PreambleFound": false,
          "MentalMapSummary": "8 segments: East side runs NW, North side runs SW...",
          "Segments": [
            {
              "Type": "Line",
              "Bearing": "N45°22'10\"E",
              "Distance": 150.25,
              "IsUnknown": false
            },
            {
              "Type": "Curve",
              "Direction": "Right",
              "Radius": 200.00,
              "Delta": 12.3015,
              "ArcLength": 43.02,
              "ChordBearing": "N51°15'30\"E",
              "ChordDistance": 42.88,
              "IsUnknown": false
            }
          ]
        }

        IMPORTANT: Segments array must be in CLOCKWISE order starting with the first course
        AFTER the POB, ending with the last course that returns TO the POB.
        Do NOT include the POB itself as a segment.
        """;
}
