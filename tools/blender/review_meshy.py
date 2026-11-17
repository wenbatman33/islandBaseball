"""檢查 Meshy 匯出的 GLB：印出網格與貼圖的數據，再打光從各角度算圖（全身 8 個方向＋頭部特寫）。

執行：
  /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python review_meshy.py -- <模型.glb> <輸出資料夾>
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

# ── 數據 ──
lo = Vector((1e9, 1e9, 1e9))
hi = Vector((-1e9, -1e9, -1e9))
print("=== 物件 ===")
for o in scene.objects:
    print(f"{o.type:8s} {o.name}  父={o.parent.name if o.parent else '-'}")
    if o.type != "MESH":
        continue
    me = o.data
    tris = sum(len(p.vertices) - 2 for p in me.polygons)
    print(f"  頂點 {len(me.vertices)}  面 {len(me.polygons)}  三角形 {tris}  UV 層 {len(me.uv_layers)}  材質 {len(me.materials)}")
    for v in me.vertices:
        w = o.matrix_world @ v.co
        lo = Vector(map(min, lo, w))
        hi = Vector(map(max, hi, w))
    for mat in me.materials:
        if not mat or not mat.use_nodes:
            continue
        for n in mat.node_tree.nodes:
            if n.type == "TEX_IMAGE" and n.image:
                used = [l.to_socket.name for l in n.outputs["Color"].links]
                print(f"  貼圖 {n.image.name}  {n.image.size[0]}x{n.image.size[1]}  接到 {used}")
size = hi - lo
print("=== 尺寸（Blender 座標，Z 朝上）===")
print(f"  範圍 X {lo.x:.3f}～{hi.x:.3f}  Y {lo.y:.3f}～{hi.y:.3f}  Z {lo.z:.3f}～{hi.z:.3f}")
print(f"  寬 {size.x:.3f}  深 {size.y:.3f}  高 {size.z:.3f}")
print(f"  動畫 {len(bpy.data.actions)}  骨架 {sum(1 for o in scene.objects if o.type == 'ARMATURE')}")

# ── 打光與相機 ──
world = bpy.data.worlds.new("w")
world.use_nodes = True
bg = world.node_tree.nodes["Background"]
bg.inputs["Color"].default_value = (0.42, 0.45, 0.5, 1)
bg.inputs["Strength"].default_value = 0.9
scene.world = world


def light(name, kind, energy, rot, size=1.0):
    d = bpy.data.lights.new(name, kind)
    d.energy = energy
    if kind == "AREA":
        d.size = size
    o = bpy.data.objects.new(name, d)
    o.rotation_euler = [math.radians(a) for a in rot]
    scene.collection.objects.link(o)
    return o


light("key", "SUN", 3.2, (50, 0, 35))  # 主光：右前上方
light("fill", "SUN", 1.0, (65, 0, -60))  # 補光：左前
light("rim", "SUN", 1.6, (60, 0, 180))  # 輪廓光：後方

cam_data = bpy.data.cameras.new("cam")
cam_data.sensor_fit = "VERTICAL"
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

center = (lo + hi) / 2
H = size.z


def shoot(path, target, dist, az, el, fov, res):
    # az：0＝正面（角色面向 -Y）、90＝角色的左側；el：仰角
    a, e = math.radians(az), math.radians(el)
    cam.location = target + Vector((math.sin(a) * math.cos(e), -math.cos(a) * math.cos(e), math.sin(e))) * dist
    cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
    cam_data.angle_y = math.radians(fov)
    scene.render.resolution_x, scene.render.resolution_y = res
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


# 全身：8 個方向
for az in (0, 45, 90, 135, 180, 225, 270, 315):
    shoot(os.path.join(OUT, f"body_{az:03d}.png"), center, H * 2.3, az, 6, 26, (600, 900))
# 頭部特寫：頭大約在最上面 1/6
head = Vector((center.x, center.y, hi.z - H * 0.085))
for az, el, tag in ((0, 0, "front"), (35, 8, "q_left"), (-35, 8, "q_right"), (90, 0, "side"), (180, 10, "back"), (0, 45, "top"), (0, -30, "below")):
    shoot(os.path.join(OUT, f"head_{tag}.png"), head, H * 0.75, az, el, 22, (700, 700))
print("=== 算圖完成 ===")
