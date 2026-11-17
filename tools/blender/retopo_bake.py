"""正規流程第 1 步：重新佈線＋烘焙。

AI 生成的模型是雜亂的三角網格，彎曲時皺摺會亂跑。這支腳本：
  1. 把高精細模型擺正（腳踩地、置中、縮放到指定身高）
  2. 用 QuadriFlow 重新佈線成整齊的四邊形網格（左右對稱）
  3. 新網格重新展開 UV，再把高精細模型的顏色烘焙到新貼圖（低模包住高模，沿法線取色）
  4. 匯出靜態 GLB

執行：
  /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python retopo_bake.py -- <高精細.glb> <輸出.glb> [四邊形數=9000] [身高=1.903] [貼圖=2048]
"""
import os
import sys

import bpy
import numpy as np

argv = sys.argv[sys.argv.index("--") + 1:]
SRC, OUT = argv[0], argv[1]
QUADS = int(argv[2]) if len(argv) > 2 else 9000
HEIGHT = float(argv[3]) if len(argv) > 3 else 1.903
TEX = int(argv[4]) if len(argv) > 4 else 2048

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
bpy.ops.import_scene.gltf(filepath=SRC)
hi = next(o for o in scene.objects if o.type == "MESH")


def only(ob):
    for o in scene.objects:
        o.select_set(o is ob)
    bpy.context.view_layer.objects.active = ob


# ── 擺正 ──
only(hi)
bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
for o in list(scene.objects):
    if o is not hi:
        bpy.data.objects.remove(o)
P = np.array([v.co[:] for v in hi.data.vertices])
lo, up = P.min(0), P.max(0)
k = HEIGHT / (up[2] - lo[2])
shift = np.array([-(lo[0] + up[0]) / 2, -(lo[1] + up[1]) / 2, -lo[2]])
for v in hi.data.vertices:
    v.co = (np.array(v.co[:]) + shift) * k
hi.name = "hi"
print(f"高精細：{len(hi.data.polygons)} 面，身高 {HEIGHT}")

# ── 重新佈線 ──
only(hi)
bpy.ops.object.duplicate()
low = bpy.context.view_layer.objects.active
low.name = "player"
low.data.name = "player"
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.mesh.remove_doubles(threshold=1e-5)  # 貼圖接縫上的重複點先合併，網格才是封閉的一整塊
bpy.ops.object.mode_set(mode="OBJECT")
low.data.materials.clear()
# QuadriFlow 處理 50 萬面很慢：先減到 10 萬面（外形幾乎不變）再佈線
m = low.modifiers.new("d", "DECIMATE")
m.ratio = min(1.0, 100000 / max(1, len(low.data.polygons)))
bpy.ops.object.modifier_apply(modifier="d")
bpy.ops.object.quadriflow_remesh(use_mesh_symmetry=True, use_preserve_sharp=False, use_preserve_boundary=False,
                                 mode="FACES", target_faces=QUADS, seed=0)
# 佈線後偶爾留下幾條邊的小破洞：補起來，網格才是封閉的（自動權重需要封閉的網格）
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.mesh.fill_holes(sides=12)
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode="OBJECT")
for p in low.data.polygons:
    p.use_smooth = True
nq = sum(1 for p in low.data.polygons if len(p.vertices) == 4)
print(f"重新佈線：{len(low.data.polygons)} 面（四邊形 {nq}），頂點 {len(low.data.vertices)}")

# ── UV ──
only(low)
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.uv.smart_project(angle_limit=1.15, island_margin=0.004)
bpy.ops.object.mode_set(mode="OBJECT")

# ── 烘焙顏色 ──
img = bpy.data.images.new("player_color", TEX, TEX, alpha=False)
mat = bpy.data.materials.new("player")
mat.use_nodes = True
nt = mat.node_tree
bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
tex = nt.nodes.new("ShaderNodeTexImage")
tex.image = img
nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
bsdf.inputs["Roughness"].default_value = 0.78
bsdf.inputs["Metallic"].default_value = 0.0
nt.nodes.active = tex
low.data.materials.append(mat)

# 取色方式：新貼圖的每個像素 → 它在新網格上的位置 → 高精細模型上「最近的表面」→ 讀那裡的顏色。
# 不用射線烘焙：帽簷、護耳、領口這些薄的地方，射線會穿過去取到後面（額頭、脖子）的顏色
from mathutils.bvhtree import BVHTree  # noqa: E402

hi.data.calc_loop_triangles()
hv = np.array([v.co[:] for v in hi.data.vertices])
ht = np.array([t.vertices[:] for t in hi.data.loop_triangles])
hl = np.array([t.loops[:] for t in hi.data.loop_triangles])
huv = np.zeros(len(hi.data.loops) * 2, dtype=np.float32)
hi.data.uv_layers.active.data.foreach_get("uv", huv)
huv = huv.reshape(-1, 2)
himg = next(n.image for n in hi.data.materials[0].node_tree.nodes
            if n.type == "TEX_IMAGE" and any(l.to_socket.name == "Base Color" for l in n.outputs["Color"].links))
