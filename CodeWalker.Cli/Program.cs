using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using CodeWalker.GameFiles;

namespace CodeWalker.Cli
{
    class Program
    {
        private sealed class RpfSource
        {
            public string Path { get; set; }
            public RpfFile Archive { get; set; }
            public List<RpfFileEntry> Entries { get; set; }
        }

        private sealed class YftReference
        {
            public string RpfPath { get; set; }
            public string EntryPath { get; set; }
            public RpfFileEntry Entry { get; set; }
        }

        static int Main(string[] args)
        {
            try
            {
                if (args.Length == 0)
                {
                    PrintUsage();
                    return 1;
                }

                return args[0] switch
                {
                    "extract" => RunExtract(args.Skip(1).ToArray()),
                    "audit-fragments" => RunFragmentAudit(args.Skip(1).ToArray()),
                    "audit-loose-textures" => RunLooseTextureAudit(args.Skip(1).ToArray()),
                    "audit-ymap" => RunYmapAudit(args.Skip(1).ToArray()),
                    "export-mlo-metadata" => RunMloMetadataExport(args.Skip(1).ToArray()),
                    _ => PrintUsageAndFail(),
                };
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"Error: {ex.Message}");
                Console.Error.WriteLine(ex.StackTrace);
                return 1;
            }
        }

