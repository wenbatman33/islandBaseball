"""把外部工具（Tripo 等）已經綁好 Mixamo 骨架的模型接進我們的流程：保留它的網格與權重，套上我們的動作。

輸出的 GLB 結構和 meshy_rigged_anims.glb 相同（同樣的骨頭名稱與動作名稱），可以直接交給 rig_v7.py（搭配 RIG_PRO=1）。

做法：
  1. 匯入已綁定的 FBX，整體縮放到指定身高、腳踩地
  2. 拿我們舊骨架（含動作）複製一份，把每根骨頭搬到 FBX 骨架同名關節的位置（保留原本的軸向，只做最小旋轉）。
     權重只認骨頭名稱和關節位置，所以 FBX 的權重可以原封不動沿用
  3. 動作：新骨頭每格複製舊骨頭的世界旋轉，骨盆位置依骨盆高度等比例

執行：
  /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python import_rigged.py -- <舊的已綁定.glb> <外部已綁定.fbx> <輸出.glb> [身高=1.903]
"""
import os
import sys

import bpy
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index("--") + 1:]
OLD, SRC, OUT = argv[0], argv[1], argv[2]
HEIGHT = float(argv[3]) if len(argv) > 3 else 1.903
P_ = "mixamorig:"

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = 30


def only(*obs):
    for o in scene.objects:
        o.select_set(o in obs)
    bpy.context.view_layer.objects.active = obs[0]


# ════════ 舊骨架與動作 ════════
bpy.ops.import_scene.gltf(filepath=OLD)
old_arm = next(o for o in scene.objects if o.type == "ARMATURE")
for o in list(scene.objects):
    if o is not old_arm:
        bpy.data.objects.remove(o)
old_acts = list(bpy.data.actions)

# ════════ 外部模型 ════════
before = set(scene.objects)
bpy.ops.import_scene.fbx(filepath=SRC)
src_arm = next(o for o in scene.objects if o not in before and o.type == "ARMATURE")
body = next(o for o in scene.objects if o not in before and o.type == "MESH")
# 套用物件變換、縮放到指定身高、腳踩地、水平置中
only(src_arm)
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
only(body)
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
pts = [body.matrix_world @ v.co for v in body.data.vertices]
z0 = min(p.z for p in pts)
k = HEIGHT / (max(p.z for p in pts) - z0)
cx = (min(p.x for p in pts) + max(p.x for p in pts)) / 2
T = Matrix.Scale(k, 4) @ Matrix.Translation((-cx, 0, -z0))
body.data.transform(body.matrix_world.inverted() @ T @ body.matrix_world)
joints = {b.name: (T @ src_arm.matrix_world @ b.head_local, T @ src_arm.matrix_world @ b.tail_local) for b in src_arm.data.bones}
print(f"縮放 ×{k:.4f}　頂點 {len(body.data.vertices)}　面 {len(body.data.polygons)}　外部骨頭 {len(joints)}")

# ════════ 新骨架：舊骨架的複本，關節搬到外部骨架的位置 ════════
old_rest = {b.name: (b.matrix_local.copy(), b.head_local.copy(), b.tail_local.copy()) for b in old_arm.data.bones}
new_arm = old_arm.copy()
new_arm.data = old_arm.data.copy()
new_arm.animation_data_clear()
new_arm.name = "SmartRigArmature"
old_arm.name = "OldArmature"
scene.collection.objects.link(new_arm)
only(new_arm)
bpy.ops.object.mode_set(mode="EDIT")
eb = new_arm.data.edit_bones
missing = [n for n in old_rest if n not in joints]
placed = {}
for b in new_arm.data.bones:  # 父骨頭排在前面
    n = b.name
    m, h, t = old_rest[n]
    if n in joints:
        hn = Vector(joints[n][0])
        kids = [c.name for c in b.children if c.name in joints]
        tn = Vector(joints[kids[0]][0]) if len(kids) == 1 else Vector(joints[n][1])
    else:
        # 外部骨架沒有的骨頭（例如 headfront）：跟著父骨頭，維持原本相對父骨頭的位置
        p = b.parent.name
        off_h, off_t = h - old_rest[p][1], t - old_rest[p][1]
        hn, tn = placed[p][0] + off_h * placed[p][2], placed[p][0] + off_t * placed[p][2]
    yo = (t - h).normalized()
    d = tn - hn
    if d.length < 0.012:  # 手套裡的手指骨縮成一個點：維持原本的方向、給一點長度（零長度的骨頭會被 Blender 刪掉）
        d = yo * 0.012
    q = yo.rotation_difference(d.normalized())
    M = (q.to_matrix() @ m.to_3x3()).to_4x4()
    M.translation = hn
    e = eb[n]
    e.use_connect = False
    e.matrix = M
    e.length = d.length
    placed[n] = (hn, hn + d, d.length / max((t - h).length, 1e-6))
