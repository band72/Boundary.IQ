using System.Diagnostics;

namespace BoundaryIQ.Api.Services;

/// <summary>
/// Converts .doc and .docx files to PDF using LibreOffice headless mode.
/// Falls back gracefully if LibreOffice is not installed.
/// </summary>
public class DocConversionService
{
    private readonly ILogger<DocConversionService> _log;

    public DocConversionService(ILogger<DocConversionService> log)
    {
        _log = log;
    }

    /// <summary>
    /// Returns true if the file extension is a Word document that needs conversion.
    /// </summary>
    public static bool IsWordDocument(string fileName)
    {
        var ext = Path.GetExtension(fileName).ToLowerInvariant();
        return ext is ".doc" or ".docx";
    }

    /// <summary>
    /// Returns the correct MIME type for a given file extension.
    /// </summary>
    public static string GetMimeType(string fileName)
    {
        var ext = Path.GetExtension(fileName).ToLowerInvariant();
        return ext switch
        {
            ".doc"  => "application/msword",
            ".docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ".pdf"  => "application/pdf",
            ".jpg" or ".jpeg" => "image/jpeg",
            ".png"  => "image/png",
            ".webp" => "image/webp",
            _       => "application/octet-stream"
        };
    }

    /// <summary>
    /// Converts a Word document (doc/docx) to PDF bytes using LibreOffice headless.
    /// Returns (pdfBytes, "application/pdf") on success, or throws on failure.
    /// </summary>
    public async Task<byte[]> ConvertToPdfAsync(byte[] docBytes, string fileName, CancellationToken ct = default)
    {
        var tempDir = Path.Combine(Path.GetTempPath(), $"biq_doc_{Guid.NewGuid():N}");
        Directory.CreateDirectory(tempDir);

        try
        {
            // Write the doc file to temp
            var inputPath = Path.Combine(tempDir, fileName);
            await File.WriteAllBytesAsync(inputPath, docBytes, ct);

            // Run LibreOffice headless conversion
            var psi = new ProcessStartInfo
            {
                FileName = "libreoffice",
                Arguments = $"--headless --convert-to pdf --outdir \"{tempDir}\" \"{inputPath}\"",
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };

            _log.LogInformation("Converting {file} to PDF via LibreOffice...", fileName);

            using var process = Process.Start(psi)
                ?? throw new Exception("Failed to start LibreOffice process.");

            // Wait with timeout (60 seconds should be plenty for a single doc)
            var timeoutTask = Task.Delay(60_000, ct);
            var waitTask = process.WaitForExitAsync(ct);
            var completed = await Task.WhenAny(waitTask, timeoutTask);

            if (completed == timeoutTask)
            {
                process.Kill(true);
                throw new Exception($"LibreOffice conversion timed out for {fileName}.");
            }

            if (process.ExitCode != 0)
            {
                var stderr = await process.StandardError.ReadToEndAsync(ct);
                throw new Exception($"LibreOffice conversion failed (exit {process.ExitCode}): {stderr}");
            }

            // Find the output PDF
            var baseName = Path.GetFileNameWithoutExtension(fileName);
            var pdfPath = Path.Combine(tempDir, baseName + ".pdf");

            if (!File.Exists(pdfPath))
                throw new Exception($"LibreOffice did not produce expected output: {pdfPath}");

            var pdfBytes = await File.ReadAllBytesAsync(pdfPath, ct);
            _log.LogInformation("Converted {file} → PDF ({size:F1} KB)", fileName, pdfBytes.Length / 1024.0);

            return pdfBytes;
        }
        finally
        {
            // Clean up temp directory
            try { Directory.Delete(tempDir, true); }
            catch { /* best effort cleanup */ }
        }
    }
}
