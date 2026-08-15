"""Fit a Desk Pal canonical humanoid/quadruped armature to corrected GLB landmarks."""

import bpy
import json
import math
import os
import sys
from mathutils import Vector


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
        if name in points:
            root = chest_parent.tail
            middle = lerp(root, points[name], 0.52)
            first = add_bone(edit_bones, f"wing_{side[0]}_01", root, middle, chest_parent)
            add_bone(edit_bones, f"wing_{side[0]}_02", middle, points[name], first)


def distance_to_bone(point, bone):
    start, end = bone.head_local, bone.tail_local
    segment = end - start
    length_squared = segment.length_squared
    if length_squared < 0.00000001:
        return (point - start).length
    amount = max(0.0, min(1.0, (point - start).dot(segment) / length_squared))
    return (point - (start + segment * amount)).length


def has_usable_weights(meshes, armature):
    deform_names = {bone.name for bone in armature.data.bones if bone.use_deform}
    for mesh in meshes:
        group_names = {group.index: group.name for group in mesh.vertex_groups}
        if not any(modifier.type == "ARMATURE" and modifier.object == armature for modifier in mesh.modifiers):
            return False
        for vertex in mesh.data.vertices:
            if not any(group_names.get(member.group) in deform_names and member.weight > 0.0001 for member in vertex.groups):
                return False
    return True


def apply_nearest_bone_weights(meshes, armature):
    """Reliable fallback for meshes where Blender's bone-heat solver fails."""
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
        for vertex in mesh.data.vertices:
            point = inverse_armature @ (mesh.matrix_world @ vertex.co)
            nearest = sorted(((distance_to_bone(point, bone), bone) for bone in bones), key=lambda item: item[0])[:2]
            if len(nearest) == 1 or nearest[0][0] < 0.000001:
                groups[nearest[0][1].name].add([vertex.index], 1.0, "REPLACE")
                continue
            first_weight = 1.0 / max(nearest[0][0], 0.000001)
            second_weight = 1.0 / max(nearest[1][0], 0.000001)
            total = first_weight + second_weight
            groups[nearest[0][1].name].add([vertex.index], first_weight / total, "REPLACE")
            groups[nearest[1][1].name].add([vertex.index], second_weight / total, "REPLACE")


def reset_pose(armature):
    for bone in armature.pose.bones:
        bone.rotation_mode = "XYZ"
        bone.rotation_euler = (0, 0, 0)
        bone.location = (0, 0, 0)
        bone.scale = (1, 1, 1)


def key_rotation(bone, frame, x=0.0, y=0.0, z=0.0):
    if not bone:
        return
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
    if family == "humanoid":
        pairs = [("thigh_l", "thigh_r"), ("upper_arm_l", "upper_arm_r")]
    else:
        pairs = [("front_upper_l", "front_upper_r"), ("back_upper_r", "back_upper_l")]
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
    return actions


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
    try:
        bpy.ops.object.parent_set(type="ARMATURE_AUTO")
    except RuntimeError as error:
        automatic_weight_error = error
    if automatic_weight_error or not has_usable_weights(meshes, armature):
        print(f"Automatic skin weights unavailable; using nearest-bone fallback: {automatic_weight_error or 'incomplete weights'}")
        apply_nearest_bone_weights(meshes, armature)
    if not has_usable_weights(meshes, armature):
        raise RuntimeError("Rig validation failed because vertices remain unweighted")
    armature["desk_pal_template"] = guide["templateId"]
    armature["desk_pal_rig_confidence"] = float(guide["confidence"])
    build_starter_animations(armature, guide["family"])
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=output_path, export_format="GLB", export_skins=True, export_animations=True, export_nla_strips=True, export_force_sampling=True)
    if not os.path.isfile(output_path) or os.path.getsize(output_path) < 20:
        raise RuntimeError("Blender did not produce a valid output model")


if __name__ == "__main__":
    main()
