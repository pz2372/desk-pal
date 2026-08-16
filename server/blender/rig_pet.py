"""Fit a Desk Pal canonical humanoid/quadruped armature to corrected GLB landmarks."""

import bpy
import json
import math
import numpy as np
import os
import sys
from mathutils import Vector

# Blender 3.4's bundled glTF importer still references np.bool, which NumPy
# 1.24 removed. Keep the Debian/Render build compatible until Blender is bumped.
if "bool" not in np.__dict__:
    np.bool = np.bool_

MAX_RIG_TRIANGLES = 200000


def arguments():
    values = sys.argv[sys.argv.index("--") + 1:]
    if len(values) != 3:
        raise RuntimeError("Expected input GLB, rig guide JSON, and output GLB")
    return values


def gltf_point(values):
    # Three.js exposes glTF's Y-up coordinates. Blender's importer converts them to Z-up.
    return Vector((float(values[0]), -float(values[2]), float(values[1])))


def validate_guide(guide):
    family = guide.get("family")
    if family not in ("humanoid", "quadruped"):
        raise RuntimeError("Rig guide family must be humanoid or quadruped")
    expected_template = f"desk_pal_{family}_v2"
    if guide.get("templateId") != expected_template:
        raise RuntimeError(f"Rig guide template must be {expected_template}")
    names = set()
    for landmark in guide.get("landmarks", []):
        name = landmark.get("name")
        if not name or name in names:
            raise RuntimeError(f"Rig guide contains a missing or duplicate landmark: {name}")
        names.add(name)
        values = landmark.get("position")
        if landmark.get("required") and (not isinstance(values, list) or len(values) != 3):
            raise RuntimeError(f"Rig guide is missing required landmark: {name}")
        if values and not all(isinstance(value, (int, float)) and math.isfinite(value) for value in values):
            raise RuntimeError(f"Rig guide contains invalid coordinates for: {name}")


def lerp(a, b, amount):
    return a + (b - a) * amount


def add_bone(edit_bones, name, head, tail, parent=None, deform=True):
    if (tail - head).length < 0.0001:
        tail = head + Vector((0.0, 0.0, 0.01))
    bone = edit_bones.new(name)
    bone.head = head
    bone.tail = tail
    bone.parent = parent
    bone.use_deform = deform
    return bone


def build_humanoid(edit_bones, points):
    pelvis, head = points["pelvis"], points["head"]
    height = max((head - pelvis).length, 0.1)
    chest = lerp(pelvis, head, 0.58)
    neck = lerp(pelvis, head, 0.84)
    root = add_bone(edit_bones, "root", pelvis, pelvis + Vector((0, 0, height * 0.08)), deform=False)
    spine = add_bone(edit_bones, "pelvis", pelvis, chest, root)
    chest_bone = add_bone(edit_bones, "spine", chest, neck, spine)
    neck_bone = add_bone(edit_bones, "neck", neck, lerp(neck, head, 0.55), chest_bone)
    add_bone(edit_bones, "head", lerp(neck, head, 0.55), head, neck_bone)
    for side in ("left", "right"):
        hand = points[f"{side}_hand"]
        shoulder = points.get(f"{side}_shoulder", lerp(chest, hand, 0.24))
        elbow = points.get(f"{side}_elbow", lerp(shoulder, hand, 0.55))
        upper = add_bone(edit_bones, f"upper_arm_{side[0]}", shoulder, elbow, chest_bone)
        add_bone(edit_bones, f"forearm_{side[0]}", elbow, hand, upper)
        foot = points[f"{side}_foot"]
        hip = points.get(f"{side}_hip", lerp(pelvis, foot, 0.16))
        knee = points.get(f"{side}_knee", lerp(hip, foot, 0.56))
        thigh = add_bone(edit_bones, f"thigh_{side[0]}", hip, knee, spine)
        add_bone(edit_bones, f"shin_{side[0]}", knee, foot, thigh)
    return chest_bone, root


def build_quadruped(edit_bones, points):
    pelvis, chest, head = points["pelvis"], points["chest"], points["head"]
    length = max((head - pelvis).length, 0.1)
    root = add_bone(edit_bones, "root", pelvis, pelvis + Vector((0, 0, length * 0.08)), deform=False)
    spine = add_bone(edit_bones, "pelvis", pelvis, chest, root)
    neck = add_bone(edit_bones, "neck", chest, lerp(chest, head, 0.55), spine)
    add_bone(edit_bones, "head", lerp(chest, head, 0.55), head, neck)
    for end, anchor, prefix in (("front", chest, "front"), ("back", pelvis, "back")):
        for side in ("left", "right"):
            paw = points[f"{end}_{side}_paw"]
            if end == "front":
                upper_start = points.get(f"front_{side}_shoulder", lerp(anchor, paw, 0.15))
                joint = points.get(f"front_{side}_elbow", lerp(upper_start, paw, 0.55))
            else:
                upper_start = points.get(f"back_{side}_hip", lerp(anchor, paw, 0.15))
                joint = points.get(f"back_{side}_knee", lerp(upper_start, paw, 0.55))
            upper = add_bone(edit_bones, f"{prefix}_upper_{side[0]}", upper_start, joint, spine)
            add_bone(edit_bones, f"{prefix}_lower_{side[0]}", joint, paw, upper)
    return spine, root


