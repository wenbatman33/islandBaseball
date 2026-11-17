"""把已綁定的 GLB 擺出各動作的幾個關鍵格算圖，檢查皮膚變形（腋下、手肘、膝蓋、肩膀有沒有扭曲或穿模）。

執行：
  /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python render_poses.py -- <已綁定.glb> <輸出資料夾>
"""
import math
import os
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
GLB, OUT = argv[0], argv[1]
os.makedirs(OUT, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = 30
bpy.ops.import_scene.gltf(filepath=GLB)
arm = next(o for o in scene.objects if o.type == "ARMATURE")
for o in list(scene.objects):
    if o.type == "MESH" and o.parent is not arm:
        bpy.data.objects.remove(o)
if arm.animation_data:
    for t in list(arm.animation_data.nla_tracks):
        arm.animation_data.nla_tracks.remove(t)

# Meshy 動作名稱依生成時間排序對回名字（和 rig_v7.py 相同）
uuids = sorted((a for a in bpy.data.actions if a.name.startswith("_")), key=lambda a: a.name)
names = dict(zip(["pitch", "idle", "ready", "crouch", "catchUp", "throw", "swing"], uuids))
names["run"] = next(a for a in bpy.data.actions if a.name.startswith("Running"))

world = bpy.data.worlds.new("w")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.42, 0.45, 0.5, 1)
scene.world = world
for nm, e, rot in (("key", 3.2, (50, 0, 35)), ("fill", 1.0, (65, 0, -60)), ("rim", 1.6, (60, 0, 180))):
    d = bpy.data.lights.new(nm, "SUN")
    d.energy = e
    d.use_shadow = nm == "key"  # 只留主光的陰影：多盞平行光的自身陰影在變形網格上會出現斑塊
    o = bpy.data.objects.new(nm, d)
    o.rotation_euler = [math.radians(a) for a in rot]
    scene.collection.objects.link(o)
cam_data = bpy.data.cameras.new("cam")
cam_data.sensor_fit = "VERTICAL"
cam_data.angle_y = math.radians(30)
cam = bpy.data.objects.new("cam", cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
for eng in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
    try:
        scene.render.engine = eng
        break
    except Exception:
        continue
scene.view_settings.view_transform = "Standard"
scene.render.resolution_x, scene.render.resolution_y = 500, 700

SHOTS = [("idle", 0), ("ready", 20), ("swing", 0), ("swing", 30), ("swing", 45), ("swing", 60),
         ("throw", 30), ("throw", 45), ("pitch", 40), ("crouch", 45), ("catchUp", 40), ("run", 5)]
ad = arm.animation_data or arm.animation_data_create()
for clip, f in SHOTS:
    act = names[clip]
    ad.action = act
    if hasattr(act, "slots") and len(act.slots):
        ad.action_slot = act.slots[0]
    scene.frame_set(f)
    hips = arm.matrix_world @ arm.pose.bones["mixamorig:Hips"].head
    target = Vector((hips.x, hips.y, 0.95))
    for az in (20, 110):
        a = math.radians(az)
        cam.location = target + Vector((math.sin(a), -math.cos(a), 0.12)) * 4.2
        cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = os.path.join(OUT, f"{clip}_{f:02d}_{az}.png")
        bpy.ops.render.render(write_still=True)
print("=== 算圖完成 ===")
