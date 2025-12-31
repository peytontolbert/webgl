using System;
using System.IO;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.IO.Compression;
using SharpDX;
using CodeWalker.GameFiles;

namespace CodeWalker.Cli
{
    class Program
    {
        static void Main(string[] args)
        {
            try
            {
                if (args.Length < 1)
                {
                    PrintUsage();
                    return;
                }

                var command = args[0]?.ToLowerInvariant() ?? "";
                var parsed = ParseArgs(args);

                switch (command)
                {
                    case "extract":
                        RunExtract(parsed);
                        break;
                    case "extract-ysc":
                    case "extract-scripts":
                        RunExtractYsc(parsed);
                        break;
                    case "list":
                        RunList(parsed);
                        break;
                    case "find": // alias for list (friendlier name)
                        RunList(parsed);
                        break;
                    case "ytyp-to-json":
                        RunYtypToJson(parsed);
                        break;
                    case "ytyp-export-dir":
                        RunYtypExportDir(parsed);
                        break;
                    default:
                        PrintUsage();
                        return;
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"Error: {ex.Message}");
                Console.Error.WriteLine(ex.StackTrace);
                Environment.Exit(1);
            }
        }

        private static void PrintUsage()
        {
            Console.WriteLine("CodeWalker.Cli");
            Console.WriteLine("");
            Console.WriteLine("Commands:");
            Console.WriteLine("  extract --game <gta_root> --rpf <rpf_path> --file <file_path> --output <output_path>");
            Console.WriteLine("  extract --game <gta_root> --rpf <rpf_path> --glob <glob_pattern> --outdir <output_dir> [--preserve-paths true|false]");
            Console.WriteLine("  extract-ysc --game <gta_root> --rpf <rpf_path> --outdir <output_dir> [--glob <glob_pattern>] [--preserve-paths true|false]");
            Console.WriteLine("  extract-scripts (alias for extract-ysc)");
            Console.WriteLine("  list    --game <gta_root> --rpf <rpf_path> --glob <glob_pattern>");
            Console.WriteLine("  find    --game <gta_root> --rpf <rpf_path> --glob <glob_pattern>   (alias for list)");
            Console.WriteLine("  ytyp-to-json --input <file.ytyp> --output <file.json> [--source <string>]");
            Console.WriteLine("  ytyp-export-dir --input-dir <dir> --output-dir <dir>");
            Console.WriteLine("");
            Console.WriteLine("Notes:");
            Console.WriteLine("  - --glob matches against the full entry path as stored by CodeWalker (uses backslashes).");
            Console.WriteLine("  - Typical patterns: \"*.ybn\", \"*.ymap\", \"common\\\\data\\\\levels\\\\gta5\\\\*.dat\"");
            Console.WriteLine("  - extract-ysc tries to fully decrypt + decompress .ysc scripts (not just raw RPF bytes).");
        }

        private static Dictionary<string, string> ParseArgs(string[] args)
        {
            var dict = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            // args[0] is command
            for (int i = 1; i < args.Length; i++)
            {
                var key = args[i];
                if (!key.StartsWith("--")) continue;
                string value = "true";
                if (i + 1 < args.Length && !args[i + 1].StartsWith("--"))
                {
                    value = args[++i];
                }
                dict[key] = value;
            }
            return dict;
        }

        private static void EnsureGameAndRpf(Dictionary<string, string> args, out string gamePath, out string rpfPath)
        {
            args.TryGetValue("--game", out gamePath);
            args.TryGetValue("--rpf", out rpfPath);

            if (string.IsNullOrEmpty(gamePath) || string.IsNullOrEmpty(rpfPath))
            {
                Console.Error.WriteLine("Error: Missing required arguments --game and/or --rpf");
                Environment.Exit(2);
            }

            if (!Directory.Exists(gamePath))
            {
                Console.Error.WriteLine($"Error: game path does not exist: {gamePath}");
                Environment.Exit(2);
            }
            if (!File.Exists(rpfPath))
            {
                Console.Error.WriteLine($"Error: rpf file does not exist: {rpfPath}");
                Environment.Exit(2);
            }

            // Initialize GTA5 encryption
            // This expects to find gta5.exe in the provided game root and uses embedded magic.dat for other keys.
            GTA5Keys.LoadFromPath(gamePath, false);
        }

