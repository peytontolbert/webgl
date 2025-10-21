using System;
using System.IO;
using CodeWalker.GameFiles;
using CodeWalker.GameFiles.Utils;

namespace CodeWalker.Cli
{
    class Program
    {
        static void Main(string[] args)
        {
            try
            {
                if (args.Length < 2 || args[0] != "extract")
                {
                    Console.WriteLine("Usage: CodeWalker.Cli extract --rpf <rpf_path> --file <file_path> --output <output_path>");
                    return;
                }

                // Parse arguments
                string rpfPath = null;
                string filePath = null;
                string outputPath = null;

                for (int i = 1; i < args.Length; i++)
                {
                    switch (args[i])
                    {
                        case "--rpf":
                            rpfPath = args[++i];
                            break;
                        case "--file":
                            filePath = args[++i];
                            break;
                        case "--output":
                            outputPath = args[++i];
                            break;
                    }
                }

                if (string.IsNullOrEmpty(rpfPath) || string.IsNullOrEmpty(filePath) || string.IsNullOrEmpty(outputPath))
                {
                    Console.WriteLine("Error: Missing required arguments");
                    return;
                }

                // Initialize GTA5 encryption
                GTA5Keys.LoadFromPath(Path.GetDirectoryName(typeof(Program).Assembly.Location), false);

                // Create RPF file instance
                var rpf = new RpfFile(rpfPath, Path.GetFileName(rpfPath));

                // Scan structure
                rpf.ScanStructure(
                    status => Console.WriteLine($"Status: {status}"),
                    error => Console.Error.WriteLine($"Error: {error}")
                );

                if (rpf.LastException != null)
                {
                    Console.Error.WriteLine($"Error scanning RPF: {rpf.LastException}");
                    return;
                }

                // Find and extract file
                var files = rpf.GetFiles(filePath, true);
                if (files == null || files.Length == 0)
                {
                    Console.Error.WriteLine($"File not found: {filePath}");
                    return;
                }

                var entry = files[0];
                var data = entry.File.ExtractFile(entry);
                if (data == null || data.Length == 0)
                {
                    Console.Error.WriteLine($"Failed to extract file: {filePath}");
                    return;
                }

                // Save to output file
                File.WriteAllBytes(outputPath, data);
                Console.WriteLine($"Successfully extracted {filePath} to {outputPath}");
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"Error: {ex.Message}");
                Console.Error.WriteLine(ex.StackTrace);
                Environment.Exit(1);
            }
        }
    }
} 