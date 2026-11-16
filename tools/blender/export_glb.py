"""把 sheet_to_model.py 產生的模型減面、烘焙貼圖並匯出成 GLB。

身體和帽子共用一張貼圖，但匯出後是兩個獨立物件（player、cap），帽子可以單獨隱藏或替換。

執行：
  /Applications/Blender.app/Contents/MacOS/Blender -b out_sheet4/player_from_sheet.blend --python export_glb.py -- <輸出.glb> [身體目標三角面數]
"""
import math
import os
import sys

import bmesh
import bpy

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = argv[0]
TARGET_TRIS = int(argv[1]) if len(argv) > 1 else 32000
TEX_SIZE = int(argv[2]) if len(argv) > 2 else 4096  # 遊戲用的輕量版可以給 2048
CROWN_TRIS = int(argv[3]) if len(argv) > 3 else 6000

scene = bpy.context.scene


def activate(o):
    for other in bpy.data.objects:
        other.select_set(False)
    bpy.context.view_layer.objects.active = o
    o.select_set(True)


def tri_count(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)


def bake_down(o, target=None):
    """套用修改器；有指定目標面數就減面。"""
    activate(o)
    for m in list(o.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)
    before = tri_count(o)
    if target and before > target:
        dec = o.modifiers.new("decimate", "DECIMATE")
        dec.ratio = target / before
        bpy.ops.object.modifier_apply(modifier=dec.name)
    for p in o.data.polygons:
        p.use_smooth = True
    print(f"{o.name}: {before} → {tri_count(o)} 三角面")


obj = bpy.data.objects["player"]
bake_down(obj, TARGET_TRIS)
parts = [bpy.data.objects[n] for n in ("cap_crown", "cap_brim", "cap_button") if n in bpy.data.objects]
for o in parts:
    bake_down(o, {"cap_crown": CROWN_TRIS, "cap_brim": CROWN_TRIS // 2}.get(o.name))

# 手是另外建模的，併進身體（不經過體素重建，手指才不會黏在一起）
if "hands" in bpy.data.objects:
    hands = bpy.data.objects["hands"]
    bake_down(hands)
    activate(obj)
    hands.select_set(True)
    bpy.ops.object.join()

# 先合併成一個物件，才能共用一張貼圖；帽子的面用材質編號記住，烘焙完再拆開
n_body = len(obj.data.materials)
activate(obj)
for o in parts:
    o.select_set(True)
if parts:
    bpy.ops.object.join()

bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
# 角度上限設小一點：每一塊都接近正對著展開，不會像之前把整張臉壓扁成一條
bpy.ops.uv.smart_project(angle_limit=math.radians(38), island_margin=0.002)
bpy.ops.uv.average_islands_scale()
bpy.ops.object.mode_set(mode="OBJECT")

# 頭部的每一塊放大，分到比較多的貼圖面積（臉是近看時最常看的地方）
me = obj.data
uvl = me.uv_layers.active.data
zs = [v.co.z for v in me.vertices]
z_neck = min(zs) + (max(zs) - min(zs)) * 0.6
parent = list(range(len(me.polygons)))


def find(i):
    while parent[i] != i:
        parent[i] = parent[parent[i]]
        i = parent[i]
    return i


seen = {}
for p in me.polygons:
    for li in p.loop_indices:
        uv = uvl[li].uv
        key = (me.loops[li].vertex_index, round(uv.x, 5), round(uv.y, 5))
        if key in seen:
            a, b = find(seen[key]), find(p.index)
            if a != b:
                parent[a] = b
        else:
            seen[key] = p.index
islands = {}
for p in me.polygons:
    islands.setdefault(find(p.index), []).append(p)
HEAD_SCALE = 1.7
n_head = 0
for polys in islands.values():
    if sum(p.center.z for p in polys) / len(polys) < z_neck:
        continue
    n_head += 1
    lis = [li for p in polys for li in p.loop_indices]
    cx = sum(uvl[li].uv.x for li in lis) / len(lis)
    cy = sum(uvl[li].uv.y for li in lis) / len(lis)
    for li in lis:
        uvl[li].uv = (cx + (uvl[li].uv.x - cx) * HEAD_SCALE, cy + (uvl[li].uv.y - cy) * HEAD_SCALE)
print(f"貼圖區塊 {len(islands)} 個，其中頭部 {n_head} 個放大 {HEAD_SCALE} 倍")

# 重新排版，把整張貼圖排滿
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.uv.pack_islands(margin=0.002)
bpy.ops.object.mode_set(mode="OBJECT")

# 把每個材質的顏色烘焙到同一張貼圖
img = bpy.data.images.new("player_baked", TEX_SIZE, TEX_SIZE, alpha=False)
for mat in obj.data.materials:
    nt = mat.node_tree
    target = nt.nodes.new("ShaderNodeTexImage")
    target.image = img
    for n in nt.nodes:
        n.select = False
    target.select = True
    nt.nodes.active = target
    bsdf = nt.nodes["Principled BSDF"]
    src = bsdf.inputs["Base Color"].links[0].from_socket
    out = next(n for n in nt.nodes if n.type == "OUTPUT_MATERIAL")
    em = nt.nodes.new("ShaderNodeEmission")
    nt.links.new(src, em.inputs["Color"])
    nt.links.new(em.outputs[0], out.inputs["Surface"])

scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 24  # 手的環境遮蔽需要多一點取樣
scene.render.bake.margin = 16
bpy.ops.object.bake(type="EMIT")
tex_path = os.path.splitext(OUT)[0] + "_tex.png"
img.filepath_raw = tex_path
img.file_format = "PNG"
img.save()
print("已烘焙貼圖:", tex_path)

# 換成只用烘焙貼圖的簡單材質
m2 = bpy.data.materials.new("player_baked")
m2.use_nodes = True
b2 = m2.node_tree.nodes["Principled BSDF"]
t2 = m2.node_tree.nodes.new("ShaderNodeTexImage")
t2.image = bpy.data.images.load(tex_path)
m2.node_tree.links.new(t2.outputs["Color"], b2.inputs["Base Color"])
b2.inputs["Roughness"].default_value = 0.85

# 把帽子拆回獨立物件
export = [obj]
if parts:
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="DESELECT")
    bm = bmesh.from_edit_mesh(obj.data)
    for f in bm.faces:
        f.select_set(f.material_index >= n_body)
    bmesh.update_edit_mesh(obj.data)
    bpy.ops.mesh.separate(type="SELECTED")
    bpy.ops.object.mode_set(mode="OBJECT")
    cap = next(o for o in bpy.context.selected_objects if o is not obj)
    cap.name = "cap"
    cap.data.name = "cap"
    export.append(cap)

for o in export:
    for p in o.data.polygons:
        p.material_index = 0
    o.data.materials.clear()
    o.data.materials.append(m2)
    print(f"匯出物件 {o.name}: {tri_count(o)} 三角面")

for o in bpy.data.objects:
    o.select_set(o in export)
bpy.context.view_layer.objects.active = obj
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_image_format="JPEG", export_image_quality=92)
print("已匯出:", OUT, os.path.getsize(OUT), "bytes")