        private static RpfFile LoadRpf(string rpfPath)
        {
            var rpf = new RpfFile(rpfPath, Path.GetFileName(rpfPath));
            rpf.ScanStructure(
                status => Console.WriteLine($"Status: {status}"),
                error => Console.Error.WriteLine($"Error: {error}")
            );
            if (rpf.LastException != null)
            {
                Console.Error.WriteLine($"Error scanning RPF: {rpf.LastException}");
                Environment.Exit(3);
            }
            return rpf;
        }

        private static Regex GlobToRegex(string glob)
        {
            // Simple wildcard glob:
            // - ** matches across path separators
            // - * matches within a path segment (not backslash)
            // - ? matches a single character (not backslash)
            var g = (glob ?? "").Replace('/', '\\');
            var escaped = Regex.Escape(g);
            escaped = escaped.Replace(@"\*\*", "___DOUBLESTAR___");
            escaped = escaped.Replace(@"\*", "___STAR___");
            escaped = escaped.Replace(@"\?", "___Q___");
            escaped = escaped.Replace("___DOUBLESTAR___", ".*");
            escaped = escaped.Replace("___STAR___", @"[^\\]*");
            escaped = escaped.Replace("___Q___", @"[^\\]");
            return new Regex("^" + escaped + "$", RegexOptions.IgnoreCase | RegexOptions.Compiled);
        }

        private static void RunList(Dictionary<string, string> args)
        {
            EnsureGameAndRpf(args, out var gamePath, out var rpfPath);
            args.TryGetValue("--glob", out var glob);
            if (string.IsNullOrEmpty(glob))
            {
                Console.Error.WriteLine("Error: list requires --glob <pattern>");
                Environment.Exit(2);
            }

            var rpf = LoadRpf(rpfPath);
            var rx = GlobToRegex(glob);
            int count = 0;

            foreach (var entry in rpf.AllEntries)
            {
                if (entry is not RpfFileEntry fe) continue;
                if (string.IsNullOrEmpty(fe.Path)) continue;
                var p = fe.Path.Replace('/', '\\');
                if (rx.IsMatch(p))
                {
                    Console.WriteLine(p);
                    count++;
                }
            }

            Console.Error.WriteLine($"Listed {count} entries from {Path.GetFileName(rpfPath)}");
        }

        private static void RunExtract(Dictionary<string, string> args)
        {
            EnsureGameAndRpf(args, out var gamePath, out var rpfPath);

            args.TryGetValue("--file", out var filePath);
            args.TryGetValue("--output", out var outputPath);
            args.TryGetValue("--glob", out var glob);
            args.TryGetValue("--outdir", out var outdir);
            args.TryGetValue("--preserve-paths", out var preservePathsRaw);
            var preservePaths = true;
            if (!string.IsNullOrEmpty(preservePathsRaw))
            {
                bool.TryParse(preservePathsRaw, out preservePaths);
            }

            if (!string.IsNullOrEmpty(filePath))
            {
                if (string.IsNullOrEmpty(outputPath))
                {
                    Console.Error.WriteLine("Error: extract --file requires --output");
                    Environment.Exit(2);
                }
                ExtractSingleFile(rpfPath, filePath, outputPath);
                return;
            }

            if (!string.IsNullOrEmpty(glob))
            {
                if (string.IsNullOrEmpty(outdir))
                {
                    Console.Error.WriteLine("Error: extract --glob requires --outdir <dir>");
                    Environment.Exit(2);
                }
                ExtractByGlob(rpfPath, glob, outdir, preservePaths);
                return;
            }

            Console.Error.WriteLine("Error: extract requires either --file or --glob");
            Environment.Exit(2);
        }

