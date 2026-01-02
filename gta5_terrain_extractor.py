#!/usr/bin/env python3
"""
GTA5 Terrain Extractor
---------------------
Extract and visualize terrain data from GTA5.
"""

import os
import sys
import logging
import time
import argparse
import dotenv
from pathlib import Path
import json

from gta5_modules.terrain_system import TerrainSystem
from gta5_modules.building_system import BuildingSystem
from gta5_modules.dll_manager import DllManager
from gta5_modules.provenance_tools import write_vfs_snapshot_index, write_resolved_dict_index, sha1_hex

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Load environment variables
dotenv.load_dotenv()

def main():
    """Main function"""
    parser = argparse.ArgumentParser(description='Extract and visualize GTA5 terrain data')
    parser.add_argument('--game-path', help='Path to GTA5 installation directory')
    parser.add_argument('--output-dir', default='output', help='Output directory')
    parser.add_argument('--debug', action='store_true', help='Enable debug logging')
    # Provenance / parity outputs:
    # - Resolved dict index is cheap and should be on by default (best for overlap debugging).
    # - Full EntryDict snapshot can be large; keep it opt-in.
    parser.add_argument('--no-vfs-index', action='store_true', help='Disable writing VFS index files into output/')
    parser.add_argument('--write-entrydict-snapshot', action='store_true', help='Also write output/vfs_snapshot_index.jsonl (raw EntryDict; can be large)')
    parser.add_argument('--entrydict-snapshot-max', type=int, default=50000, help='Max entries to write to the EntryDict snapshot index')
    parser.add_argument('--entrydict-snapshot-hash-first', type=int, default=0, help='Hash first N EntryDict snapshot entries (can be slow)')
    parser.add_argument('--dlc', type=str, default=None, help='Force CodeWalker SelectedDlc (e.g. patchday27ng). Default: CodeWalker chooses latest from dlclist.xml')
    parser.add_argument('--enable-mods', action='store_true', help='Enable mods folder (CodeWalker EnableMods)')
    args = parser.parse_args()
    
    # Set debug mode if requested
    if args.debug:
        logging.getLogger().setLevel(logging.DEBUG)
    
    start_time = time.time()
    
    # Get game path from environment variable or command line
    game_path = args.game_path or os.getenv('gta5_path')
    if not game_path:
        # Try to find GTA5 in common locations
        common_paths = [
            r"C:\Program Files\Epic Games\GTAV",
            r"C:\Program Files (x86)\Steam\steamapps\common\Grand Theft Auto V",
            r"D:\Program Files\Epic Games\GTAV",
            r"D:\Program Files (x86)\Steam\steamapps\common\Grand Theft Auto V"
        ]
        
        for path in common_paths:
            if Path(path).exists():
                game_path = path
                break
        
        if not game_path:
            logger.error("GTA5 installation directory not found")
            logger.info("Please specify the path using --game-path or set gta5_path in .env file")
            return False
    
    game_path = Path(game_path)
    if not game_path.exists():
        logger.error(f"Game path does not exist: {game_path}")
        return False
    
    logger.info(f"Using game path: {game_path}")
    
    # Create output directory
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    
    try:
        # Initialize DLL manager first
        dll_manager = DllManager(str(game_path))
        if not dll_manager.initialized:
            logger.error("Failed to initialize DLL manager")
            return False

        # IMPORTANT for parity:
        # Initialize GameFileCache up front so all subsequent extraction uses the same DLC-aware
        # dictionaries and RpfManager instance that CodeWalker builds.
        if not dll_manager.init_game_file_cache(selected_dlc=args.dlc, enable_mods=bool(args.enable_mods)):
            logger.warning("GameFileCache failed to initialize (exports may be incomplete / DLC overrides may be wrong)")
        else:
            # Write a small provenance snapshot so exports can be audited for parity.
            try:
                gfc = dll_manager.get_game_file_cache()
                rpfman = getattr(gfc, "RpfMan", None)
                prov = {
                    "schema": "webglgta-vfs-provenance-v1",
                    "game_path": str(game_path),
                    "selected_dlc": str(getattr(gfc, "SelectedDlc", "") or ""),
                    "enable_mods": bool(getattr(gfc, "EnableMods", False)),
                    "enable_dlc": bool(getattr(gfc, "EnableDlc", False)),
                    "rpf_counts": {
                        "base": int(len(getattr(rpfman, "BaseRpfs", []) or [])) if rpfman is not None else None,
                        "dlc": int(len(getattr(rpfman, "DlcRpfs", []) or [])) if rpfman is not None else None,
                        "all": int(len(getattr(rpfman, "AllRpfs", []) or [])) if rpfman is not None else None,
                    },
                }
                try:
                    dlc_names = getattr(gfc, "DlcNameList", None)
                    if dlc_names is not None:
                        prov["dlc_name_list"] = [str(x) for x in list(dlc_names)]
                except Exception:
                    pass

                (output_dir / "vfs_provenance.json").write_text(
                    json.dumps(prov, indent=2),
                    encoding="utf-8",
                )
            except Exception:
                # Never fail extraction due to provenance.
                pass

        # Write VFS indexes by default (cheap, very useful for overlap debugging).
        if not args.no_vfs_index:
            try:
                gfc = dll_manager.get_game_file_cache()
                # 1) Resolved dictionaries (best representation of “active” files).
                stats = write_resolved_dict_index(
                    game_file_cache=gfc,
                    out_path=(output_dir / "vfs_resolved_dicts.jsonl"),
                )
                logger.info(f"Wrote resolved dict index: {stats}")

                # 2) Optional raw EntryDict snapshot (useful for deep debugging, not strictly “resolved”).
                if args.write_entrydict_snapshot:
                    rpfman = getattr(gfc, "RpfMan", None) or dll_manager.get_rpf_manager()
                    snap_path = output_dir / "vfs_snapshot_index.jsonl"
                    exts = {".ymap", ".ytd", ".ytyp", ".ymt", ".ybn", ".ydr", ".ydd", ".yft", ".ycd", ".ypt", ".gxt2", ".dat", ".xml", ".meta"}
                    stats2 = write_vfs_snapshot_index(
                        rpf_manager=rpfman,
                        out_path=snap_path,
                        include_exts=exts,
                        max_entries=int(args.entrydict_snapshot_max),
                        hash_first_n=int(args.entrydict_snapshot_hash_first),
                    )
                    logger.info(f"Wrote EntryDict snapshot index: {stats2}")
            except Exception as e:
                logger.warning(f"Failed to write VFS snapshot index: {e}")
            
        # Initialize terrain system with DLL manager
        terrain_system = TerrainSystem(str(game_path), dll_manager)
        
        # Extract terrain data
        logger.info("Extracting terrain data...")
        if not terrain_system.extract_terrain():
            logger.error("Failed to extract terrain data")
            return False
        
        # Get terrain info
        terrain_info = terrain_system.get_terrain_info()
        
        # Log heightmap info
        logger.info(f"Loaded {terrain_info['num_heightmaps']} heightmap(s)")
        for path, dims in terrain_info['dimensions'].items():
            logger.info(f"  - {path}: {dims['width']}x{dims['height']}")
        
        # Log texture info
        logger.info(f"Loaded {terrain_info['num_textures']} texture(s)")
        for name, tex_info in terrain_info.get('texture_info', {}).items():
            # `texture_info` can contain meta keys like `layers` (list) and `blend_mask` (bool)
            if not isinstance(tex_info, dict):
                continue
            fmt = tex_info.get('format', 'unknown')
            has_normal = bool(tex_info.get('has_normal', False))
            logger.info(f"  - {name}: {fmt}" + (" (with normal map)" if has_normal else ""))
        
        # Initialize building system with terrain system
        building_system = BuildingSystem(str(game_path), dll_manager, terrain_system, output_dir=output_dir)
        
        # Extract building data
        logger.info("Extracting building data...")
        if not building_system.extract_buildings():
            logger.warning("Building extraction returned no results (continuing with terrain-only output).")
        
        # Get building info
        building_info = building_system.get_building_info()
        
        # Log building info
        logger.info(f"Loaded {building_info['num_buildings']} buildings")
        logger.info(f"Loaded {building_info['num_structures']} structures")
        logger.info("Building types:")
        for btype, count in building_info['building_types'].items():
            logger.info(f"  - {btype}: {count}")
        
        # Log water info
        if building_info.get('water_info') and building_info['water_info'].get('num_vertices') is not None:
            water_info = building_info['water_info']
            logger.info("Water data:")
            logger.info(f"  - Vertices: {water_info['num_vertices']}")
            logger.info(f"  - Triangles: {water_info['num_triangles']}")
            logger.info(f"  - Bounds: {water_info['bounds']}")
        
        # Create visualizations
        logger.info("Creating visualizations...")
        terrain_system.visualize_terrain(output_dir)
        
        # Export 3D mesh
        logger.info("Exporting 3D mesh...")
        terrain_system.export_obj(str(output_dir / 'terrain.obj'))
        
        # Export building mesh
        logger.info("Exporting building mesh...")
        building_system.export_obj(str(output_dir / 'buildings.obj'))
        
        # Export terrain info
        logger.info("Exporting terrain info...")
        terrain_system.export_terrain_info(output_dir)
        
        # Export building info
        logger.info("Exporting building info...")
        building_system.export_building_info(output_dir)

        # Parity report: small summary + sampled hashes to validate “1:1 inputs”
        try:
            report = {
                "schema": "webglgta-parity-report-v1",
                "inputs": {
                    "heightmaps": [],
                    "terrain_ytd_sources": getattr(terrain_system, "parity_texture_sources", []) or [],
                    "ymap_samples": getattr(building_system, "parity_ymap_samples", []) or [],
                },
            }

            # Hash heightmap sources we actually loaded.
            rpfman = dll_manager.get_rpf_manager()
            for p in (terrain_system.heightmaps or {}).keys():
                try:
                    data = rpfman.GetFileData(str(p).replace("/", "\\"))
                    b = bytes(data) if data else b""
                    report["inputs"]["heightmaps"].append({
                        "path": str(p),
                        "size": int(len(b)),
                        "sha1": sha1_hex(b),
                    })
                except Exception:
                    report["inputs"]["heightmaps"].append({"path": str(p), "sha1": None})

            (output_dir / "parity_report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        except Exception:
            pass
        
        elapsed_time = time.time() - start_time
        logger.info(f"Terrain and building extraction completed in {elapsed_time:.2f} seconds")
        logger.info(f"Output files saved to {output_dir.absolute()}")
        
        return True
        
    except Exception as e:
        logger.error(f"An error occurred: {e}")
        if args.debug:
            import traceback
            logger.debug(traceback.format_exc())
        return False
        
    finally:
        # Cleanup
        if 'dll_manager' in locals():
            dll_manager.cleanup()

if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)
