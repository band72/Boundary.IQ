using System;
using System.IO;
using System.Collections.Generic;
using Microsoft.Data.Sqlite;
using BoundaryIQ.Api.Models;

namespace BoundaryIQ.Api.Services;

public class DiagnosticsDatabaseService
{
    private readonly string _dbPath;
    private static readonly object _dbLock = new();

    public DiagnosticsDatabaseService()
    {
        string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        string folder = Path.Combine(appData, "BoundaryQC");
        Directory.CreateDirectory(folder);
        _dbPath = Path.Combine(folder, "BoundaryQCDiagnostics.db");

        InitializeDatabase();

        // Auto-purge logs older than 90 days on startup
        PurgeOldLogs(90);
    }

    private void InitializeDatabase()
    {
        lock (_dbLock)
        {
            using var conn = new SqliteConnection($"Data Source={_dbPath}");
            conn.Open();

        using var cmd = conn.CreateCommand();
        cmd.CommandText = @"
            CREATE TABLE IF NOT EXISTS BatchRuns (
                BatchId TEXT PRIMARY KEY,
                Timestamp TEXT NOT NULL,
                TotalFiles INTEGER NOT NULL,
                PassRate REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS DeedLogs (
                Id INTEGER PRIMARY KEY AUTOINCREMENT,
                BatchId TEXT NOT NULL,
                FileName TEXT NOT NULL,
                ParcelName TEXT,
                GeoCallCount INTEGER NOT NULL,
                LinearError REAL NOT NULL,
                PrecisionRatio REAL NOT NULL,
                Status TEXT NOT NULL,
                RepairStageUsed TEXT,
                Timestamp TEXT NOT NULL,
                ExtractionJson TEXT,
                TraverseJson TEXT,
                FOREIGN KEY (BatchId) REFERENCES BatchRuns(BatchId)
            );

            CREATE TABLE IF NOT EXISTS HeuristicTracking (
                Id INTEGER PRIMARY KEY AUTOINCREMENT,
                ProblemName TEXT NOT NULL,
                SolutionApplied TEXT NOT NULL,
                SuccessCount INTEGER NOT NULL DEFAULT 0
            );
        ";
        cmd.ExecuteNonQuery();

        // Run migrations for existing database schemas to support auto-solve lookup
        try
        {
            using var alterCmd1 = conn.CreateCommand();
            alterCmd1.CommandText = "ALTER TABLE DeedLogs ADD COLUMN ExtractionJson TEXT";
            alterCmd1.ExecuteNonQuery();
        }
        catch (SqliteException) { /* Already exists */ }

        try
        {
            using var alterCmd2 = conn.CreateCommand();
            alterCmd2.CommandText = "ALTER TABLE DeedLogs ADD COLUMN TraverseJson TEXT";
            alterCmd2.ExecuteNonQuery();
        }
        catch (SqliteException) { /* Already exists */ }

        // Seed Heuristics if empty
        using var checkCmd = conn.CreateCommand();
        checkCmd.CommandText = "SELECT COUNT(*) FROM HeuristicTracking";
        long count = (long)(checkCmd.ExecuteScalar() ?? 0L);
        if (count == 0)
        {
            var seedData = new[]
            {
                ("Sequence Out of Order", "Moore-Neighbor Rearrange"),
                ("Intersecting Boundary", "Bowtie Inversion Auto-Fix"),
                ("Ambiguous Arc Concavity", "Convexity Right Turn Rule"),
                ("Shoreline Centerline Meanders", "Shoreline Gap Solver"),
                ("Pixel Dimension guessing", "Explicit Chord Parsing")
            };
            foreach (var (p, s) in seedData)
            {
                using var insertCmd = conn.CreateCommand();
                insertCmd.CommandText = "INSERT INTO HeuristicTracking (ProblemName, SolutionApplied, SuccessCount) VALUES (@p, @s, 0)";
                insertCmd.Parameters.AddWithValue("@p", p);
                insertCmd.Parameters.AddWithValue("@s", s);
                insertCmd.ExecuteNonQuery();
            }
            }
        }
    }

    public void SaveBatchRun(string batchId, int totalFiles, double passRate)
    {
        lock (_dbLock)
        {
            using var conn = new SqliteConnection($"Data Source={_dbPath}");
            conn.Open();

        using var cmd = conn.CreateCommand();
        cmd.CommandText = @"
            INSERT OR REPLACE INTO BatchRuns (BatchId, Timestamp, TotalFiles, PassRate)
            VALUES (@batchId, @timestamp, @totalFiles, @passRate)
        ";
        cmd.Parameters.AddWithValue("@batchId", batchId);
        cmd.Parameters.AddWithValue("@timestamp", DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"));
        cmd.Parameters.AddWithValue("@totalFiles", totalFiles);
        cmd.Parameters.AddWithValue("@passRate", passRate);
        cmd.ExecuteNonQuery();
        }
    }

    public void SaveDeedLog(
        string batchId,
        string fileName,
        string? parcelName,
        int geoCallCount,
        double linearError,
        double precisionRatio,
        string status,
        string? repairStageUsed,
        string? extractionJson = null,
        string? traverseJson = null)
    {
        lock (_dbLock)
        {
            using var conn = new SqliteConnection($"Data Source={_dbPath}");
            conn.Open();

        using var cmd = conn.CreateCommand();
        cmd.CommandText = @"
            INSERT INTO DeedLogs (BatchId, FileName, ParcelName, GeoCallCount, LinearError, PrecisionRatio, Status, RepairStageUsed, Timestamp, ExtractionJson, TraverseJson)
            VALUES (@batchId, @fileName, @parcelName, @geoCallCount, @linearError, @precisionRatio, @status, @repairStageUsed, @timestamp, @extractionJson, @traverseJson)
        ";
        cmd.Parameters.AddWithValue("@batchId", batchId);
        cmd.Parameters.AddWithValue("@fileName", fileName);
        cmd.Parameters.AddWithValue("@parcelName", (object?)parcelName ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@geoCallCount", geoCallCount);
        cmd.Parameters.AddWithValue("@linearError", linearError);
        cmd.Parameters.AddWithValue("@precisionRatio", precisionRatio);
        cmd.Parameters.AddWithValue("@status", status);
        cmd.Parameters.AddWithValue("@repairStageUsed", (object?)repairStageUsed ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@timestamp", DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"));
        cmd.Parameters.AddWithValue("@extractionJson", (object?)extractionJson ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@traverseJson", (object?)traverseJson ?? DBNull.Value);
        cmd.ExecuteNonQuery();
        }
    }

    public List<DeedLogDto> SearchDeedLogs(string? query, string? status, double? maxError)
    {
        var logs = new List<DeedLogDto>();
        using var conn = new SqliteConnection($"Data Source={_dbPath}");
        conn.Open();

        using var cmd = conn.CreateCommand();
        var sql = "SELECT * FROM DeedLogs WHERE 1=1";

        if (!string.IsNullOrEmpty(query))
        {
            sql += " AND (FileName LIKE @query OR ParcelName LIKE @query)";
            cmd.Parameters.AddWithValue("@query", $"%{query}%");
        }
        if (!string.IsNullOrEmpty(status))
        {
            sql += " AND Status = @status";
            cmd.Parameters.AddWithValue("@status", status);
        }
        if (maxError.HasValue)
        {
            sql += " AND LinearError <= @maxError";
            cmd.Parameters.AddWithValue("@maxError", maxError.Value);
        }

        sql += " ORDER BY Timestamp DESC LIMIT 100";
        cmd.CommandText = sql;

        using var reader = cmd.ExecuteReader();
        while (reader.Read())
        {
            logs.Add(new DeedLogDto(
                Id: reader.GetInt32(0),
                BatchId: reader.GetString(1),
                FileName: reader.GetString(2),
                ParcelName: reader.IsDBNull(3) ? null : reader.GetString(3),
                GeoCallCount: reader.GetInt32(4),
                LinearError: reader.GetDouble(5),
                PrecisionRatio: reader.GetDouble(6),
                Status: reader.GetString(7),
                RepairStageUsed: reader.IsDBNull(8) ? null : reader.GetString(8),
                Timestamp: reader.GetString(9),
                ExtractionJson: reader.IsDBNull(10) ? null : reader.GetString(10),
                TraverseJson: reader.IsDBNull(11) ? null : reader.GetString(11)
            ));
        }

        return logs;
    }

    public DeedLogDto? FindSolvedCase(string fileName)
    {
        using var conn = new SqliteConnection($"Data Source={_dbPath}");
        conn.Open();

        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT * FROM DeedLogs WHERE FileName = @fileName AND Status = 'PASS' ORDER BY Timestamp DESC LIMIT 1";
        cmd.Parameters.AddWithValue("@fileName", fileName);

        using var reader = cmd.ExecuteReader();
        if (reader.Read())
        {
            return new DeedLogDto(
                Id: reader.GetInt32(0),
                BatchId: reader.GetString(1),
                FileName: reader.GetString(2),
                ParcelName: reader.IsDBNull(3) ? null : reader.GetString(3),
                GeoCallCount: reader.GetInt32(4),
                LinearError: reader.GetDouble(5),
                PrecisionRatio: reader.GetDouble(6),
                Status: reader.GetString(7),
                RepairStageUsed: reader.IsDBNull(8) ? null : reader.GetString(8),
                Timestamp: reader.GetString(9),
                ExtractionJson: reader.IsDBNull(10) ? null : reader.GetString(10),
                TraverseJson: reader.IsDBNull(11) ? null : reader.GetString(11)
            );
        }

        return null;
    }

    public List<BatchRunDto> GetRecentBatchRuns()
    {
        var runs = new List<BatchRunDto>();
        using var conn = new SqliteConnection($"Data Source={_dbPath}");
        conn.Open();

        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT * FROM BatchRuns ORDER BY Timestamp DESC LIMIT 20";

        using var reader = cmd.ExecuteReader();
        while (reader.Read())
        {
            runs.Add(new BatchRunDto(
                BatchId: reader.GetString(0),
                Timestamp: reader.GetString(1),
                TotalFiles: reader.GetInt32(2),
                PassRate: reader.GetDouble(3)
            ));
        }

        return runs;
    }

    public List<HeuristicTrackerDto> GetHeuristicTracking()
    {
        var tracking = new List<HeuristicTrackerDto>();
        using var conn = new SqliteConnection($"Data Source={_dbPath}");
        conn.Open();

        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT * FROM HeuristicTracking ORDER BY SuccessCount DESC";

        using var reader = cmd.ExecuteReader();
        while (reader.Read())
        {
            tracking.Add(new HeuristicTrackerDto(
                Id: reader.GetInt32(0),
                ProblemName: reader.GetString(1),
                SolutionApplied: reader.GetString(2),
                SuccessCount: reader.GetInt32(3)
            ));
        }

        return tracking;
    }

    public void IncrementHeuristic(string problemName, string solutionApplied)
    {
        lock (_dbLock)
        {
            using var conn = new SqliteConnection($"Data Source={_dbPath}");
            conn.Open();

        using var checkCmd = conn.CreateCommand();
        checkCmd.CommandText = "SELECT Id FROM HeuristicTracking WHERE ProblemName = @p AND SolutionApplied = @s";
        checkCmd.Parameters.AddWithValue("@p", problemName);
        checkCmd.Parameters.AddWithValue("@s", solutionApplied);
        var id = checkCmd.ExecuteScalar();

        if (id != null)
        {
            using var updateCmd = conn.CreateCommand();
            updateCmd.CommandText = "UPDATE HeuristicTracking SET SuccessCount = SuccessCount + 1 WHERE Id = @id";
            updateCmd.Parameters.AddWithValue("@id", id);
            updateCmd.ExecuteNonQuery();
        }
        else
        {
            using var insertCmd = conn.CreateCommand();
            insertCmd.CommandText = "INSERT INTO HeuristicTracking (ProblemName, SolutionApplied, SuccessCount) VALUES (@p, @s, 1)";
            insertCmd.Parameters.AddWithValue("@p", problemName);
            insertCmd.Parameters.AddWithValue("@s", solutionApplied);
            insertCmd.ExecuteNonQuery();
        }
        }
    }

    // ── Database Management ──────────────────────────────────────────────────────

    /// <summary>Returns database file size, row counts, and date range for dashboard display.</summary>
    public object GetDatabaseStats()
    {
        var fileInfo = new FileInfo(_dbPath);
        long fileSizeBytes = fileInfo.Exists ? fileInfo.Length : 0;

        using var conn = new SqliteConnection($"Data Source={_dbPath}");
        conn.Open();

        long deedCount = 0, batchCount = 0, heuristicCount = 0;
        long passCount = 0, failCount = 0;
        string? oldestLog = null, newestLog = null;

        using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = "SELECT COUNT(*) FROM DeedLogs";
            deedCount = (long)(cmd.ExecuteScalar() ?? 0L);
        }
        using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = "SELECT COUNT(*) FROM DeedLogs WHERE Status = 'PASS'";
            passCount = (long)(cmd.ExecuteScalar() ?? 0L);
        }
        using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = "SELECT COUNT(*) FROM DeedLogs WHERE Status != 'PASS'";
            failCount = (long)(cmd.ExecuteScalar() ?? 0L);
        }
        using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = "SELECT COUNT(*) FROM BatchRuns";
            batchCount = (long)(cmd.ExecuteScalar() ?? 0L);
        }
        using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = "SELECT COUNT(*) FROM HeuristicTracking";
            heuristicCount = (long)(cmd.ExecuteScalar() ?? 0L);
        }
        using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = "SELECT MIN(Timestamp), MAX(Timestamp) FROM DeedLogs";
            using var reader = cmd.ExecuteReader();
            if (reader.Read())
            {
                oldestLog = reader.IsDBNull(0) ? null : reader.GetString(0);
                newestLog = reader.IsDBNull(1) ? null : reader.GetString(1);
            }
        }

        return new
        {
            dbPath = _dbPath,
            fileSizeMb = Math.Round(fileSizeBytes / 1048576.0, 2),
            fileSizeBytes,
            deedLogCount = deedCount,
            passCount,
            failCount,
            batchRunCount = batchCount,
            heuristicCount,
            oldestTimestamp = oldestLog,
            newestTimestamp = newestLog,
        };
    }

    /// <summary>Deletes DeedLogs and BatchRuns older than the specified number of days.</summary>
    public int PurgeOldLogs(int retentionDays)
    {
        var cutoff = DateTime.Now.AddDays(-retentionDays).ToString("yyyy-MM-dd HH:mm:ss");
        int totalDeleted = 0;

        lock (_dbLock)
        {
            using var conn = new SqliteConnection($"Data Source={_dbPath}");
            conn.Open();

            using (var cmd = conn.CreateCommand())
            {
                cmd.CommandText = "DELETE FROM DeedLogs WHERE Timestamp < @cutoff";
                cmd.Parameters.AddWithValue("@cutoff", cutoff);
                totalDeleted += cmd.ExecuteNonQuery();
            }
            using (var cmd = conn.CreateCommand())
            {
                cmd.CommandText = "DELETE FROM BatchRuns WHERE Timestamp < @cutoff";
                cmd.Parameters.AddWithValue("@cutoff", cutoff);
                totalDeleted += cmd.ExecuteNonQuery();
            }
            // Reclaim disk space
            using (var cmd = conn.CreateCommand())
            {
                cmd.CommandText = "VACUUM";
                cmd.ExecuteNonQuery();
            }
        }
        return totalDeleted;
    }

    /// <summary>Clears only failed/non-PASS deed logs so they will be retried on the next run.</summary>
    public int ClearFailedCache()
    {
        lock (_dbLock)
        {
            using var conn = new SqliteConnection($"Data Source={_dbPath}");
            conn.Open();
            int deleted;
            using (var cmd = conn.CreateCommand())
            {
                cmd.CommandText = "DELETE FROM DeedLogs WHERE Status != 'PASS'";
                deleted = cmd.ExecuteNonQuery();
            }
            using (var cmd = conn.CreateCommand())
            {
                cmd.CommandText = "VACUUM";
                cmd.ExecuteNonQuery();
            }
            return deleted;
        }
    }

    /// <summary>Wipes all DeedLogs and BatchRuns. Heuristic counters are preserved.</summary>
    public int ClearAllCache()
    {
        lock (_dbLock)
        {
            using var conn = new SqliteConnection($"Data Source={_dbPath}");
            conn.Open();
            int deleted = 0;
            using (var cmd = conn.CreateCommand())
            {
                cmd.CommandText = "DELETE FROM DeedLogs";
                deleted += cmd.ExecuteNonQuery();
            }
            using (var cmd = conn.CreateCommand())
            {
                cmd.CommandText = "DELETE FROM BatchRuns";
                deleted += cmd.ExecuteNonQuery();
            }
            using (var cmd = conn.CreateCommand())
            {
                cmd.CommandText = "VACUUM";
                cmd.ExecuteNonQuery();
            }
            return deleted;
        }
    }
}