def add_extras(edit_bones, points, chest_parent, root_parent):
    if "tail_base" in points and "tail_tip" in points:
        add_bone(edit_bones, "tail", points["tail_base"], points["tail_tip"], root_parent)
    for side in ("left", "right"):
        name = f"{side}_wing_tip"
        root_name = f"{side}_wing_root"
        if name in points and root_name in points:
            root = points[root_name]
            middle = lerp(root, points[name], 0.52)
            first = add_bone(edit_bones, f"wing_{side[0]}_01", root, middle, chest_parent)
            add_bone(edit_bones, f"wing_{side[0]}_02", middle, points[name], first)


def optimize_dense_meshes(meshes):
    """Reduce oversized generation meshes before desktop skinning/export."""
    triangle_count = sum(len(mesh.data.polygons) for mesh in meshes)
    if triangle_count <= MAX_RIG_TRIANGLES:
        return triangle_count
    ratio = max(0.02, min(1.0, MAX_RIG_TRIANGLES / float(triangle_count)))
    print(f"Optimizing dense pet mesh: {triangle_count} -> about {MAX_RIG_TRIANGLES} triangles", flush=True)
    for mesh in meshes:
        if not mesh.data.polygons:
            continue
        bpy.ops.object.select_all(action="DESELECT")
        mesh.select_set(True)
        bpy.context.view_layer.objects.active = mesh
        modifier = mesh.modifiers.new(name="DeskPalDesktopOptimize", type="DECIMATE")
        modifier.decimate_type = "COLLAPSE"
        modifier.ratio = ratio
        modifier.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier=modifier.name)
    optimized_count = sum(len(mesh.data.polygons) for mesh in meshes)
    print(f"Dense pet optimization complete: {optimized_count} triangles", flush=True)
    return optimized_count


