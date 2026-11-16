"""審查用：載入「匯出後的 GLB」，用和模型頁一樣不打光的方式，從各種角度高解析度算圖。

檢查的是使用者實際會看到的檔案，而不是建模過程中的中間結果。

執行：
  /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python review_glb.py -- <模型.glb> <輸出資料夾>
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
bpy.ops.import_scene.gltf(filepath=GLB)

# 不打光：貼圖顏色直接當成發光色（等同模型頁預設的顯示方式）
zmin, zmax = 1e9, -1e9
for o in scene.objects:
    if o.type != "MESH":
        continue
    for v in o.data.vertices:
        z = (o.matrix_world @ v.co).z
        zmin, zmax = min(zmin, z), max(zmax, z)
    for mat in o.data.materials:
        nt = mat.node_tree
        tex = next((n for n in nt.nodes if n.type == "TEX_IMAGE"), None)
        out = next(n for n in nt.nodes if n.type == "OUTPUT_MATERIAL")
        em = nt.nodes.new("ShaderNodeEmission")
        if tex:
            tex.interpolation = "Linear"
            nt.links.new(tex.outputs["Color"], em.inputs["Color"])
        nt.links.new(em.outputs[0], out.inputs["Surface"])
H = zmax - zmin

world = bpy.data.worlds.new("w")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.48, 0.5, 0.55, 1)
scene.world = world
cam_data = bpy.data.cameras.new("cam")
cam_data.sensor_fit = "VERTICAL"
cam_data.angle_y = math.radians(30)
cam = bpy.data.objects.new("cam", cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
for name in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
    try:
        scene.render.engine = name
        break
    except Exception:
        continue
scene.view_settings.view_transform = "Standard"
scene.render.image_settings.file_format = "PNG"
scene.render.resolution_x = scene.render.resolution_y = 900


def shoot(name, az, elev, face):
    """az：0 為正面，正值往角色左側轉；elev：正值俯視、負值仰視。"""
    a, e = math.radians(az), math.radians(elev)
    target = Vector((0, 0, zmin + H * (0.8 if face else 0.5)))
    d = 1.9 if face else 5.2
    pos = target + Vector((math.sin(a) * math.cos(e), -math.cos(a) * math.cos(e), math.sin(e))) * d
    cam.location = pos
    cam.rotation_euler = (target - pos).to_track_quat("-Z", "Y").to_euler()
    scene.render.filepath = os.path.join(OUT, name + ".png")
    bpy.ops.render.render(write_still=True)


SHOTS = [
    ("f_000", 0, 8, True), ("f_025", 25, 8, True), ("f_045", 45, 8, True), ("f_055", 55, 8, True),
    ("f_075", 75, 8, True), ("f_090", 90, 8, True), ("f_135", 135, 8, True), ("f_180", 180, 8, True),
    ("f_low_010", 10, -40, True), ("f_low_045", 45, -30, True), ("f_high_025", 25, 40, True), ("f_m045", -45, 8, True),
    ("b_025", 25, 8, False), ("b_low_015", 15, -35, False), ("b_180", 180, 8, False), ("b_high_045", 45, 45, False),
]
for s in SHOTS:
    shoot(*s)


def shoot_at(name, target, az, elev, d):
    """對準指定位置的近距離特寫（手、腋下這類容易漏看的地方）。"""
    a, e = math.radians(az), math.radians(elev)
    target = Vector(target)
    pos = target + Vector((math.sin(a) * math.cos(e), -math.cos(a) * math.cos(e), math.sin(e))) * d
    cam.location = pos
    cam.rotation_euler = (target - pos).to_track_quat("-Z", "Y").to_euler()
    scene.render.filepath = os.path.join(OUT, name + ".png")
    bpy.ops.render.render(write_still=True)


# 很近的臉部特寫：貼圖解析度不夠、五官重複這類問題要貼這麼近才看得出來
shoot_at("d_eye_front", (0.07, -0.2, zmin + H * 0.775), 0, 0, 0.75)
shoot_at("d_eye_040", (0.07, -0.2, zmin + H * 0.775), 40, 0, 0.75)
shoot_at("d_temple_065", (0.12, -0.1, zmin + H * 0.775), 65, 0, 0.8)
shoot_at("d_hand_front", (0.37, 0, zmin + 0.62), 20, 5, 1.0)
shoot_at("d_hand_side", (0.37, 0, zmin + 0.62), 80, -10, 1.0)
shoot_at("d_armpit_low", (0.12, 0, zmin + 0.78), 20, -40, 1.6)
shoot_at("d_legs_low", (0, 0, zmin + 0.4), 20, -35, 2.2)
print("審查圖完成", len(SHOTS))
