"""Apply Desk Pal's reusable starter animation library to a rigged GLB."""

import bpy
import math
import numpy as np
import os
import sys

# Blender 3.4 glTF compatibility under Debian's NumPy 1.24.
if "bool" not in np.__dict__:
    np.bool = np.bool_


def arguments():
    values = sys.argv[sys.argv.index("--") + 1:]
    if len(values) != 2:
        raise RuntimeError("Expected rigged input GLB and animated output GLB")
    return values


def reset_pose(armature):
    for bone in armature.pose.bones:
        bone.rotation_mode = "XYZ"
        bone.rotation_euler = (0, 0, 0)
        bone.location = (0, 0, 0)
        bone.scale = (1, 1, 1)


def key_rotation(bone, frame, x=0.0, y=0.0, z=0.0):
    if bone:
        bone.rotation_euler = (x, y, z)
        bone.keyframe_insert("rotation_euler", frame=frame)


def create_action(armature, name):
    reset_pose(armature)
    action = bpy.data.actions.new(name=name)
    armature.animation_data.action = action
    return action


def build_starter_animations(armature, family):
    armature.animation_data_create()
    actions = []

    action = create_action(armature, "idle")
    spine = armature.pose.bones.get("spine") or armature.pose.bones.get("neck")
    for frame, angle in ((1, -0.025), (20, 0.035), (40, -0.025)):
        key_rotation(spine, frame, z=angle)
    actions.append(action)

    action = create_action(armature, "walk")
    pairs = [("thigh_l", "thigh_r"), ("upper_arm_l", "upper_arm_r")] if family == "humanoid" else [("front_upper_l", "front_upper_r"), ("back_upper_r", "back_upper_l")]
    for frame, angle in ((1, 0.38), (11, -0.38), (21, 0.38), (31, -0.38), (41, 0.38)):
        for left, right in pairs:
            key_rotation(armature.pose.bones.get(left), frame, x=angle)
            key_rotation(armature.pose.bones.get(right), frame, x=-angle)
    actions.append(action)

    action = create_action(armature, "turn")
    root = armature.pose.bones.get("root")
    for frame, angle in ((1, 0.0), (16, math.radians(24)), (32, 0.0)):
        key_rotation(root, frame, z=angle)
    actions.append(action)

    action = create_action(armature, "jump")
    reset_pose(armature)
    for frame, height in ((1, 0.0), (8, -0.06), (17, 0.32), (26, 0.0), (34, 0.0)):
        root.location.z = height
        root.keyframe_insert("location", frame=frame)
    actions.append(action)

    action = create_action(armature, "react")
    head = armature.pose.bones.get("head")
    for frame, angle in ((1, 0.0), (8, -0.16), (16, 0.18), (25, 0.0)):
        key_rotation(head, frame, y=angle)
    actions.append(action)

    armature.animation_data.action = None
    for action in actions:
        track = armature.animation_data.nla_tracks.new()
        track.name = action.name
        track.strips.new(action.name, int(action.frame_range[0]), action)


def main():
    input_path, output_path = arguments()
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=input_path)
    armatures = [obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE"]
    if len(armatures) != 1:
        raise RuntimeError("The animation stage requires exactly one Desk Pal armature")
    armature = armatures[0]
    family = "quadruped" if armature.pose.bones.get("front_upper_l") else "humanoid"
    build_starter_animations(armature, family)
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=output_path, export_format="GLB", export_skins=True, export_animations=True, export_nla_strips=True, export_force_sampling=True)
    if not os.path.isfile(output_path) or os.path.getsize(output_path) < 20:
        raise RuntimeError("Blender did not produce an animated GLB")


if __name__ == "__main__":
    main()
