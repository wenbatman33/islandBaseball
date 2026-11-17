"""正規流程第 2、3 步：骨架沿用已對位的標準人形骨架，權重從專業調好的基礎人體轉印過來。

基礎人體用 MakeHuman（Blender 的 MPFB 外掛，CC0）：乾淨佈線的人體＋ mixamo 規格骨架＋人工調好的權重。
做法：
  1. 產生運動員體型的基礎人體與 mixamo 骨架
  2. 把基礎人體的每根骨頭擺到我們骨架的關節位置（方向與長度都對齊）→ 基礎人體的身體變形成和球員相同的站姿與比例
  3. 球員的新網格（重新佈線過的四邊形網格）每個頂點，取基礎人體表面最近處的權重
  4. 新網格掛到我們的骨架上，連同原本的動作一起匯出（結構與 fit_rig_batter.py 的輸出相同，可直接交給 rig_v7.py）

需要 MPFB 外掛，所以不能加 --factory-startup：
  /Applications/Blender.app/Contents/MacOS/Blender -b --python transfer_rig.py -- <已對位骨架＋動作.glb> <重新佈線的網格.glb> <輸出.glb> [檢查用.blend]
"""
import os
import sys

import bpy
from mathutils import Matrix, Vector

from bl_ext.blender_org.mpfb.services.humanservice import HumanService
from bl_ext.blender_org.mpfb.services.targetservice import TargetService

argv = sys.argv[sys.argv.index("--") + 1:]
RIGGED, QUAD, OUT = argv[0], argv[1], argv[2]
DEBUG = argv[3] if len(argv) > 3 else None

bpy.ops.wm.read_homefile(use_empty=True)
scene = bpy.context.scene
scene.render.fps = 30


def only(*obs):
    for o in scene.objects:
        o.select_set(o in obs)
    bpy.context.view_layer.objects.active = obs[0]


# ════════ 我們的骨架（含動作）與新網格 ════════
bpy.ops.import_scene.gltf(filepath=RIGGED)
arm = next(o for o in scene.objects if o.type == "ARMATURE")
old_body = next(o for o in scene.objects if o.type == "MESH" and o.parent is arm)
for o in list(scene.objects):
    if o not in (arm, old_body):
        bpy.data.objects.remove(o)
before = set(scene.objects)
bpy.ops.import_scene.gltf(filepath=QUAD)
body = next(o for o in scene.objects if o not in before and o.type == "MESH")
for o in [o for o in scene.objects if o not in before and o is not body]:
    bpy.data.objects.remove(o)
body.parent = None
body.matrix_world = Matrix.Identity(4)
import bmesh  # noqa: E402

bm = bmesh.new()
bm.from_mesh(body.data)
bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)  # 貼圖接縫上的重複點合併，權重才會連續
bm.to_mesh(body.data)
bm.free()
print(f"新網格：頂點 {len(body.data.vertices)}  面 {len(body.data.polygons)}")

ours = {b.name: (arm.matrix_world @ b.head_local, arm.matrix_world @ b.tail_local) for b in arm.data.bones}

# ════════ 基礎人體 ════════
md = TargetService.get_default_macro_info_dict()
md.update(gender=1.0, age=0.5, muscle=0.85, weight=0.55, height=0.75, proportions=0.6)
base = HumanService.create_human(scale=1.0, macro_detail_dict=md, feet_on_ground=True)
HumanService.add_builtin_rig(base, "mixamo", import_weights=True)
src_arm = next(o for o in scene.objects if o.type == "ARMATURE" and o is not arm)
# 先縮放到大致相同的身高（之後每根骨頭還會個別對齊）
zs = [(base.matrix_world @ v.co).z for v in base.data.vertices]
k = (ours["mixamorig:Head"][0].z) / (src_arm.matrix_world @ src_arm.data.bones["mixamorig:Head"].head_local).z
for o in (src_arm, base):
    if o.parent is None:
        o.scale = (k, k, k)
bpy.context.view_layer.update()
only(src_arm)
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
if base.parent is None:
    only(base)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
bpy.context.view_layer.update()
print(f"基礎人體縮放 ×{k:.4f}")

