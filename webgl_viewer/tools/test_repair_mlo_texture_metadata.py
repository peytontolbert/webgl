import importlib.util
from pathlib import Path


module_path = Path(__file__).with_name("repair_mlo_texture_bindings.py")
spec = importlib.util.spec_from_file_location("repair_mlo_texture_bindings", module_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

manifest = {
    "textureCompression": {"unresolvedReferences": 99},
    "meshes": {
        "1": {
            "lods": {
                "high": {
                    "submeshes": [
                        {
                            "material": {
                                "diffuse": "models_textures/10.png",
                                "shaderParams": {
                                    "texturesByHash": {
                                        "1186448975": "models_textures/20.png",
                                        "1619499462": "models_textures/20.png",
                                    }
                                },
                            }
                        }
                    ]
                }
            }
        }
    },
}

changed = module._update_texture_compression_metadata(manifest, {"20"})
assert changed
assert manifest["textureCompression"]["unresolvedReferences"] == 2
assert manifest["textureCompression"]["focusedUnresolvedReferences"] == 1

print("MLO texture metadata contract passed")