def has_usable_weights(meshes, armature, sample_limit=4096):
    deform_names = {bone.name for bone in armature.data.bones if bone.use_deform}
    for mesh in meshes:
        group_names = {group.index: group.name for group in mesh.vertex_groups}
        if not any(modifier.type == "ARMATURE" and modifier.object == armature for modifier in mesh.modifiers):
            return False
        vertex_count = len(mesh.data.vertices)
        step = max(1, vertex_count // sample_limit)
        sampled = range(0, vertex_count, step)
        for index in sampled:
            vertex = mesh.data.vertices[index]
            if not any(group_names.get(member.group) in deform_names and member.weight > 0.0001 for member in vertex.groups):
                return False
    return True


def apply_nearest_bone_weights(meshes, armature):
    """Batched fallback for meshes where Blender's bone-heat solver is too slow."""
    bones = [bone for bone in armature.data.bones if bone.use_deform]
    if not bones:
        raise RuntimeError("The generated armature has no deform bones")
    inverse_armature = armature.matrix_world.inverted()
    for mesh in meshes:
        world_matrix = mesh.matrix_world.copy()
        for group in list(mesh.vertex_groups):
            mesh.vertex_groups.remove(group)
        groups = {bone.name: mesh.vertex_groups.new(name=bone.name) for bone in bones}
        if not any(modifier.type == "ARMATURE" and modifier.object == armature for modifier in mesh.modifiers):
            modifier = mesh.modifiers.new(name="DeskPalArmature", type="ARMATURE")
            modifier.object = armature
        mesh.parent = armature
        mesh.matrix_world = world_matrix
        vertex_count = len(mesh.data.vertices)
        coordinates = np.empty(vertex_count * 3, dtype=np.float64)
        mesh.data.vertices.foreach_get("co", coordinates)
        coordinates = coordinates.reshape((-1, 3))
        transform = np.asarray(inverse_armature @ mesh.matrix_world, dtype=np.float64)
        homogeneous = np.column_stack((coordinates, np.ones(vertex_count, dtype=np.float64)))
        points = (homogeneous @ transform.T)[:, :3]

        best_distance = np.full(vertex_count, np.inf, dtype=np.float64)
        second_distance = np.full(vertex_count, np.inf, dtype=np.float64)
        best_bone = np.full(vertex_count, -1, dtype=np.int16)
        second_bone = np.full(vertex_count, -1, dtype=np.int16)
        for bone_index, bone in enumerate(bones):
            start = np.asarray(bone.head_local, dtype=np.float64)
            end = np.asarray(bone.tail_local, dtype=np.float64)
            segment = end - start
            length_squared = max(float(np.dot(segment, segment)), 0.00000001)
            amount = np.clip(((points - start) @ segment) / length_squared, 0.0, 1.0)
            distance = np.linalg.norm(points - (start + amount[:, None] * segment), axis=1)
            nearer = distance < best_distance
            second_nearer = (~nearer) & (distance < second_distance)
            second_distance = np.where(nearer, best_distance, np.where(second_nearer, distance, second_distance))
            second_bone = np.where(nearer, best_bone, np.where(second_nearer, bone_index, second_bone))
            best_distance = np.where(nearer, distance, best_distance)
            best_bone = np.where(nearer, bone_index, best_bone)

        first_inverse = 1.0 / np.maximum(best_distance, 0.000001)
        second_inverse = 1.0 / np.maximum(second_distance, 0.000001)
        first_weight = first_inverse / (first_inverse + second_inverse)
        second_weight = 1.0 - first_weight
        exact = best_distance < 0.000001
        first_weight[exact] = 1.0
        second_weight[exact] = 0.0

        # Quantization turns hundreds of thousands of individual Blender API
        # calls into a small set of batched assignments with negligible visual
        # difference for a tiny desktop pet.
        levels = 32
        first_weight = np.round(first_weight * levels) / levels
        second_weight = 1.0 - first_weight
        for bone_index, bone in enumerate(bones):
            group = groups[bone.name]
            for bone_map, weights in ((best_bone, first_weight), (second_bone, second_weight)):
                selected = bone_map == bone_index
                for weight in np.unique(weights[selected]):
                    if weight <= 0.0:
                        continue
                    indices = np.flatnonzero(selected & (weights == weight)).astype(np.int32).tolist()
                    if indices:
                        group.add(indices, float(weight), "REPLACE")


def main():
    input_path, guide_path, output_path = arguments()
    with open(guide_path, "r", encoding="utf-8") as handle:
        guide = json.load(handle)
    validate_guide(guide)
    points = {item["name"]: gltf_point(item["position"]) for item in guide["landmarks"] if item.get("position")}

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=input_path)
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if not meshes:
        raise RuntimeError("The generated GLB contains no mesh")
    optimize_dense_meshes(meshes)

    armature_data = bpy.data.armatures.new("DeskPalRig")
    armature = bpy.data.objects.new("DeskPalRig", armature_data)
    bpy.context.collection.objects.link(armature)
    bpy.context.view_layer.objects.active = armature
    armature.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    if guide["family"] == "humanoid":
        chest_parent, root_parent = build_humanoid(armature_data.edit_bones, points)
    elif guide["family"] == "quadruped":
        chest_parent, root_parent = build_quadruped(armature_data.edit_bones, points)
    else:
        raise RuntimeError("Only humanoid and quadruped guides are supported")
    add_extras(armature_data.edit_bones, points, chest_parent, root_parent)
    bpy.ops.object.mode_set(mode="OBJECT")

    bpy.ops.object.select_all(action="DESELECT")
    for mesh in meshes:
        mesh.select_set(True)
    armature.select_set(True)
    bpy.context.view_layer.objects.active = armature
    automatic_weight_error = None
    vertex_count = sum(len(mesh.data.vertices) for mesh in meshes)
    if vertex_count <= 200000:
        try:
            bpy.ops.object.parent_set(type="ARMATURE_AUTO")
        except RuntimeError as error:
            automatic_weight_error = error
    else:
        automatic_weight_error = RuntimeError(f"mesh has {vertex_count} vertices; using batched weights")
    if automatic_weight_error or not has_usable_weights(meshes, armature):
        print(f"Automatic skin weights unavailable; using nearest-bone fallback: {automatic_weight_error or 'incomplete weights'}")
        apply_nearest_bone_weights(meshes, armature)
    if not has_usable_weights(meshes, armature):
        raise RuntimeError("Rig validation failed because vertices remain unweighted")
    armature["desk_pal_template"] = guide["templateId"]
    armature["desk_pal_rig_confidence"] = float(guide["confidence"])
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=output_path, export_format="GLB", export_skins=True, export_animations=False)
    if not os.path.isfile(output_path) or os.path.getsize(output_path) < 20:
        raise RuntimeError("Blender did not produce a valid output model")


if __name__ == "__main__":
    main()