bpy.ops.object.mode_set(mode="OBJECT")
print(f"關節搬移完成；外部骨架沒有的骨頭：{missing}")

# ════════ 網格掛到新骨架（權重沿用） ════════
for mod in list(body.modifiers):
    body.modifiers.remove(mod)
body.parent = new_arm
body.matrix_parent_inverse = new_arm.matrix_world.inverted()
am = body.modifiers.new("Armature", "ARMATURE")
am.object = new_arm
unw = sum(1 for v in body.data.vertices if sum(g.weight for g in v.groups) < 1e-4)
names = {g.name for g in body.vertex_groups}
print(f"權重：群組 {len(names)}　沒有權重的頂點 {unw}　骨架裡找不到的群組 {sorted(names - set(old_rest))}")

# ════════ 臀部權重修正 ════════
# 自動綁定常把臀部算給大腿骨：深蹲時大腿往前轉九十度，屁股跟著被捲進去、腰帶陷下去。
# 真人的臀部長在骨盆上：髖關節高度附近以上、身體後側的皮膚，把大腿的權重移回骨盆；
# 前側留到鼠蹊以上才移，髖才折得起來
def sstep(a, b, x):
    t = min(1.0, max(0.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


if os.environ.get("BUTT_FIX", "1") == "1":
    zj = (placed[P_ + "LeftUpLeg"][0].z + placed[P_ + "RightUpLeg"][0].z) / 2  # 髖關節高度
    yc = placed[P_ + "Hips"][0].y
    g_hips = body.vertex_groups[P_ + "Hips"]
    g_legs = [body.vertex_groups[P_ + w + "UpLeg"].index for w in ("Left", "Right") if P_ + w + "UpLeg" in body.vertex_groups]
    moved = 0
    for v in body.data.vertices:
        z, y = v.co.z, v.co.y - yc
        if z < zj - 0.12 or z > zj + 0.35:
            continue
        back = sstep(-0.02, 0.05, y)
        take = back * sstep(zj - 0.1, zj + 0.03, z) + (1 - back) * sstep(zj + 0.03, zj + 0.13, z)
        if take <= 0:
            continue
        add = 0.0
        for g in v.groups:
            if g.group in g_legs and g.weight > 0:
                d = g.weight * take
                g.weight -= d
                add += d
        if add > 0:
            g_hips.add([v.index], add, "ADD")
            moved += 1
    print(f"臀部權重修正：{moved} 個頂點（髖關節高度 {zj:.3f}）")

# ════════ 動作：複製世界旋轉 ════════
ks = placed[P_ + "Hips"][0].z / old_rest[P_ + "Hips"][1].z
old_arm.scale = (ks, ks, ks)
for pb in new_arm.pose.bones:
    c = pb.constraints.new("COPY_ROTATION")
    c.target = old_arm
    c.subtarget = pb.name
    if pb.parent is None:
        c2 = pb.constraints.new("COPY_LOCATION")
        c2.target = old_arm
        c2.subtarget = pb.name
only(new_arm)
new_acts = []
for act in old_acts:
    old_arm.animation_data.action = act
    if hasattr(act, "slots") and len(act.slots):
        old_arm.animation_data.action_slot = act.slots[0]
    f0, f1 = (int(x) for x in act.frame_range)
    bpy.ops.object.mode_set(mode="POSE")
    bpy.ops.pose.select_all(action="SELECT")
    bpy.ops.nla.bake(frame_start=f0, frame_end=f1, only_selected=True, visual_keying=True,
                     clear_constraints=False, use_current_action=False, bake_types={"POSE"})
    bpy.ops.object.mode_set(mode="OBJECT")
    baked = new_arm.animation_data.action
    name = act.name
    act.name = name + "_old"
    baked.name = name
    baked.use_fake_user = True
    new_acts.append(baked)
    new_arm.animation_data.action = None
for pb in new_arm.pose.bones:
    for c in list(pb.constraints):
        pb.constraints.remove(c)
ad = new_arm.animation_data or new_arm.animation_data_create()
for a in new_acts:
    tr = ad.nla_tracks.new()
    tr.name = a.name
    tr.strips.new(a.name, int(a.frame_range[0]), a)
    tr.mute = True
ad.action = None
print(f"烘焙動作 {len(new_acts)} 個")

# ════════ 匯出 ════════
bpy.data.objects.remove(old_arm)
bpy.data.objects.remove(src_arm)
for a in list(bpy.data.actions):
    if a.name.endswith("_old"):
        bpy.data.actions.remove(a)
body.name = "output_unwrapped"
only(body, new_arm)
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_animations=True,
                          export_animation_mode="NLA_TRACKS", export_image_format="JPEG", export_image_quality=95)
print("已匯出:", OUT, os.path.getsize(OUT), "bytes")