        private static int RunLooseTextureAudit(string[] args)
        {
            string resourceRoot = GetOption(args, "--resource-root");
            string needPath = GetOption(args, "--need");
            string outputPath = GetOption(args, "--output");
            if (string.IsNullOrWhiteSpace(resourceRoot) || string.IsNullOrWhiteSpace(needPath) || string.IsNullOrWhiteSpace(outputPath))
            {
                Console.Error.WriteLine("Error: audit-loose-textures requires --resource-root, --need, and --output.");
                PrintUsage();
                return 1;
            }

            resourceRoot = Path.GetFullPath(resourceRoot);
            needPath = Path.GetFullPath(needPath);
            if (!Directory.Exists(resourceRoot)) throw new DirectoryNotFoundException(resourceRoot);
            if (!File.Exists(needPath)) throw new FileNotFoundException("Texture need report not found.", needPath);

            var wanted = new Dictionary<uint, string>();
            using (JsonDocument document = JsonDocument.Parse(File.ReadAllText(needPath)))
            {
                if (!document.RootElement.TryGetProperty("textures", out JsonElement textures))
                    throw new InvalidDataException("Need report has no textures array.");
                foreach (JsonElement texture in textures.EnumerateArray())
                {
                    string hashText = texture.TryGetProperty("hash", out JsonElement hashElement) ? hashElement.ToString() : string.Empty;
                    if (!uint.TryParse(hashText, out uint hash)) continue;
                    string name = texture.TryGetProperty("name", out JsonElement nameElement) ? nameElement.GetString() ?? string.Empty : string.Empty;
                    wanted[hash] = name;
                }
            }

            var matches = new List<object>();
            var matchedHashes = new HashSet<uint>();
            var errors = new List<object>();
            int ytdCount = 0;
            int textureCount = 0;
            foreach (string path in Directory.EnumerateFiles(resourceRoot, "*.ytd", SearchOption.AllDirectories))
            {
                ytdCount++;
                try
                {
                    var ytd = new YtdFile();
                    ytd.Load(File.ReadAllBytes(path));
                    foreach (var texture in ytd.TextureDict?.Textures?.data_items ?? Array.Empty<Texture>())
                    {
                        if (texture == null) continue;
                        textureCount++;
                        string name = texture.Name ?? string.Empty;
                        uint hash = JenkHash.GenHash(name.ToLowerInvariant());
                        if (!wanted.TryGetValue(hash, out string wantedName)) continue;
                        matchedHashes.Add(hash);
                        matches.Add(new
                        {
                            hash,
                            wantedName,
                            actualName = name,
                            ytd = Path.GetRelativePath(resourceRoot, path).Replace('\\', '/'),
                            bytes = new FileInfo(path).Length,
                        });
                    }
                }
                catch (Exception ex)
                {
                    errors.Add(new
                    {
                        ytd = Path.GetRelativePath(resourceRoot, path).Replace('\\', '/'),
                        error = ex.Message,
                    });
                }
            }

            var unresolved = wanted
                .Where(pair => !matchedHashes.Contains(pair.Key))
                .OrderBy(pair => pair.Key)
                .Select(pair => new { hash = pair.Key, name = pair.Value })
                .ToArray();
            var report = new
            {
                schema = "webglgta-loose-texture-audit-v1",
                resourceRoot,
                wantedHashCount = wanted.Count,
                ytdCount,
                textureCount,
                matchedHashCount = matchedHashes.Count,
                unresolvedHashCount = unresolved.Length,
                matches,
                unresolved,
                errors,
            };
            string directory = Path.GetDirectoryName(Path.GetFullPath(outputPath));
            if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
            File.WriteAllText(outputPath, JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }));
            Console.WriteLine($"Wrote loose texture audit: {outputPath} (ytd={ytdCount}, textures={textureCount}, matches={matchedHashes.Count}, unresolved={unresolved.Length}, errors={errors.Count})");
            return unresolved.Length == 0 ? 0 : 2;
        }

        private static int RunExtract(string[] args)
        {
            string rpfPath = GetOption(args, "--rpf");
            string filePath = GetOption(args, "--file");
            string outputPath = GetOption(args, "--output");

            if (string.IsNullOrEmpty(rpfPath) || string.IsNullOrEmpty(filePath) || string.IsNullOrEmpty(outputPath))
            {
                Console.Error.WriteLine("Error: Missing required arguments.");
                PrintUsage();
                return 1;
            }

            InitializeGtaKeys(GetOption(args, "--game-path"), rpfPath);

            var rpf = ScanRpf(rpfPath);
            if (rpf == null) return 1;

            var files = GetRecursiveFiles(rpf)
                .Where(entry => entry.Path.EndsWith(filePath, StringComparison.OrdinalIgnoreCase) ||
                                entry.NameLower.Equals(filePath, StringComparison.OrdinalIgnoreCase))
                .ToList();
            if (files == null || files.Count == 0)
            {
                Console.Error.WriteLine($"File not found: {filePath}");
                return 1;
            }

            var entry = files[0];
            var data = entry.File.ExtractFile(entry);
            if (data == null || data.Length == 0)
            {
                Console.Error.WriteLine($"Failed to extract file: {filePath}");
                return 1;
            }

            File.WriteAllBytes(outputPath, data);
            Console.WriteLine($"Successfully extracted {filePath} to {outputPath}");
            return 0;
        }


        private static int RunYmapAudit(string[] args)
        {
            var ymapPaths = GetOptions(args, "--ymap");
            foreach (string ymapDirectory in GetOptions(args, "--ymap-dir"))
            {
                if (!Directory.Exists(ymapDirectory))
                {
                    Console.Error.WriteLine($"YMAP directory not found: {Path.GetFullPath(ymapDirectory)}");
                    return 1;
                }
                ymapPaths.AddRange(Directory.EnumerateFiles(ymapDirectory, "*.ymap", SearchOption.AllDirectories));
            }

            string outputPath = GetOption(args, "--output");
            if (ymapPaths.Count == 0 || string.IsNullOrWhiteSpace(outputPath))
            {
                Console.Error.WriteLine("Error: audit-ymap requires at least one --ymap or --ymap-dir and --output.");
                PrintUsage();
                return 1;
            }

            ymapPaths = ymapPaths.Distinct(StringComparer.OrdinalIgnoreCase).ToList();
            float[] requestedBounds = ParseYmapBounds(GetOption(args, "--bounds"));
            if (GetOption(args, "--bounds") != null && requestedBounds == null)
            {
                Console.Error.WriteLine("Error: --bounds must be minX,minY,maxX,maxY.");
                return 1;
            }
            bool mloOnly = args.Any(arg => arg.Equals("--mlo-only", StringComparison.OrdinalIgnoreCase));
            var reports = new List<object>();
            foreach (string input in ymapPaths)
            {
                string path = Path.GetFullPath(input);
                if (!File.Exists(path))
                {
                    Console.Error.WriteLine($"YMAP not found: {path}");
                    return 1;
                }

                var ymap = new YmapFile();
                ymap.Load(File.ReadAllBytes(path));
                var allEntities = (ymap.AllEntities ?? Array.Empty<YmapEntityDef>())
                    .Select(entity => new
                    {
                        index = entity.Index,
                        archetypeHash = entity._CEntityDef.archetypeName.Hash,
                        position = new[] { entity.Position.X, entity.Position.Y, entity.Position.Z },
                        rotation = new[]
                        {
                            entity._CEntityDef.rotation.X,
                            entity._CEntityDef.rotation.Y,
                            entity._CEntityDef.rotation.Z,
                            entity._CEntityDef.rotation.W,
                        },
                        scale = new[]
                        {
                            entity._CEntityDef.scaleXY,
                            entity._CEntityDef.scaleXY,
                            entity._CEntityDef.scaleZ,
                        },
                        flags = entity._CEntityDef.flags,
                        lodDist = entity._CEntityDef.lodDist,
                        childLodDist = entity._CEntityDef.childLodDist,
                        lodLevel = entity._CEntityDef.lodLevel.ToString(),
                        numChildren = entity._CEntityDef.numChildren,
                        isMloInstance = entity.IsMlo,
                        guid = entity._CEntityDef.guid,
                        parentIndex = entity._CEntityDef.parentIndex,
                    })
                    .ToList();
                var entities = mloOnly
                    ? allEntities.Where(entity => entity.isMloInstance).ToList()
                    : allEntities;
                var positions = allEntities.Select(entity => entity.position).ToList();
                reports.Add(new
                {
                    file = path,
                    entityCount = allEntities.Count,
                    mloInstanceCount = allEntities.Where(entity => entity.isMloInstance).Count(),
                    bounds = positions.Count == 0 ? null : new
                    {
                        min = new[] { positions.Min(point => point[0]), positions.Min(point => point[1]), positions.Min(point => point[2]) },
                        max = new[] { positions.Max(point => point[0]), positions.Max(point => point[1]), positions.Max(point => point[2]) },
                    },
                    mloInstances = entities.Select(entity => new
                    {
                        entity.index,
                        entity.archetypeHash,
                        entity.position,
                        entity.guid,
                        entity.parentIndex,
                        insideRequestedBounds = requestedBounds == null ||
                            (entity.position[0] >= requestedBounds[0] && entity.position[0] <= requestedBounds[2] &&
                             entity.position[1] >= requestedBounds[1] && entity.position[1] <= requestedBounds[3]),
                    }),
                    entities = mloOnly ? null : entities,
                });
            }

            string directory = Path.GetDirectoryName(Path.GetFullPath(outputPath));
            if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
            File.WriteAllText(outputPath, JsonSerializer.Serialize(new { ymaps = reports }, new JsonSerializerOptions { WriteIndented = true }));
            Console.WriteLine($"Wrote standalone YMAP audit: {outputPath}");
            return 0;
        }

        private static float[] ParseYmapBounds(string value)
        {
            if (string.IsNullOrWhiteSpace(value)) return null;
            string[] parts = value.Split(',', StringSplitOptions.TrimEntries);
            if (parts.Length != 4) return null;

            var values = new float[4];
            for (int i = 0; i < values.Length; i++)
            {
                if (!float.TryParse(parts[i], System.Globalization.NumberStyles.Float,
                    System.Globalization.CultureInfo.InvariantCulture, out values[i])) return null;
            }
            return values[0] <= values[2] && values[1] <= values[3] ? values : null;
        }

        private static int RunMloMetadataExport(string[] args)
        {
            string resourceDir = GetOption(args, "--resource-dir");
            var ymapPaths = GetOptions(args, "--ymap");
            string outputPath = GetOption(args, "--output");
            if (string.IsNullOrWhiteSpace(resourceDir) || ymapPaths.Count == 0 || string.IsNullOrWhiteSpace(outputPath))
            {
                Console.Error.WriteLine("Error: export-mlo-metadata requires --resource-dir, at least one --ymap, and --output.");
                PrintUsage();
                return 1;
            }

            resourceDir = Path.GetFullPath(resourceDir);
            if (!Directory.Exists(resourceDir))
            {
                Console.Error.WriteLine($"Resource directory not found: {resourceDir}");
                return 1;
            }

            var archetypesByHash = new Dictionary<uint, Archetype>();
            var duplicateArchetypes = new List<object>();
            foreach (string ytypPath in Directory.EnumerateFiles(resourceDir, "*.ytyp", SearchOption.AllDirectories))
            {
                try
                {
                    var ytyp = new YtypFile();
                    ytyp.Load(File.ReadAllBytes(ytypPath));
                    foreach (var archetype in ytyp.AllArchetypes ?? Array.Empty<Archetype>())
                    {
                        if (archetype == null) continue;
                        uint hash = archetype.BaseArchetypeDef.name.Hash;
                        if (hash == 0) hash = archetype.BaseArchetypeDef.assetName.Hash;
                        if (hash == 0) continue;
                        if (archetypesByHash.ContainsKey(hash))
                        {
                            duplicateArchetypes.Add(new { hash, ytyp = Path.GetRelativePath(resourceDir, ytypPath) });
                            continue;
                        }
                        archetypesByHash.Add(hash, archetype);
                    }
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine($"Failed to load YTYP {ytypPath}: {ex.Message}");
                }
            }

            var roots = new List<object>();
            var interiorDefs = new Dictionary<string, object>();
            var unresolvedRoots = new List<object>();
            foreach (string input in ymapPaths.Distinct(StringComparer.OrdinalIgnoreCase))
            {
                string ymapPath = Path.GetFullPath(input);
                if (!File.Exists(ymapPath))
                {
                    Console.Error.WriteLine($"YMAP not found: {ymapPath}");
                    return 1;
                }

                var ymap = new YmapFile();
                ymap.Load(File.ReadAllBytes(ymapPath));
                foreach (var root in (ymap.AllEntities ?? Array.Empty<YmapEntityDef>()).Where(entity => entity?.IsMlo == true))
                {
                    uint archHash = root._CEntityDef.archetypeName.Hash;
                    if (!archetypesByHash.TryGetValue(archHash, out var genericArchetype) || genericArchetype is not MloArchetype mlo)
                    {
                        unresolvedRoots.Add(new { ymap = Path.GetRelativePath(resourceDir, ymapPath), index = root.Index, archetypeHash = archHash });
                        continue;
                    }

                    root.SetArchetype(mlo);
                    string relativeYmap = Path.GetRelativePath(resourceDir, ymapPath).Replace('\\', '/');
                    uint parentGuid = StableMloGuid(relativeYmap, root.Index);
                    var rootChildren = new List<object>();
                    foreach (var child in root.MloInstance?.Entities ?? Array.Empty<YmapEntityDef>())
                    {
                        MCEntityDef archetypeChild = (child.Index >= 0 && child.Index < (mlo.entities?.Length ?? 0))
                            ? mlo.entities[child.Index]
                            : null;
                        int roomIndex = mlo.GetEntityRoom(archetypeChild)?.Index ?? -1;
                        int portalIndex = mlo.GetEntityPortal(archetypeChild)?.Index ?? -1;
                        rootChildren.Add(DescribeMloChild(child, parentGuid, 0, roomIndex, portalIndex, true));
                    }
                    foreach (var entitySet in root.MloInstance?.EntitySets ?? Array.Empty<MloInstanceEntitySet>())
                    {
                        uint setHash = entitySet?.EntitySet?._Data.name.Hash ?? 0;
                        var setChildren = entitySet?.Entities ?? new List<YmapEntityDef>();
                        for (int childIndex = 0; childIndex < setChildren.Count; childIndex++)
                        {
                            var child = setChildren[childIndex];
                            uint[] locations = entitySet?.EntitySet?.Locations;
                            int roomIndex = (locations != null && childIndex < locations.Length)
                                ? unchecked((int)locations[childIndex])
                                : -1;
                            rootChildren.Add(DescribeMloChild(child, parentGuid, setHash, roomIndex, -1, entitySet?.Visible == true));
                        }
                    }

                    roots.Add(new
                    {
                        sourceYmap = relativeYmap,
                        index = root.Index,
                        archetypeHash = archHash,
                        assetHash = mlo.BaseArchetypeDef.assetName.Hash,
                        parentGuid,
                        position = ToArray(root.Position),
                        rotation = ToArray(root.Orientation),
                        scale = ToArray(root.Scale),
                        groupId = root.MloInstance?._Instance.groupId ?? 0,
                        floorId = root.MloInstance?._Instance.floorId ?? 0,
                        numExitPortals = root.MloInstance?._Instance.numExitPortals ?? 0,
                        instanceFlags = root.MloInstance?._Instance.MLOInstflags ?? 0,
                        defaultEntitySets = (root.MloInstance?.defaultEntitySets ?? Array.Empty<MetaHash>()).Select(hash => new
                        {
                            hash = hash.Hash,
                            name = ResolvedHashName(hash.Hash),
                        }).ToArray(),
                        children = rootChildren,
                    });

                    string key = archHash.ToString();
                    if (!interiorDefs.ContainsKey(key))
                    {
                        interiorDefs.Add(key, new
                        {
                            archetypeHash = archHash,
                            assetHash = mlo.BaseArchetypeDef.assetName.Hash,
                            rooms = (mlo.rooms ?? Array.Empty<MCMloRoomDef>()).Select(room => new
                            {
                                index = room.Index,
                                name = room.RoomName ?? string.Empty,
                                bbMin = ToArray(room.BBMin),
                                bbMax = ToArray(room.BBMax),
                                blend = FiniteOrZero(room._Data.blend),
                                timecycleName = room._Data.timecycleName.Hash,
                                timecycleNameText = ResolvedHashName(room._Data.timecycleName.Hash),
                                secondaryTimecycleName = room._Data.secondaryTimecycleName.Hash,
                                secondaryTimecycleNameText = ResolvedHashName(room._Data.secondaryTimecycleName.Hash),
                                flags = room._Data.flags,
                                floorId = room._Data.floorId,
                                exteriorVisibilityDepth = room._Data.exteriorVisibiltyDepth,
                                attachedObjects = room.AttachedObjects ?? Array.Empty<uint>(),
                            }).ToArray(),
                            portals = (mlo.portals ?? Array.Empty<MCMloPortalDef>()).Select(portal => new
                            {
                                index = portal.Index,
                                roomFrom = portal._Data.roomFrom,
                                roomTo = portal._Data.roomTo,
                                flags = portal._Data.flags,
                                mirrorPriority = portal._Data.mirrorPriority,
                                opacity = portal._Data.opacity,
                                audioOcclusion = portal._Data.audioOcclusion,
                                corners = (portal.Corners ?? Array.Empty<SharpDX.Vector4>()).Select(ToArray).ToArray(),
                                attachedObjects = portal.AttachedObjects ?? Array.Empty<uint>(),
                            }).ToArray(),
                            entitySets = (mlo.entitySets ?? Array.Empty<MCMloEntitySet>()).Select(entitySet => new
                            {
                                index = entitySet.Index,
                                hash = entitySet._Data.name.Hash,
                                name = entitySet.Name ?? string.Empty,
                                locations = entitySet.Locations ?? Array.Empty<uint>(),
                            }).ToArray(),
                            timecycleModifiers = (mlo.timeCycleModifiers ?? Array.Empty<CMloTimeCycleModifier>()).Select(modifier => new
                            {
                                name = modifier.name.Hash,
                                nameText = ResolvedHashName(modifier.name.Hash),
                                sphere = ToArray(modifier.sphere),
                                percentage = FiniteOrZero(modifier.percentage),
                                range = FiniteOrZero(modifier.range),
                                startHour = modifier.startHour,
                                endHour = modifier.endHour,
                            }).ToArray(),
                        });
                    }
                }
            }

            var archetypes = archetypesByHash.OrderBy(pair => pair.Key).ToDictionary(
                pair => pair.Key.ToString(),
                pair => (object)new
                {
                    archetypeHash = pair.Key,
                    assetHash = pair.Value.BaseArchetypeDef.assetName.Hash,
                    textureDictionaryHash = pair.Value.BaseArchetypeDef.textureDictionary.Hash,
                    isMlo = pair.Value is MloArchetype,
                    bounds = new
                    {
                        min = ToArray(pair.Value.BBMin),
                        max = ToArray(pair.Value.BBMax),
                        center = ToArray(pair.Value.BSCenter),
                        radius = FiniteOrZero(pair.Value.BSRadius),
                    },
                });
            var report = new
            {
                schema = "webglgta-fivem-mlo-metadata-v1",
                resourceDir,
                ytypArchetypeCount = archetypesByHash.Count,
                duplicateArchetypes,
                archetypes,
                roots,
                interiors = interiorDefs,
                unresolvedRoots,
            };
            string outputDirectory = Path.GetDirectoryName(Path.GetFullPath(outputPath));
            if (!string.IsNullOrEmpty(outputDirectory)) Directory.CreateDirectory(outputDirectory);
            File.WriteAllText(outputPath, JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }));
            Console.WriteLine($"Wrote MLO metadata: {outputPath} (roots={roots.Count}, interiors={interiorDefs.Count})");
            return unresolvedRoots.Count == 0 ? 0 : 2;
        }

        private static object DescribeMloChild(
            YmapEntityDef child,
            uint parentGuid,
            uint entitySetHash,
            int roomIndex,
            int portalIndex,
            bool entitySetDefault)
        {
            return new
            {
                index = child.Index,
                archetypeHash = child._CEntityDef.archetypeName.Hash,
                position = ToArray(child.Position),
                rotation = ToArray(child.Orientation),
                scale = ToArray(child.Scale),
                parentGuid,
                entitySetHash,
                roomIndex,
                portalIndex,
                entitySetDefault,
            };
        }

        private static uint StableMloGuid(string sourceYmap, int rootIndex)
        {
            uint hash = JenkHash.GenHash($"webglgta:mlo:{sourceYmap.ToLowerInvariant()}:{rootIndex}");
            return hash == 0 ? 1u : hash;
        }

        private static string ResolvedHashName(uint hash)
        {
            if (hash == 0) return string.Empty;
            string value = JenkIndex.GetString(hash) ?? string.Empty;
            return uint.TryParse(value, out _) ? string.Empty : value;
        }

        private static float[] ToArray(SharpDX.Vector3 value)
        {
            return new[] { FiniteOrZero(value.X), FiniteOrZero(value.Y), FiniteOrZero(value.Z) };
        }

        private static float[] ToArray(SharpDX.Vector4 value)
        {
            return new[] { FiniteOrZero(value.X), FiniteOrZero(value.Y), FiniteOrZero(value.Z), FiniteOrZero(value.W) };
        }

        private static float[] ToArray(SharpDX.Quaternion value)
        {
            return new[] { FiniteOrZero(value.X), FiniteOrZero(value.Y), FiniteOrZero(value.Z), FiniteOrZero(value.W) };
        }

        private static float FiniteOrZero(float value)
        {
            return float.IsFinite(value) ? value : 0.0f;
        }

        private static int RunFragmentAudit(string[] args)
        {
            var rpfPaths = GetOptions(args, "--rpf");
            string manifestPath = GetOption(args, "--demo-manifest");
            string outputPath = GetOption(args, "--output");

            if (rpfPaths.Count == 0 || string.IsNullOrEmpty(manifestPath) || string.IsNullOrEmpty(outputPath))
            {
                Console.Error.WriteLine("Error: audit-fragments requires at least one --rpf, --demo-manifest, and --output.");
                PrintUsage();
                return 1;
            }
            if (!File.Exists(manifestPath))
            {
                Console.Error.WriteLine($"Demo manifest not found: {manifestPath}");
                return 1;
            }

            InitializeGtaKeys(GetOption(args, "--game-path"), rpfPaths[0]);

            var demoHashes = ReadDemoManifestHashes(manifestPath);
            if (demoHashes.Count == 0)
            {
                Console.Error.WriteLine("The demo manifest did not contain any numeric mesh/archetype hashes.");
                return 1;
            }

            var sources = new List<RpfSource>();
            foreach (string rpfPath in rpfPaths.Distinct(StringComparer.OrdinalIgnoreCase))
            {
                var rpf = ScanRpf(rpfPath);
                if (rpf == null) return 1;
                sources.Add(new RpfSource
                {
                    Path = Path.GetFullPath(rpfPath),
                    Archive = rpf,
                    Entries = GetRecursiveFiles(rpf),
                });
            }

            var yftsByHash = new Dictionary<uint, List<YftReference>>();
            foreach (var source in sources)
            {
                foreach (var entry in source.Entries)
                {
                    if (!entry.NameLower.EndsWith(".yft", StringComparison.OrdinalIgnoreCase)) continue;

                    uint hash = JenkHash.GenHash(Path.GetFileNameWithoutExtension(entry.NameLower));
                    if (!yftsByHash.TryGetValue(hash, out var matches))
                    {
                        matches = new List<YftReference>();
                        yftsByHash.Add(hash, matches);
                    }
                    matches.Add(new YftReference
                    {
                        RpfPath = source.Path,
                        EntryPath = entry.Path,
                        Entry = entry,
                    });
                }
            }

            var records = new List<object>();
            int ytypCount = 0;
            int matchingArchetypeCount = 0;
            int fragmentCandidateCount = 0;
            int errors = 0;

            foreach (var source in sources)
            {
                foreach (var entry in source.Entries)
                {
                    if (!entry.NameLower.EndsWith(".ytyp", StringComparison.OrdinalIgnoreCase)) continue;
                    ytypCount++;

                    try
                    {
                        var ytyp = RpfFile.GetFile<YtypFile>(entry);
                        if (ytyp?.AllArchetypes == null) continue;

                        foreach (var archetype in ytyp.AllArchetypes)
                        {
                            if (archetype == null) continue;
                            var definition = archetype.BaseArchetypeDef;
                            uint archetypeHash = definition.name.Hash;
                            uint assetHash = definition.assetName.Hash;
                            bool matchesArchetypeName = demoHashes.Contains(archetypeHash);
                            bool matchesAssetName = demoHashes.Contains(assetHash);
                            if (!matchesArchetypeName && !matchesAssetName) continue;

                            matchingArchetypeCount++;
                            bool isFragment = definition.assetType == rage__fwArchetypeDef__eAssetType.ASSET_TYPE_FRAGMENT;
                            if (isFragment) fragmentCandidateCount++;

                            var yftMetadata = new List<object>();
                            if (isFragment)
                            {
                                var yftMatches = new List<YftReference>();
                                AddYftMatches(yftsByHash, assetHash, yftMatches);
                                AddYftMatches(yftsByHash, archetypeHash, yftMatches);

                                foreach (var yftRef in yftMatches.Distinct(new YftReferenceComparer()))
                                {
                                    try
                                    {
                                        var yft = RpfFile.GetFile<YftFile>(yftRef.Entry);
                                        var fragment = yft?.Fragment;
                                        if (fragment == null) continue;

                                        yftMetadata.Add(new
                                        {
                                            rpf = yftRef.RpfPath,
                                            path = yftRef.EntryPath,
                                            name = fragment.Name,
                                            boundingSphere = new[]
                                            {
                                                fragment.BoundingSphereCenter.X,
                                                fragment.BoundingSphereCenter.Y,
                                                fragment.BoundingSphereCenter.Z,
                                                fragment.BoundingSphereRadius,
                                            },
                                            hasPhysicsLods = fragment.PhysicsLODGroup != null,
                                            physicsLod1 = DescribePhysicsLod(fragment.PhysicsLODGroup?.PhysicsLOD1),
                                            physicsLod2 = DescribePhysicsLod(fragment.PhysicsLODGroup?.PhysicsLOD2),
                                            physicsLod3 = DescribePhysicsLod(fragment.PhysicsLODGroup?.PhysicsLOD3),
                                            glassWindowCount = fragment.GlassWindowsCount,
                                            hasVehicleGlass = fragment.VehicleGlassWindows != null,
                                            gravityFactor = fragment.GravityFactor,
                                            buoyancyFactor = fragment.BuoyancyFactor,
                                        });
                                    }
                                    catch (Exception ex)
                                    {
                                        errors++;
                                        yftMetadata.Add(new { rpf = yftRef.RpfPath, path = yftRef.EntryPath, error = ex.Message });
                                    }
                                }
                            }

                            records.Add(new
                            {
                                ytypRpf = source.Path,
                                ytypPath = entry.Path,
                                archetypeName = archetype.Name,
                                archetypeHash,
                                assetName = archetype.AssetName,
                                assetHash,
                                demoHashMatches = new
                                {
                                    archetypeName = matchesArchetypeName,
                                    assetName = matchesAssetName,
                                },
                                assetType = definition.assetType.ToString(),
                                physicsDictionary = definition.physicsDictionary.ToString(),
                                bounds = new
                                {
                                    min = new[] { definition.bbMin.X, definition.bbMin.Y, definition.bbMin.Z },
                                    max = new[] { definition.bbMax.X, definition.bbMax.Y, definition.bbMax.Z },
                                    sphere = new[] { definition.bsCentre.X, definition.bsCentre.Y, definition.bsCentre.Z, definition.bsRadius },
                                },
                                fragmentMetadata = yftMetadata,
                            });
                        }
                    }
                    catch (Exception ex)
                    {
                        errors++;
                        Console.Error.WriteLine($"Failed to read {source.Path}:{entry.Path}: {ex.Message}");
                    }
                }
            }

            var report = new
            {
                schema = "webglgta-fragment-audit-v1",
                generatedAt = DateTime.UtcNow.ToString("O"),
                demoManifest = Path.GetFullPath(manifestPath),
                demoArchetypeHashCount = demoHashes.Count,
                scannedRpfs = sources.Select(source => new { path = source.Path, entryCount = source.Entries.Count }).ToArray(),
                ytypCount,
                matchingArchetypeCount,
                fragmentCandidateCount,
                errors,
                records,
            };

            string outputDirectory = Path.GetDirectoryName(Path.GetFullPath(outputPath));
            if (!string.IsNullOrEmpty(outputDirectory)) Directory.CreateDirectory(outputDirectory);
            File.WriteAllText(outputPath, JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }));
            Console.WriteLine($"Wrote fragment audit: {outputPath} (matches={matchingArchetypeCount}, fragments={fragmentCandidateCount}, errors={errors})");
            return 0;
        }

        private static void AddYftMatches(Dictionary<uint, List<YftReference>> index, uint hash, List<YftReference> target)
        {
            if (hash != 0 && index.TryGetValue(hash, out var matches)) target.AddRange(matches);
        }

        private static object DescribePhysicsLod(FragPhysicsLOD lod)
        {
            if (lod == null) return null;
            return new
            {
                childCount = lod.ChildrenCount,
                groupCount = lod.GroupsCount,
                rootGroupCount = lod.RootGroupsCount,
                boundType = lod.Bound?.Type.ToString(),
                positionOffset = new[] { lod.PositionOffset.X, lod.PositionOffset.Y, lod.PositionOffset.Z },
            };
        }

        private static HashSet<uint> ReadDemoManifestHashes(string manifestPath)
        {
            using var document = JsonDocument.Parse(File.ReadAllText(manifestPath));
            var hashes = new HashSet<uint>();
            if (!document.RootElement.TryGetProperty("meshes", out var meshes) || meshes.ValueKind != JsonValueKind.Object)
            {
                return hashes;
            }

            foreach (var mesh in meshes.EnumerateObject())
            {
                if (uint.TryParse(mesh.Name, out uint hash)) hashes.Add(hash);
            }
            return hashes;
        }

        private static RpfFile ScanRpf(string rpfPath)
        {
            if (!File.Exists(rpfPath))
            {
                Console.Error.WriteLine($"RPF not found: {rpfPath}");
                return null;
            }

            var rpf = new RpfFile(rpfPath, Path.GetFileName(rpfPath));
            rpf.ScanStructure(
                status => Console.Error.WriteLine($"[{Path.GetFileName(rpfPath)}] {status}"),
                error => Console.Error.WriteLine($"[{Path.GetFileName(rpfPath)}] Error: {error}")
            );
            if (rpf.LastException != null)
            {
                Console.Error.WriteLine($"Error scanning RPF {rpfPath}: {rpf.LastException.Message}");
                return null;
            }
            return rpf;
        }

        private static List<RpfFileEntry> GetRecursiveFiles(RpfFile archive)
        {
            var files = new List<RpfFileEntry>();
            AddFilesRecursive(archive, files);
            return files;
        }

        private static void AddFilesRecursive(RpfFile archive, List<RpfFileEntry> files)
        {
            if (archive?.AllEntries != null)
            {
                foreach (var entry in archive.AllEntries)
                {
                    if (entry is RpfFileEntry file && !file.NameLower.EndsWith(".rpf", StringComparison.OrdinalIgnoreCase))
                    {
                        files.Add(file);
                    }
                }
            }
            if (archive?.Children == null) return;
            foreach (var child in archive.Children)
            {
                AddFilesRecursive(child, files);
            }
        }

        private static void InitializeGtaKeys(string configuredGamePath, string rpfPath)
        {
            string gamePath = configuredGamePath;
            if (string.IsNullOrWhiteSpace(gamePath))
            {
                var directory = new DirectoryInfo(Path.GetFullPath(rpfPath));
                directory = directory.Exists ? directory : directory.Parent;
                while (directory != null)
                {
                    if (File.Exists(Path.Combine(directory.FullName, "GTA5.exe")))
                    {
                        gamePath = directory.FullName;
                        break;
                    }
                    directory = directory.Parent;
                }
            }

            if (string.IsNullOrWhiteSpace(gamePath) || !File.Exists(Path.Combine(gamePath, "GTA5.exe")))
            {
                throw new FileNotFoundException("Could not locate GTA5.exe. Pass --game-path <GTA V installation directory>.");
            }
            GTA5Keys.LoadFromPath(gamePath, false);
        }

        private static string GetOption(string[] args, string option)
        {
            for (int i = 0; i < args.Length - 1; i++)
            {
                if (args[i].Equals(option, StringComparison.OrdinalIgnoreCase)) return args[i + 1];
            }
            return null;
        }

        private static List<string> GetOptions(string[] args, string option)
        {
            var values = new List<string>();
            for (int i = 0; i < args.Length - 1; i++)
            {
                if (args[i].Equals(option, StringComparison.OrdinalIgnoreCase)) values.Add(args[i + 1]);
            }
            return values;
        }

        private static int PrintUsageAndFail()
        {
            PrintUsage();
            return 1;
        }

        private static void PrintUsage()
        {
            Console.WriteLine("Usage:");
            Console.WriteLine("  CodeWalker.Cli extract --rpf <rpf_path> --file <file_path> --output <output_path> [--game-path <GTA V directory>]");
            Console.WriteLine("  CodeWalker.Cli audit-fragments --rpf <rpf_path> [--rpf <rpf_path> ...] --demo-manifest <models.json> --output <audit.json> [--game-path <GTA V directory>]");
            Console.WriteLine("  CodeWalker.Cli audit-loose-textures --resource-root <FiveM resources> --need <drawable-audit.json> --output <audit.json>");
            Console.WriteLine("  CodeWalker.Cli audit-ymap (--ymap <placement.ymap> | --ymap-dir <directory>) [--mlo-only] [--bounds <minX,minY,maxX,maxY>] --output <audit.json>");
            Console.WriteLine("  CodeWalker.Cli export-mlo-metadata --resource-dir <directory> --ymap <mlo.ymap> [--ymap <mlo.ymap> ...] --output <metadata.json>");
        }

        private sealed class YftReferenceComparer : IEqualityComparer<YftReference>
        {
            public bool Equals(YftReference left, YftReference right)
            {
                return ReferenceEquals(left, right) ||
                    (left != null && right != null &&
                     string.Equals(left.RpfPath, right.RpfPath, StringComparison.OrdinalIgnoreCase) &&
                     string.Equals(left.EntryPath, right.EntryPath, StringComparison.OrdinalIgnoreCase));
            }

            public int GetHashCode(YftReference value)
            {
                return HashCode.Combine(
                    StringComparer.OrdinalIgnoreCase.GetHashCode(value.RpfPath ?? string.Empty),
                    StringComparer.OrdinalIgnoreCase.GetHashCode(value.EntryPath ?? string.Empty));
            }
        }
    }
}
