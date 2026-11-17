"""從正交剪影量測模型的身體輪廓：正面（x–z）與側面（y–z）各算一張白色剪影，每 1 公分一列印出實心的區段。

執行：
  /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python measure_silhouette.py -- <模型.glb> <輸出資料夾>
"""
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
GLB, OUT = argv[0], argv[1]
os.makedirs(OUT, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
bpy.ops.import_scene.gltf(filepath=GLB)
white = bpy.data.materials.new("white")
white.use_nodes = True
nt = white.node_tree
for n in list(nt.nodes):
    nt.nodes.remove(n)
em = nt.nodes.new("ShaderNodeEmission")
em.inputs["Color"].default_value = (1, 1, 1, 1)
nt.links.new(em.outputs[0], nt.nodes.new("ShaderNodeOutputMaterial").inputs["Surface"])
P = []
for o in scene.objects:
    if o.type == "MESH":
        o.data.materials.clear()
        o.data.materials.append(white)
        P += [o.matrix_world @ v.co for v in o.data.vertices]
P = np.array([p[:] for p in P])
lo, hi = P.min(0), P.max(0)
world = bpy.data.worlds.new("w")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (0, 0, 0, 1)
scene.world = world
cd = bpy.data.cameras.new("c")
cd.type = "ORTHO"
cam = bpy.data.objects.new("c", cd)
scene.collection.objects.link(cam)
scene.camera = cam
scene.render.engine = "BLENDER_EEVEE"
scene.view_settings.view_transform = "Standard"
scene.render.film_transparent = False
PX = 0.0025  # 每個像素 2.5 公釐
H = hi[2] - lo[2] + 0.04
W = max(hi[0] - lo[0], hi[1] - lo[1]) + 0.04
scene.render.resolution_x = int(W / PX)
scene.render.resolution_y = int(H / PX)
cd.ortho_scale = max(W, H)
cd.sensor_fit = "AUTO"
cz = (lo[2] + hi[2]) / 2

for tag, pos, axis in (("front", Vector((0, -5, cz)), 0), ("side", Vector((5, 0, cz)), 1)):
    cam.location = pos
    cam.rotation_euler = (Vector((0, 0, cz)) - pos).to_track_quat("-Z", "Y").to_euler()
    path = os.path.join(OUT, f"sil_{tag}.png")
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(path)
    w, h = img.size
    a = np.array(img.pixels[:]).reshape(h, w, 4)[:, :, 0] > 0.5  # 第 0 列是畫面最下面
    # 像素 → 世界座標（正面：畫面 x 往右＝世界 +x；側面從 +X 往 -X 看：畫面 x 往右＝世界 -y）
    span = cd.ortho_scale
    sx = span / max(w, h)
    x0 = -w * sx / 2
    z0 = cz - h * sx / 2
    print(f"=== 剪影 {tag}（{'x' if axis == 0 else 'y'} 方向）===")
    for zi in np.arange(0.01, hi[2] + 0.005, 0.01):
        r = int(round((zi - z0) / sx))
        if not 0 <= r < h:
            continue
        row = a[r]
        edges = np.flatnonzero(np.diff(np.concatenate([[0], row.astype(int), [0]])))
        segs = edges.reshape(-1, 2)
        def coord(px):
            c = x0 + px * sx
            return c if axis == 0 else -c
        txt = "  ".join(f"[{min(coord(s), coord(e)):+.3f},{max(coord(s), coord(e)):+.3f}]" for s, e in segs)
        print(f"z={zi:.2f} {txt}")
