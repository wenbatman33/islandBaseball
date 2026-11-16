"""把 sheet_to_model.py 產生的模型減面、烘焙貼圖並匯出成 GLB。

執行：
  /Applications/Blender.app/Contents/MacOS/Blender -b out_sheet/player_from_sheet.blend --python export_glb.py -- <輸出.glb> [目標三角面數]
"""
import math
import os
import sys

import bpy

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = argv[0]
TARGET_TRIS = int(argv[1]) if len(argv) > 1 else 36000
TEX_SIZE = 2048

scene = bpy.context.scene
obj = bpy.data.objects["player"]
for o in bpy.data.objects:
    o.select_set(False)
bpy.context.view_layer.objects.active = obj
obj.select_set(True)

# 套用體素重建與平滑
for m in list(obj.modifiers):
    bpy.ops.object.modifier_apply(modifier=m.name)
tris = sum(len(p.vertices) - 2 for p in obj.data.polygons)
print("重建後三角面數:", tris)

# 減面
dec = obj.modifiers.new("decimate", "DECIMATE")
dec.ratio = min(1.0, TARGET_TRIS / max(1, tris))
bpy.ops.object.modifier_apply(modifier=dec.name)
for p in obj.data.polygons:
    p.use_smooth = True
tris = sum(len(p.vertices) - 2 for p in obj.data.polygons)
print("減面後三角面數:", tris)

# 展開 UV
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.004)
bpy.ops.object.mode_set(mode="OBJECT")

# 把投影的顏色烘焙到一張貼圖
mat = obj.data.materials[0]
nt = mat.node_tree
img = bpy.data.images.new("player_baked", TEX_SIZE, TEX_SIZE, alpha=False)
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
scene.cycles.samples = 4
scene.render.bake.margin = 12
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
obj.data.materials.clear()
obj.data.materials.append(m2)

bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_image_format="JPEG")
print("已匯出:", OUT, os.path.getsize(OUT), "bytes")
