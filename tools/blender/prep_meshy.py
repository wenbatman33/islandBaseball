"""整理 Meshy 匯出的高面數模型：擺正（腳踩地、置中）、縮放、減面、貼圖縮小，匯出成靜態 GLB，並印出各高度的身體切片供量測關節。

執行：
  /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python prep_meshy.py -- <輸入.glb> <輸出.glb> [目標三角形數=22000] [身高=原尺寸]
"""
import os
import sys

import bpy
import numpy as np

argv = sys.argv[sys.argv.index("--") + 1:]
SRC, OUT = argv[0], argv[1]
TARGET = int(argv[2]) if len(argv) > 2 else 22000
HEIGHT = float(argv[3]) if len(argv) > 3 else None
TEX = 2048

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
bpy.ops.import_scene.gltf(filepath=SRC)
meshes = [o for o in scene.objects if o.type == "MESH"]
for o in scene.objects:
    o.select_set(o in meshes)
bpy.context.view_layer.objects.active = meshes[0]
if len(meshes) > 1:
    bpy.ops.object.join()
ob = bpy.context.view_layer.objects.active
# 匯入時可能有父物件或旋轉：全部套用成頂點座標
bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
for o in list(scene.objects):
    if o is not ob:
        bpy.data.objects.remove(o)
ob.name = "player"
ob.data.name = "player"

# 擺正：腳底在 z=0，水平置中；需要的話等比例縮放到指定身高
P = np.array([v.co[:] for v in ob.data.vertices])
lo, hi = P.min(0), P.max(0)
shift = np.array([-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, -lo[2]])
k = HEIGHT / (hi[2] - lo[2]) if HEIGHT else 1.0
for v in ob.data.vertices:
    v.co = (np.array(v.co[:]) + shift) * k
print(f"縮放 {k:.4f}  原始身高 {hi[2] - lo[2]:.3f} → {(hi[2] - lo[2]) * k:.3f}")

# 先把同位置的點合併：匯入的模型在每條貼圖接縫上點是分開的兩份，網格在接縫處沒有連起來，
# 減面時接縫兩邊各縮各的會裂開（臉上、衣服上一條條裂紋）。貼圖座標存在面的角上，合併點不會弄亂貼圖
for o in scene.objects:
    o.select_set(o is ob)
bpy.context.view_layer.objects.active = ob
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.mesh.remove_doubles(threshold=1e-5)
bpy.ops.object.mode_set(mode="OBJECT")
print(f"合併接縫後頂點 {len(ob.data.vertices)}")

# 減面
tris0 = sum(len(p.vertices) - 2 for p in ob.data.polygons)
mod = ob.modifiers.new("dec", "DECIMATE")
mod.decimate_type = "COLLAPSE"
mod.ratio = min(1.0, TARGET / tris0)
mod.use_collapse_triangulate = True
mod.delimit = {'UV'}  # 不合併貼圖接縫上的點，保留 Meshy 原本的 UV
bpy.ops.object.modifier_apply(modifier=mod.name)
for p in ob.data.polygons:
    p.use_smooth = True
tris1 = sum(len(p.vertices) - 2 for p in ob.data.polygons)
print(f"減面 {tris0} → {tris1} 三角形，頂點 {len(ob.data.vertices)}")

# 材質：只留顏色貼圖（法線貼圖是照高面數模型算的，減面後會對不上），粗糙度固定、不要金屬感。
# 顏色貼圖維持原本的 2048：Meshy 的 UV 碎塊很多且緊貼，縮小貼圖會讓碎塊邊緣混色（遊戲裡另外關掉 mipmap）
mat = ob.data.materials[0]
nt = mat.node_tree
bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
base_img = bsdf.inputs["Base Color"].links[0].from_node.image
for name in ("Metallic", "Roughness", "Normal"):
    for link in list(bsdf.inputs[name].links):
        nt.links.remove(link)
bsdf.inputs["Metallic"].default_value = 0.0
bsdf.inputs["Roughness"].default_value = 0.78
for n in list(nt.nodes):
    if n.type == "TEX_IMAGE" and n.image is not base_img:
        nt.nodes.remove(n)
if TEX and base_img.size[0] > TEX:
    base_img.scale(TEX, TEX)
print(f"顏色貼圖 {base_img.size[0]}x{base_img.size[1]}")

# 切片：每 2 公分一層，列出這一層有幾段（以 x 方向的空隙分段）與每段的範圍，用來找胯下、腋下、手腕、脖子
P = np.array([v.co[:] for v in ob.data.vertices])
H = P[:, 2].max()
print(f"=== 切片（身高 {H:.3f}，寬 {np.ptp(P[:, 0]):.3f}）===")
for z in np.arange(0.02, H, 0.02):
    s = P[np.abs(P[:, 2] - z) < 0.006]
    if len(s) == 0:
        continue
    xs = np.sort(s[:, 0])
    cuts = np.where(np.diff(xs) > 0.025)[0]
    segs = np.split(xs, cuts + 1)
    txt = "  ".join(f"[{g[0]:+.3f},{g[-1]:+.3f}]" for g in segs)
    print(f"z={z:.2f} y[{s[:, 1].min():+.3f},{s[:, 1].max():+.3f}] 段數 {len(segs)}: {txt}")

for o in scene.objects:
    o.select_set(o is ob)
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_image_format="JPEG", export_image_quality=95)
print("已匯出:", OUT, os.path.getsize(OUT), "bytes")