hw, hh = himg.size
hpx = np.zeros(hw * hh * 4, dtype=np.float32)
himg.pixels.foreach_get(hpx)
hpx = hpx.reshape(hh, hw, 4)
bvh = BVHTree.FromPolygons([tuple(v) for v in hv], [tuple(t) for t in ht])

low.data.calc_loop_triangles()
lv = np.array([v.co[:] for v in low.data.vertices])
luv = np.zeros(len(low.data.loops) * 2, dtype=np.float32)
low.data.uv_layers.active.data.foreach_get("uv", luv)
luv = luv.reshape(-1, 2)
px_i, px_j, pos = [], [], []
for t in low.data.loop_triangles:
    uv = luv[list(t.loops)] * TEX - 0.5  # 像素中心座標
    p3 = lv[list(t.vertices)]
    x0, x1 = int(np.floor(uv[:, 0].min())) - 1, int(np.ceil(uv[:, 0].max())) + 1
    y0, y1 = int(np.floor(uv[:, 1].min())) - 1, int(np.ceil(uv[:, 1].max())) + 1
    x0, y0, x1, y1 = max(x0, 0), max(y0, 0), min(x1, TEX - 1), min(y1, TEX - 1)
    if x1 < x0 or y1 < y0:
        continue
    gx, gy = np.meshgrid(np.arange(x0, x1 + 1), np.arange(y0, y1 + 1))
    a, b, c = uv
    den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
    if abs(den) < 1e-9:
        continue
    w0 = ((b[1] - c[1]) * (gx - c[0]) + (c[0] - b[0]) * (gy - c[1])) / den
    w1 = ((c[1] - a[1]) * (gx - c[0]) + (a[0] - c[0]) * (gy - c[1])) / den
    w2 = 1 - w0 - w1
    inside = (w0 >= -0.02) & (w1 >= -0.02) & (w2 >= -0.02)
    if not inside.any():
        continue
    px_i.append(gy[inside])
    px_j.append(gx[inside])
    pos.append(w0[inside][:, None] * p3[0] + w1[inside][:, None] * p3[1] + w2[inside][:, None] * p3[2])
px_i, px_j, pos = np.concatenate(px_i), np.concatenate(px_j), np.concatenate(pos)
print(f"取色像素 {len(pos)}")
from mathutils import Vector  # noqa: E402

near = np.zeros((len(pos), 3))
tri = np.zeros(len(pos), dtype=np.int64)
for n in range(len(pos)):
    loc, _nor, idx, _d = bvh.find_nearest(Vector(pos[n]))
    near[n] = loc
    tri[n] = idx
A, B, C = hv[ht[tri, 0]], hv[ht[tri, 1]], hv[ht[tri, 2]]
v0, v1, v2 = B - A, C - A, near - A
d00, d01, d11 = (v0 * v0).sum(1), (v0 * v1).sum(1), (v1 * v1).sum(1)
d20, d21 = (v2 * v0).sum(1), (v2 * v1).sum(1)
dn = np.maximum(d00 * d11 - d01 * d01, 1e-20)
bv = (d11 * d20 - d01 * d21) / dn
bw = (d00 * d21 - d01 * d20) / dn
bu = 1 - bv - bw
uvh = bu[:, None] * huv[hl[tri, 0]] + bv[:, None] * huv[hl[tri, 1]] + bw[:, None] * huv[hl[tri, 2]]
sx = np.clip((uvh[:, 0] % 1.0) * hw, 0, hw - 1).astype(np.int64)
sy = np.clip((uvh[:, 1] % 1.0) * hh, 0, hh - 1).astype(np.int64)
out = np.zeros((TEX, TEX, 4), dtype=np.float32)
done = np.zeros((TEX, TEX), dtype=bool)
out[px_i, px_j] = hpx[sy, sx]
done[px_i, px_j] = True
# 邊緣外擴：UV 碎塊外圍補上鄰近顏色，貼圖縮小取樣時邊緣才不會混到黑色
for _ in range(8):
    for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
        src_ok = np.roll(done, (dy, dx), (0, 1))
        fill = src_ok & ~done
        out[fill] = np.roll(out, (dy, dx), (0, 1))[fill]
        done |= fill
out[..., 3] = 1.0
img.pixels.foreach_set(out.ravel())
print("取色完成")
img.pack()

# ── 匯出 ──
bpy.data.objects.remove(hi)
only(low)
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_image_format="JPEG", export_image_quality=95)
print("已匯出:", OUT, os.path.getsize(OUT), "bytes")
