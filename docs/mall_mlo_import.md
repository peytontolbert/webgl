# mall-mlo import status

The FiveM resource at
`/data/NexusAI/fivem_server/resources/[gamemodes]/[maps]/mall-mlo` is not a
complete authored MLO and must not be merged into the browser demo as one.

## Verified source

- Source archive: `webgl_viewer/.mlo_source/mall-mlo-source-20260818.tgz`
- SHA-256: `AE5E4040E8DDB1B021192B78FC69E059A39BDDAEA5524BB668060059A198137D`
- 10 YDR drawables, 1 YTYP, 1 placeholder YTD, and 1 YMF
- No YMAP placement, YBN collision, or runtime placement script
- The YTYP contains 10 ordinary archetypes and no MLO archetype
- The local GTA install contains no active YMAP entity using these archetypes
- PFMall does not reference these archetypes

## Drawable audit

The drawables contain 197,054 high-LOD vertices and 129,168 triangles. They
have no medium, low, or very-low LOD. Their bounds and material names identify
independent store fixtures, panels, a vehicle-sized prop, tattoo furniture,
barber fixtures, and clothing-store fixtures rather than a mall shell.

The source contains no embedded textures. Its 65-byte `none.ytd` is an empty
placeholder while the drawables reference 55 texture names (54 unique hashes).
A targeted local GTA lookup recovered 9 hashes; an exhaustive fallback scan of
10,000 GTA texture dictionaries found no additional matches. The remaining 45
hashes require the resource's omitted custom texture dictionary or its original
dependency pack.

Machine-readable reports:

- `webgl_viewer/.mlo_source/mall-mlo/placement-audit.json`
- `webgl_viewer/.mlo_source/mall-mlo/drawable-audit.json`
- `webgl_viewer/.mlo_source/mall-mlo/gta-texture-index.json.partial.json`

## Required recovery

Obtain at least one of the following from the original resource package:

1. The authored YMAP that places all ten `soupmallpatch` archetypes, or the
   script/config containing each object's position, rotation, and scale.
2. The non-placeholder YTD or declared dependency pack containing the 45
   unresolved texture hashes.
3. Authored YBN collision, or an explicit decision to generate collision from
   the recovered visual meshes.

After recovery, rerun the preflight and both audits. Only then export browser
meshes, generate lower LODs, quantize geometry, compress textures to KTX2, bake
collision, stage against a copy of the demo assets, and validate in-browser
before deployment.
