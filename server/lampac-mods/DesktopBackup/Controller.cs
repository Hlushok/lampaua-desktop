using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Newtonsoft.Json.Linq;
using Shared;
using System;
using System.IO;
using System.Text;
using System.Threading.Tasks;

namespace DesktopBackup;

public class DesktopBackupController : BaseController
{
    const int BackupTtlSeconds = 3600;
    const int MaxPayloadBytes = 10 * 1024 * 1024;
    static readonly string StorageDir = Path.Combine("database", "desktop-backup");

    [HttpOptions]
    [AllowAnonymous]
    [Route("/database/desktop-backup/upload.php")]
    [Route("/database/desktop-backup/download.php")]
    public ActionResult Options()
    {
        SetCorsHeaders("GET, POST, OPTIONS");
        return StatusCode(204);
    }

    [HttpPost]
    [AllowAnonymous]
    [Route("/database/desktop-backup/upload.php")]
    async public Task<ActionResult> Upload()
    {
        SetCorsHeaders("POST, OPTIONS");
        EnsureStorageDir();
        CleanupExpiredBackups();

        using var reader = new StreamReader(Request.Body, Encoding.UTF8);
        string rawBody = await reader.ReadToEndAsync();

        if (string.IsNullOrEmpty(rawBody) || Encoding.UTF8.GetByteCount(rawBody) > MaxPayloadBytes)
            return Json(new { success = false, message = "Invalid request body" });

        string data;

        try
        {
            var payload = JObject.Parse(rawBody);
            data = payload.Value<string>("data");
        }
        catch
        {
            return Json(new { success = false, message = "Invalid JSON" });
        }

        if (string.IsNullOrEmpty(data))
            return Json(new { success = false, message = "Missing backup data" });

        string id = GenerateBackupId();
        var backup = new JObject
        {
            ["createdAt"] = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
            ["expiresAt"] = DateTimeOffset.UtcNow.AddSeconds(BackupTtlSeconds).ToUnixTimeSeconds(),
            ["data"] = data
        };

        await System.IO.File.WriteAllTextAsync(Path.Combine(StorageDir, $"{id}.json"), backup.ToString(Newtonsoft.Json.Formatting.None));

        return Json(new { success = true, id });
    }

    [HttpGet]
    [AllowAnonymous]
    [Route("/database/desktop-backup/download.php")]
    public ActionResult Download([FromQuery] string id)
    {
        SetCorsHeaders("GET, OPTIONS");

        if (string.IsNullOrEmpty(id) || !System.Text.RegularExpressions.Regex.IsMatch(id, "^\\d{10}$"))
            return Json(new { success = false, message = "Invalid backup id" });

        string filePath = Path.Combine(StorageDir, $"{id}.json");

        if (!System.IO.File.Exists(filePath))
            return Json(new { success = false, message = "Backup not found" });

        JObject backup;

        try
        {
            backup = JObject.Parse(System.IO.File.ReadAllText(filePath, Encoding.UTF8));
        }
        catch
        {
            return Json(new { success = false, message = "Backup is corrupted" });
        }

        long expiresAt = backup.Value<long?>("expiresAt") ?? 0;
        if (expiresAt <= DateTimeOffset.UtcNow.ToUnixTimeSeconds())
        {
            TryDelete(filePath);
            return Json(new { success = false, message = "Backup expired" });
        }

        string data = backup.Value<string>("data");
        if (string.IsNullOrEmpty(data))
            return Json(new { success = false, message = "Backup is corrupted" });

        return Json(new { success = true, data });
    }

    static void EnsureStorageDir()
    {
        Directory.CreateDirectory(StorageDir);
    }

    static void CleanupExpiredBackups()
    {
        EnsureStorageDir();

        foreach (string filePath in Directory.EnumerateFiles(StorageDir, "*.json"))
        {
            try
            {
                var backup = JObject.Parse(System.IO.File.ReadAllText(filePath, Encoding.UTF8));
                long expiresAt = backup.Value<long?>("expiresAt") ?? 0;

                if (expiresAt <= DateTimeOffset.UtcNow.ToUnixTimeSeconds())
                    TryDelete(filePath);
            }
            catch
            {
                TryDelete(filePath);
            }
        }
    }

    static string GenerateBackupId()
    {
        string id;
        string filePath;

        do
        {
            id = Random.Shared.NextInt64(1000000000L, 10000000000L).ToString();
            filePath = Path.Combine(StorageDir, $"{id}.json");
        }
        while (System.IO.File.Exists(filePath));

        return id;
    }

    static void TryDelete(string filePath)
    {
        try
        {
            System.IO.File.Delete(filePath);
        }
        catch { }
    }

    void SetCorsHeaders(string methods)
    {
        Response.Headers["Access-Control-Allow-Origin"] = "*";
        Response.Headers["Access-Control-Allow-Methods"] = methods;
        Response.Headers["Access-Control-Allow-Headers"] = "Content-Type";
    }
}
