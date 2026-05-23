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
            Environment.SetEnvironmentVariable(parts[0].Trim(), parts[1].Trim());
        }
    }
}


var builder = WebApplication.CreateBuilder(args);

builder.Services.AddControllers();
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

// CORS — Vite dev + production domain
builder.Services.AddCors(opts => opts.AddPolicy("BoundaryIQ", p =>
    p.WithOrigins(
        "http://localhost:5173",
        "http://localhost:5174",
        "http://localhost:5175",
        "http://localhost:3000",
        "https://thebluemind.com",
        "https://www.thebluemind.com"
    )
    .AllowAnyMethod()
    .AllowAnyHeader()
));

// HttpClient for Gemini API calls
builder.Services.AddHttpClient("gemini", client =>
{
    client.Timeout = TimeSpan.FromSeconds(120); // Vision calls can be slow on large images
});

// Application services
builder.Services.AddSingleton<DiagnosticsDatabaseService>();
builder.Services.AddScoped<TraverseService>();
builder.Services.AddScoped<GeminiVisionService>();
builder.Services.AddScoped<LegalDescriptionWriter>();

var app = builder.Build();

app.UseCors("BoundaryIQ");

app.UseSwagger();
app.UseSwaggerUI(c =>
{
    c.SwaggerEndpoint("/swagger/v1/swagger.json", "Boundary.IQ API v1");
    c.RoutePrefix = "swagger";
});

app.UseHttpsRedirection();
app.UseAuthorization();
app.MapControllers();

app.Run();