        private static bool TryInflateDeflate(byte[] input, out byte[] output)
        {
            output = null;
            if (input == null || input.Length < 2) return false;
            try
            {
                using var ms = new MemoryStream(input, writable: false);
                using var ds = new DeflateStream(ms, CompressionMode.Decompress, leaveOpen: false);
                using var outstr = new MemoryStream();
                ds.CopyTo(outstr);
                var buf = outstr.ToArray();
                if (buf == null || buf.Length == 0) return false;
                output = buf;
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static void RunExtractYsc(Dictionary<string, string> args)
        {
            EnsureGameAndRpf(args, out var gamePath, out var rpfPath);

            args.TryGetValue("--glob", out var glob);
            args.TryGetValue("--outdir", out var outdir);
            args.TryGetValue("--preserve-paths", out var preservePathsRaw);

            if (string.IsNullOrEmpty(outdir))
            {
                Console.Error.WriteLine("Error: extract-ysc requires --outdir <dir>");
                Environment.Exit(2);
            }

            var preservePaths = true;
            if (!string.IsNullOrEmpty(preservePathsRaw))
            {
                bool.TryParse(preservePathsRaw, out preservePaths);
            }

            // Default glob: all .ysc entries anywhere in the RPF.
            var effectiveGlob = string.IsNullOrWhiteSpace(glob) ? @"**\*.ysc" : glob;
            var rx = GlobToRegex(effectiveGlob);

            var rpf = LoadRpf(rpfPath);
            var outRoot = Path.GetFullPath(outdir);
            Directory.CreateDirectory(outRoot);

            var rpfRootName = (rpf.Path ?? rpf.NameLower ?? Path.GetFileName(rpfPath)) ?? Path.GetFileName(rpfPath);
            if (rpfRootName.EndsWith(".rpf", StringComparison.OrdinalIgnoreCase) == false)
            {
                rpfRootName = Path.GetFileName(rpfPath);
            }

            int extracted = 0;
            foreach (var entry in rpf.AllEntries)
            {
                if (entry is not RpfFileEntry fe) continue;
                if (string.IsNullOrEmpty(fe.Path)) continue;
                var p = fe.Path.Replace('/', '\\');
                if (!rx.IsMatch(p)) continue;
                if (!p.EndsWith(".ysc", StringComparison.OrdinalIgnoreCase)) continue;

                // Extract file bytes via CodeWalker (handles RPF encryption).
                var data = fe.File.ExtractFile(fe);
                if (data == null || data.Length == 0) continue;

                // Scripts are often deflate-compressed inside the resource payload even after ExtractFile.
                // Attempt an additional raw-deflate inflate step (matching CodeWalker Tools ExtractScripts behavior).
                if (TryInflateDeflate(data, out var inflated))
                {
                    data = inflated;
                }

                string rel;
                if (preservePaths)
                {
                    // Preserve internal path relative to the RPF root.
                    // fe.Path typically starts with "<rpfname>\\...".
                    var prefix = rpfRootName.Replace('/', '\\').TrimEnd('\\') + "\\";
                    if (p.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                    {
                        rel = p.Substring(prefix.Length);
                    }
                    else
                    {
                        // Fallback: drop the first segment (rpf name)
                        var idx = p.IndexOf('\\');
                        rel = (idx >= 0) ? p.Substring(idx + 1) : fe.Name;
                    }
                }
                else
                {
                    rel = fe.Name;
                }

                // Normalize separators for the current OS.
                rel = rel.Replace('\\', Path.DirectorySeparatorChar).Replace('/', Path.DirectorySeparatorChar);

                var dest = Path.Combine(outRoot, rel);
                Directory.CreateDirectory(Path.GetDirectoryName(dest) ?? outRoot);

                // Avoid overwriting if two scripts collide in output.
                if (File.Exists(dest))
                {
                    var baseName = Path.GetFileNameWithoutExtension(dest);
                    var ext = Path.GetExtension(dest);
                    var dir = Path.GetDirectoryName(dest) ?? outRoot;
                    int n = 1;
                    string candidate;
                    do
                    {
                        candidate = Path.Combine(dir, $"{baseName}_dup{n}{ext}");
                        n++;
                    } while (File.Exists(candidate) && n < 1000);
                    dest = candidate;
                }

                File.WriteAllBytes(dest, data);
                extracted++;
            }

            Console.WriteLine($"Extracted {extracted} .ysc files matching '{effectiveGlob}' from {Path.GetFileName(rpfPath)} into {outRoot}");
        }

        private static void ExtractSingleFile(string rpfPath, string filePath, string outputPath)
        {
            var rpf = LoadRpf(rpfPath);

            // Find and extract file.
            // CodeWalker stores entry paths including the RPF name as the root, eg:
            //   "common.rpf\\data\\levels\\gta5\\heightmap.dat"
            // So accept either a full path or a path relative to the RPF root.
            var normalized = (filePath ?? "").Replace('/', '\\').TrimStart('\\');
            var search = normalized.ToLowerInvariant();
            var root = (rpf.Path ?? rpf.NameLower ?? Path.GetFileName(rpfPath)).ToLowerInvariant();

            // Build candidate full paths.
            var full1 = search;
            var full2 = $"{root}\\{search}".Replace("\\\\", "\\");

            RpfFileEntry match = null;
            foreach (var entry in rpf.AllEntries)
            {
                if (entry is not RpfFileEntry fe) continue;
                if (fe.Path == null) continue;
                var p = fe.Path.ToLowerInvariant();
                if (p == full1 || p == full2 || p.EndsWith("\\" + search))
                {
                    match = fe;
                    break;
                }
            }
            if (match == null)
            {
                Console.Error.WriteLine($"File not found: {filePath}");
                Environment.Exit(4);
            }

            var data = match.File.ExtractFile(match);
            if (data == null || data.Length == 0)
            {
                Console.Error.WriteLine($"Failed to extract file: {filePath}");
                Environment.Exit(5);
            }

            Directory.CreateDirectory(Path.GetDirectoryName(outputPath) ?? ".");
            File.WriteAllBytes(outputPath, data);
            Console.WriteLine($"Successfully extracted {filePath} to {outputPath}");
        }

        private static void ExtractByGlob(string rpfPath, string glob, string outdir, bool preservePaths)
        {
            var rpf = LoadRpf(rpfPath);
            var rx = GlobToRegex(glob);
            var outRoot = Path.GetFullPath(outdir);
            Directory.CreateDirectory(outRoot);

            var rpfRootName = (rpf.Path ?? rpf.NameLower ?? Path.GetFileName(rpfPath)) ?? Path.GetFileName(rpfPath);
            if (rpfRootName.EndsWith(".rpf", StringComparison.OrdinalIgnoreCase) == false)
            {
                rpfRootName = Path.GetFileName(rpfPath);
            }

            int extracted = 0;
            foreach (var entry in rpf.AllEntries)
            {
                if (entry is not RpfFileEntry fe) continue;
                if (string.IsNullOrEmpty(fe.Path)) continue;
                var p = fe.Path.Replace('/', '\\');
                if (!rx.IsMatch(p)) continue;

                string rel;
                if (preservePaths)
                {
                    // Preserve the internal path relative to the RPF root.
                    // fe.Path typically starts with "<rpfname>\\...".
                    var prefix = rpfRootName.Replace('/', '\\').TrimEnd('\\') + "\\";
                    if (p.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                    {
                        rel = p.Substring(prefix.Length);
                    }
                    else
                    {
                        // Fallback: drop the first segment (rpf name)
                        var idx = p.IndexOf('\\');
                        rel = (idx >= 0) ? p.Substring(idx + 1) : fe.Name;
                    }
                }
                else
                {
                    rel = fe.Name;
                }

                var dest = Path.Combine(outRoot, rel);
                Directory.CreateDirectory(Path.GetDirectoryName(dest) ?? outRoot);

                var data = fe.File.ExtractFile(fe);
                if (data == null || data.Length == 0) continue;
                File.WriteAllBytes(dest, data);
                extracted++;
            }

            Console.WriteLine($"Extracted {extracted} files matching '{glob}' from {Path.GetFileName(rpfPath)} into {outRoot}");
        }

        private sealed class Vec3Dto
        {
            [JsonPropertyName("x")] public float X { get; set; }
            [JsonPropertyName("y")] public float Y { get; set; }
            [JsonPropertyName("z")] public float Z { get; set; }
        }

        private sealed class HashDto
        {
            [JsonPropertyName("name")] public string Name { get; set; }
            [JsonPropertyName("hash")] public uint Hash { get; set; }
            [JsonPropertyName("hex")] public string Hex { get; set; }
        }

        private sealed class ArchetypeDto
        {
            [JsonPropertyName("name")] public HashDto Name { get; set; }
            [JsonPropertyName("assetName")] public HashDto AssetName { get; set; }
            [JsonPropertyName("drawableDict")] public HashDto DrawableDict { get; set; }
            [JsonPropertyName("textureDict")] public HashDto TextureDict { get; set; }
            [JsonPropertyName("clipDict")] public HashDto ClipDict { get; set; }
            [JsonPropertyName("lodDist")] public float LodDist { get; set; }
            [JsonPropertyName("flags")] public uint Flags { get; set; }
            [JsonPropertyName("bbMin")] public Vec3Dto BBMin { get; set; }
            [JsonPropertyName("bbMax")] public Vec3Dto BBMax { get; set; }
        }

        private sealed class YtypExportDto
        {
            [JsonPropertyName("source")] public string Source { get; set; }
            [JsonPropertyName("ytypFile")] public string YtypFile { get; set; }
            [JsonPropertyName("name")] public HashDto Name { get; set; }
            [JsonPropertyName("archetypes")] public List<ArchetypeDto> Archetypes { get; set; }
        }

        private static HashDto H(MetaHash h) => new HashDto { Name = h.ToString(), Hash = h.Hash, Hex = h.Hex };
        private static Vec3Dto V(Vector3 v) => new Vec3Dto { X = v.X, Y = v.Y, Z = v.Z };

        private static void RunYtypToJson(Dictionary<string, string> args)
        {
            args.TryGetValue("--input", out var input);
            args.TryGetValue("--output", out var output);
            args.TryGetValue("--source", out var source);

            if (string.IsNullOrEmpty(input) || string.IsNullOrEmpty(output))
            {
                Console.Error.WriteLine("Error: ytyp-to-json requires --input and --output");
                Environment.Exit(2);
            }
            if (!File.Exists(input))
            {
                Console.Error.WriteLine($"Error: input file does not exist: {input}");
                Environment.Exit(2);
            }

            ExportYtypToJson(input, output, source ?? input);
        }

        private static void RunYtypExportDir(Dictionary<string, string> args)
        {
            args.TryGetValue("--input-dir", out var inputDir);
            args.TryGetValue("--output-dir", out var outputDir);

            if (string.IsNullOrEmpty(inputDir) || string.IsNullOrEmpty(outputDir))
            {
                Console.Error.WriteLine("Error: ytyp-export-dir requires --input-dir and --output-dir");
                Environment.Exit(2);
            }
            if (!Directory.Exists(inputDir))
            {
                Console.Error.WriteLine($"Error: input dir does not exist: {inputDir}");
                Environment.Exit(2);
            }

            Directory.CreateDirectory(outputDir);

            var ytypFiles = Directory.GetFiles(inputDir, "*.ytyp", SearchOption.AllDirectories)
                .OrderBy(p => p, StringComparer.OrdinalIgnoreCase)
                .ToList();

            int exported = 0;
            foreach (var inPath in ytypFiles)
            {
                var rel = Path.GetRelativePath(inputDir, inPath).Replace('\\', '/');
                var outRel = Path.ChangeExtension(rel, ".json");
                var outPath = Path.Combine(outputDir, outRel.Replace('/', Path.DirectorySeparatorChar));
                Directory.CreateDirectory(Path.GetDirectoryName(outPath) ?? outputDir);

                ExportYtypToJson(inPath, outPath, rel);
                exported++;
            }

            Console.WriteLine($"Exported {exported} YTYP files to {Path.GetFullPath(outputDir)}");
        }

        private static void ExportYtypToJson(string inputPath, string outputPath, string source)
        {
            var data = File.ReadAllBytes(inputPath);
            if (data == null || data.Length == 0)
            {
                Console.Error.WriteLine($"Error: input file is empty: {inputPath}");
                Environment.Exit(3);
            }

            var ytyp = new YtypFile();
            ytyp.Load(data);

            var archetypes = new List<ArchetypeDto>();
            if (ytyp.AllArchetypes != null)
            {
                foreach (var a in ytyp.AllArchetypes)
                {
                    if (a == null) continue;
                    archetypes.Add(new ArchetypeDto
                    {
                        Name = H(a._BaseArchetypeDef.name),
                        AssetName = H(a._BaseArchetypeDef.assetName),
                        DrawableDict = H(a._BaseArchetypeDef.drawableDictionary),
                        TextureDict = H(a._BaseArchetypeDef.textureDictionary),
                        ClipDict = H(a._BaseArchetypeDef.clipDictionary),
                        LodDist = a._BaseArchetypeDef.lodDist,
                        Flags = a._BaseArchetypeDef.flags,
                        BBMin = V(a._BaseArchetypeDef.bbMin),
                        BBMax = V(a._BaseArchetypeDef.bbMax),
                    });
                }
            }

            var dto = new YtypExportDto
            {
                Source = source,
                YtypFile = inputPath,
                Name = H(ytyp.CMapTypes.name),
                Archetypes = archetypes
            };

            var json = JsonSerializer.Serialize(dto, new JsonSerializerOptions { WriteIndented = true });
            File.WriteAllText(outputPath, json);
        }
    }
} 