"""Render deterministic orthographic views of a GLB for semantic anatomy analysis."""

import bpy
import json
import numpy as np
import os
import sys
from mathutils import Vector

# Blender 3.4's bundled glTF importer still references np.bool, which NumPy
# 1.24 removed. Keep the Debian/Render build compatible until Blender is bumped.
if "bool" not in np.__dict__:
    np.bool = np.bool_


def arguments():
    values = sys.argv[sys.argv.index("--") + 1:]
    if len(values) != 2:
        raise RuntimeError("Expected input GLB and output directory")
    return values


def bounds_for(meshes):
    points = [obj.matrix_world @ Vector(corner) for obj in meshes for corner in obj.bound_box]
    if not points:
        raise RuntimeError("The generated GLB contains no visible mesh bounds")
    minimum = Vector((min(point.x for point in points), min(point.y for point in points), min(point.z for point in points)))
    maximum = Vector((max(point.x for point in points), max(point.y for point in points), max(point.z for point in points)))
    return minimum, maximum


def look_at(camera, target):
    camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()


def matrix_rows(matrix):
    return [[float(matrix[row][column]) for column in range(4)] for row in range(4)]


def main():
    input_path, output_dir = arguments()
    os.makedirs(output_dir, exist_ok=True)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=input_path)
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH" and not obj.hide_render]
    if not meshes:
        raise RuntimeError("The generated GLB contains no mesh")

    minimum, maximum = bounds_for(meshes)
    center = (minimum + maximum) * 0.5
    dimensions = maximum - minimum
    diagonal = max(dimensions.length, 0.1)
    distance = diagonal * 2.6
    ortho_scale = max(dimensions.x, dimensions.y, dimensions.z, 0.1) * 1.32

    scene = bpy.context.scene
    # These frames are coordinate guides for GPT, not final artwork. Workbench
    # preserves the silhouette and separated limbs while staying fast on a
    # CPU-only Render worker, even for dense Tripo meshes.
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "MATERIAL"
    scene.display.shading.show_shadows = True
    scene.display.shading.show_cavity = True
    scene.render.resolution_x = 512
    scene.render.resolution_y = 512
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.film_transparent = False
    if scene.world is None:
        scene.world = bpy.data.worlds.new("DeskPalAnalysisWorld")
    scene.world.color = (0.035, 0.045, 0.065)
    scene.camera = None

    camera_data = bpy.data.cameras.new("DeskPalAnalysisCamera")
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = ortho_scale
    camera = bpy.data.objects.new("DeskPalAnalysisCamera", camera_data)
    bpy.context.collection.objects.link(camera)
    scene.camera = camera

    for index, (location, energy, size) in enumerate((
        (center + Vector((diagonal, -diagonal, diagonal)), 1100, diagonal * 1.4),
        (center + Vector((-diagonal, -diagonal * 0.4, diagonal * 0.5)), 700, diagonal),
        (center + Vector((0, diagonal, diagonal * 0.8)), 900, diagonal * 1.2),
    )):
        light_data = bpy.data.lights.new(f"AnalysisLight{index}", type="AREA")
        light_data.energy = energy
        light_data.size = max(size, 0.1)
        light = bpy.data.objects.new(f"AnalysisLight{index}", light_data)
        bpy.context.collection.objects.link(light)
        light.location = location
        look_at(light, center)

    directions = {
        "front": Vector((0, -1, 0)),
        "front_left": Vector((-0.7071, -0.7071, 0)),
        "left": Vector((-1, 0, 0)),
        "back": Vector((0, 1, 0)),
        "right": Vector((1, 0, 0)),
        "front_right": Vector((0.7071, -0.7071, 0)),
    }
    views = []
    for name, direction in directions.items():
        camera.location = center + direction * distance
        look_at(camera, center)
        bpy.context.view_layer.update()
        path = os.path.join(output_dir, f"{name}.png")
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        if not os.path.isfile(path) or os.path.getsize(path) < 100:
            raise RuntimeError(f"Blender did not render the {name} view")
        views.append({
            "name": name,
            "file": os.path.basename(path),
            "matrixWorld": matrix_rows(camera.matrix_world),
            "orthoScale": float(camera.data.ortho_scale),
            "resolution": [scene.render.resolution_x, scene.render.resolution_y],
        })

    geometry = {
        "coordinateSystem": "blender_z_up",
        "bounds": {"min": list(minimum), "max": list(maximum)},
        "center": list(center),
        "dimensions": list(dimensions),
        "diagonal": float(diagonal),
        "meshCount": len(meshes),
        "vertexCount": sum(len(obj.data.vertices) for obj in meshes),
        "views": views,
    }
    with open(os.path.join(output_dir, "cameras.json"), "w", encoding="utf-8") as handle:
        json.dump(geometry, handle, indent=2)


if __name__ == "__main__":
    main()
