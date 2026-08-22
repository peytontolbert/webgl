import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from export_drawables_for_chunk import (
    _fragment_model_pose_matrix,
    _transform_rigid_fragment_geometry,
)


def vec(x, y, z, w):
    return SimpleNamespace(X=x, Y=y, Z=z, W=w)


def main() -> None:
    pose = SimpleNamespace(
        Row1=vec(0.0, -1.0, 0.0, 4.0),
        Row2=vec(1.0, 0.0, 0.0, 5.0),
        Row3=vec(0.0, 0.0, 1.0, 6.0),
    )
    fragment = SimpleNamespace(BoneTransforms=SimpleNamespace(Items=[pose]))
    drawable = SimpleNamespace(OwnerFragment=fragment)
    model = SimpleNamespace(HasSkin=0, BoneIndex=0)

    matrix = _fragment_model_pose_matrix(drawable, model)
    points = np.array([[1.0, 2.0, 3.0]], dtype=np.float32)
    tangents = np.array([[1.0, 0.0, 0.0, 1.0]], dtype=np.float32)
    transformed_points, transformed_tangents = _transform_rigid_fragment_geometry(
        points, tangents, matrix
    )

    np.testing.assert_allclose(transformed_points, [[2.0, 6.0, 9.0]])
    np.testing.assert_allclose(transformed_tangents, [[0.0, 1.0, 0.0, 1.0]])
    assert _fragment_model_pose_matrix(drawable, SimpleNamespace(HasSkin=1, BoneIndex=0)) is None
    print("fragment pose export: rigid model bind transform passed")


if __name__ == "__main__":
    main()
