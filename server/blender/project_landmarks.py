"""Project GPT's normalized render landmarks onto the actual GLB mesh."""

import bpy
import json
import numpy as np
import os
import sys
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

# Blender 3.4's bundled glTF importer still references np.bool, which NumPy
# 1.24 removed. Keep the Debian/Render build compatible until Blender is bumped.
if "bool" not in np.__dict__:
    np.bool = np.bool_


def arguments():
    values = sys.argv[sys.argv.index("--") + 1:]
    if len(values) != 4:
        raise RuntimeError("Expected input GLB, anatomy JSON, cameras JSON, and output JSON")
    return values


def world_bvh(meshes):
    dependency_graph = bpy.context.evaluated_depsgraph_get()
    vertices = []
    triangles = []
    for source in meshes:
        evaluated = source.evaluated_get(dependency_graph)
        mesh = evaluated.to_mesh()
        mesh.calc_loop_triangles()
        offset = len(vertices)
        vertices.extend([evaluated.matrix_world @ vertex.co for vertex in mesh.vertices])
        triangles.extend([tuple(offset + index for index in triangle.vertices) for triangle in mesh.loop_triangles])
        evaluated.to_mesh_clear()
    if not vertices or not triangles:
        raise RuntimeError("The generated GLB has no projectable mesh triangles")
    return BVHTree.FromPolygons(vertices, triangles, all_triangles=True)


def gltf_point(point):
    # Inverse of the glTF Y-up to Blender Z-up conversion used by rig_pet.py.
    return [float(point.x), float(point.z), float(-point.y)]


def ray_midpoint(tree, origin, direction, diagonal):
    epsilon = max(diagonal * 0.00002, 0.000001)
    cursor = origin
    remaining = diagonal * 10.0
    hits = []
    for _ in range(16):
        location, _normal, _index, distance = tree.ray_cast(cursor, direction, remaining)
        if location is None:
            break
        if not hits or (location - hits[-1]).length > epsilon * 4:
            hits.append(location.copy())
        step = max(float(distance), 0.0) + epsilon
        cursor = cursor + direction * step
        remaining -= step
        if remaining <= 0:
            break
    if len(hits) >= 2:
        return (hits[0] + hits[1]) * 0.5
    return hits[0] if hits else None


def main():
    input_path, anatomy_path, cameras_path, output_path = arguments()
    with open(anatomy_path, "r", encoding="utf-8") as handle:
        anatomy = json.load(handle)
    with open(cameras_path, "r", encoding="utf-8") as handle:
        camera_data = json.load(handle)

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=input_path)
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    tree = world_bvh(meshes)
    views = {view["name"]: view for view in camera_data["views"]}
    diagonal = max(float(camera_data.get("diagonal", 1.0)), 0.1)
    projected = []
    missed = []

    for landmark in anatomy.get("landmarks", []):
        view = views.get(landmark.get("view"))
        if not view:
            missed.append({"name": landmark.get("name"), "reason": "unknown_view"})
            continue
        x, y = float(landmark.get("x", -1)), float(landmark.get("y", -1))
        if not (0 <= x <= 1 and 0 <= y <= 1):
            missed.append({"name": landmark.get("name"), "reason": "invalid_coordinate"})
            continue
        matrix = Matrix(view["matrixWorld"])
        width, height = view.get("resolution", [640, 640])
        aspect = float(width) / max(float(height), 1.0)
        ortho_height = float(view["orthoScale"])
        ortho_width = ortho_height * aspect
        camera_x = (x - 0.5) * ortho_width
        camera_y = (0.5 - y) * ortho_height
        origin = matrix @ Vector((camera_x, camera_y, 0.0))
        direction = matrix.to_quaternion() @ Vector((0.0, 0.0, -1.0))
        direction.normalize()
        position = ray_midpoint(tree, origin, direction, diagonal)
        if position is not None:
            projected.append({"name": landmark["name"], "position": gltf_point(position), "view": landmark["view"], "confidence": landmark.get("confidence", 0), "visible": bool(landmark.get("visible"))})
        else:
            missed.append({"name": landmark.get("name"), "reason": "ray_missed_mesh", "view": landmark.get("view")})

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as handle:
        json.dump({"landmarks": projected, "missed": missed, "requestedCount": len(anatomy.get("landmarks", [])), "projectedCount": len(projected)}, handle, indent=2)


if __name__ == "__main__":
    main()