# ════════ 把基礎人體的骨頭擺到我們的關節位置 ════════
rest = {b.name: b.matrix_local.copy() for b in src_arm.data.bones}
for b in src_arm.data.bones:
    b.inherit_scale = "NONE"  # 每根骨頭的長度各自對齊，不往下傳
only(src_arm)
bpy.ops.object.mode_set(mode="POSE")
matched = 0
for b in src_arm.data.bones:  # 父骨頭排在前面
    if b.name not in ours:
        continue
    pb = src_arm.pose.bones[b.name]
    h, t = ours[b.name]
    kids = [c.name for c in b.children if c.name in ours]
    # 骨頭的方向：有唯一的子骨頭就指向子骨頭的起點（關節位置最準），否則用我們骨頭自己的方向
    aim = ours[kids[0]][0] if len(kids) == 1 else t
    y_src = (b.tail_local - b.head_local)
    y_dst = (aim - h)
    if y_dst.length < 1e-5:
        y_dst = t - h
    q = y_src.normalized().rotation_difference(y_dst.normalized())
    sy = y_dst.length / y_src.length if len(kids) == 1 else 1.0
    M = Matrix.Translation(h) @ (q.to_matrix() @ rest[b.name].to_3x3()).to_4x4() @ Matrix.Diagonal((1, sy, 1, 1))
    pb.matrix = src_arm.matrix_world.inverted() @ M
    bpy.context.view_layer.update()
    matched += 1
bpy.ops.object.mode_set(mode="OBJECT")
print(f"對齊骨頭 {matched} 根")

# 變形後的基礎人體存成實體網格（輔助用的隱藏幾何會被遮罩修改器去掉），當作權重來源
dg = bpy.context.evaluated_depsgraph_get()
src_mesh = bpy.data.meshes.new_from_object(base.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
src = bpy.data.objects.new("weight_src", src_mesh)
scene.collection.objects.link(src)
src.matrix_world = base.matrix_world.copy()
for g in base.vertex_groups:  # new_from_object 不帶群組名稱：照原本的順序補回來
    if g.name not in src.vertex_groups:
        src.vertex_groups.new(name=g.name)
print(f"權重來源：頂點 {len(src.data.vertices)}  群組 {len(src.vertex_groups)}")

# ════════ 轉印權重 ════════
bone_names = {b.name for b in arm.data.bones}
for g in list(src.vertex_groups):
    if g.name not in bone_names:
        src.vertex_groups.remove(g)
only(body)
for g in list(body.vertex_groups):
    body.vertex_groups.remove(g)
mod = body.modifiers.new("wt", "DATA_TRANSFER")
mod.object = src
mod.use_vert_data = True
mod.data_types_verts = {"VGROUP_WEIGHTS"}
mod.vert_mapping = "POLYINTERP_NEAREST"
mod.layers_vgroup_select_src = "ALL"
mod.layers_vgroup_select_dst = "NAME"
bpy.ops.object.datalayout_transfer(modifier="wt")
bpy.ops.object.modifier_apply(modifier="wt")
bpy.ops.object.vertex_group_limit_total(group_select_mode="ALL", limit=4)
bpy.ops.object.vertex_group_normalize_all(group_select_mode="ALL", lock_active=False)
unw = sum(1 for v in body.data.vertices if sum(g.weight for g in v.groups) < 1e-4)
print(f"轉印完成：群組 {len(body.vertex_groups)}  沒有權重的頂點 {unw}")

# ════════ 掛到我們的骨架、匯出 ════════
body.name = "output_unwrapped"
body.parent = arm
body.matrix_parent_inverse = arm.matrix_world.inverted()
am = body.modifiers.new("Armature", "ARMATURE")
am.object = arm
bpy.data.objects.remove(old_body)
if DEBUG:
    bpy.ops.wm.save_as_mainfile(filepath=DEBUG)
bpy.data.objects.remove(src)
bpy.data.objects.remove(base)
bpy.data.objects.remove(src_arm)
only(body, arm)
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_animations=True,
                          export_animation_mode="NLA_TRACKS", export_image_format="JPEG", export_image_quality=95)
print("已匯出:", OUT, os.path.getsize(OUT), "bytes")
