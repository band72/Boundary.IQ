using BoundaryIQ.Api.Services;

// Load .env file if it exists in the current, parent, or grandparent directories
var currentDir = new DirectoryInfo(Directory.GetCurrentDirectory());
string? envPath = null;
while (currentDir != null)
{
    var tempPath = Path.Combine(currentDir.FullName, ".env");
    if (File.Exists(tempPath))
    {
        envPath = tempPath;
        break;
    }
    currentDir = currentDir.Parent;
}

if (envPath != null)
{
    foreach (var line in File.ReadAllLines(envPath))
    {
        if (string.IsNullOrWhiteSpace(line) || line.StartsWith('#')) continue;
        var parts = line.Split('=', 2);
        if (parts.Length == 2)
        {
            var val = parts[1].Trim().Trim('"').Trim('\'');
            Environment.SetEnvironmentVariable(parts[0].Trim(), val);
        }
    }
}


var builder = WebApplication.CreateBuilder(args);

builder.Services.AddControllers()
    .AddJsonOptions(opts =>
    {
        // All JSON responses use camelCase so the frontend doesn't need to normalize field names
        opts.JsonSerializerOptions.PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase;
        // Be tolerant when reading stored PascalCase JSON from SQLite
        opts.JsonSerializerOptions.PropertyNameCaseInsensitive = true;
    });
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen(c =>
{
    c.SwaggerDoc("v1", new()
    {
        Title = "Boundary.IQ API",
        Version = "v1",
        Description = "Survey traverse computation and AI plat boundary extraction powered by the RCS COGO Engine + Google Gemini Vision."
    });
});

// CORS — restrict to known frontend origin
// WARNING: In production, set this to your actual domain
builder.Services.AddCors(opts => opts.AddPolicy("BoundaryIQ", p =>
    p.WithOrigins("http://localhost:5174", "http://localhost:5173")
     .AllowAnyMethod()
     .AllowAnyHeader()
));

// HttpClient for Gemini API calls
builder.Services.AddHttpClient("gemini", client =>
{
    client.Timeout = TimeSpan.FromSeconds(300); // Large batches can take 25s+ per file
});

// Application services
builder.Services.AddSingleton<DiagnosticsDatabaseService>();
builder.Services.AddScoped<TraverseService>();
builder.Services.AddScoped<GeminiVisionService>();
builder.Services.AddScoped<LegalDescriptionWriter>();
builder.Services.AddScoped<RepairService>();
builder.Services.AddScoped<DocConversionService>();
builder.Services.AddScoped<OutputService>();

var app = builder.Build();

app.UseCors("BoundaryIQ");

app.UseSwagger();
app.UseSwaggerUI(c =>
{
    c.SwaggerEndpoint("/swagger/v1/swagger.json", "Boundary.IQ API v1");
    c.RoutePrefix = "swagger";
});

if (!app.Environment.IsDevelopment())
{
    app.UseHttpsRedirection();
}
app.UseAuthorization();
app.MapControllers();

app.Run();
