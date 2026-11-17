"""把守備員的 Meshy 骨架（Mixamo 命名）套到新的 Meshy 模型上：量出新身體的關節位置、搬骨頭、算權重、把動作重新烘焙過來。

輸出的 GLB 結構和 meshy_rigged_anims.glb 相同（同樣的骨頭名稱與動作名稱），可以直接交給 rig_v7.py。

做法：
  1. 兩個身體各自量出地標：胯下高度、腋下高度、頭頂、手臂軸線、指尖、腳掌範圍、軀幹與腿的切片中心
  2. 舊骨架每個關節依所屬部位，換算到新身體上對應的位置
  3. 每根骨頭保留原本的軸向，只做最小旋轉對到新方向（手臂張開角度不同時才會轉）
  4. 自動權重（網格必須是封閉的一整塊，熱傳權重才算得出來）
  5. 動作：新骨頭每格複製舊骨頭的世界旋轉，骨盆位置按身高等比例

執行：
  /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python fit_rig_batter.py -- <舊的已綁定.glb> <新身體.glb> <輸出.glb> [檢查圖資料夾]
"""
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index("--") + 1:]
OLD, NEW, OUT = argv[0], argv[1], argv[2]
CHECK = argv[3] if len(argv) > 3 else None
P_ = "mixamorig:"

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = 30

# ════════ 匯入 ════════
bpy.ops.import_scene.gltf(filepath=OLD)
old_arm = next(o for o in scene.objects if o.type == "ARMATURE")
old_body = next(o for o in scene.objects if o.type == "MESH" and o.parent is old_arm)
for o in list(scene.objects):
    if o not in (old_arm, old_body):
        bpy.data.objects.remove(o)
old_acts = [a for a in bpy.data.actions]
before = set(scene.objects)
bpy.ops.import_scene.gltf(filepath=NEW)
new_body = next(o for o in scene.objects if o not in before and o.type == "MESH")
for o in [o for o in scene.objects if o not in before and o is not new_body]:
    bpy.data.objects.remove(o)
new_body.parent = None
new_body.matrix_world = Matrix.Identity(4)
# glTF 匯入的網格在每條貼圖接縫上點是分開的兩份。不先合併的話，自動權重會把每一塊各自計算，
# 接縫兩邊權重不同，一擺姿勢衣服就沿著接縫撕開。貼圖座標存在面的角上，合併點不影響貼圖
import bmesh  # noqa: E402
bm = bmesh.new()
bm.from_mesh(new_body.data)
n0 = len(bm.verts)
bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
bm.to_mesh(new_body.data)
bm.free()
print(f"合併接縫：頂點 {n0} → {len(new_body.data.vertices)}")


def verts(ob):
    m = ob.matrix_world
    return np.array([(m @ v.co)[:] for v in ob.data.vertices])


PO, PN = verts(old_body), verts(new_body)


# ════════ 地標 ════════
def band(P, z, w=0.012):
    return P[np.abs(P[:, 2] - z) < w]


def clusters(xs, gap=0.03):
    xs = np.sort(xs)
    if len(xs) == 0:
        return []
    cuts = np.where(np.diff(xs) > gap)[0]
    return np.split(xs, cuts + 1)


def landmarks(P, arm_min_x):
    L = {"top": P[:, 2].max()}
    # 胯下：由下往上，第一個在 x≈0 有點的高度（以下兩腿分開）
    for z in np.arange(0.5, 1.1, 0.004):
        b = band(P, z, 0.006)
        if np.sum((np.abs(b[:, 0]) < 0.02) & (np.abs(b[:, 1]) < 0.15)) >= 2:
            L["crotch"] = z
            break
    for s, tag in ((1, "L"), (-1, "R")):
        # 手臂：A 字站姿時 |x| 夠大、又在胯下以上的點只會是手臂
        A = P[(P[:, 0] * s > arm_min_x) & (P[:, 2] > L["crotch"] - 0.05)]
        L["tip" + tag] = A[np.argmin(A[:, 2])]  # 指尖＝手臂最低點
        up = A[A[:, 2] > L["tip" + tag][2] + 0.2]  # 不含手掌
        c = up.mean(0)
        d = np.linalg.svd(up - c)[2][0]
        L["axis" + tag] = (c, d if d[2] < 0 else -d)
        # 腳：腳踝以下的範圍
        F = P[(P[:, 2] < 0.2) & (P[:, 0] * s > 0.03)]
        L["foot" + tag] = (F.min(0), F.max(0))
    return L


LO, LN = landmarks(PO, 0.27), landmarks(PN, 0.30)
for k in ("top", "crotch"):
    print(f"{k:8s} 舊 {LO[k]:.3f}  新 {LN[k]:.3f}")
for t in "LR":
    print(f"指尖{t} 舊 {np.round(LO['tip' + t], 3)}  新 {np.round(LN['tip' + t], 3)}")


def map_z(z):
    """高度分兩段等比例對應：地面～胯下～頭頂。"""
    ko = [0, LO["crotch"], LO["top"]]
    kn = [0, LN["crotch"], LN["top"]]
    return float(np.interp(z, ko, kn)) if z <= ko[-1] else kn[-1] + (z - ko[-1]) * (kn[-1] - kn[-2]) / (ko[-1] - ko[-2])


def core(P, z, side, w=0.015):
    """某高度的核心切片中心：side=0 取身體中線附近（|x|<0.15），±1 取那一邊的腿（避開手）。"""
    b = band(P, z, w)
    if side == 0:
        b = b[np.abs(b[:, 0]) < 0.15]
    else:
        b = b[(b[:, 0] * side > 0.0) & (b[:, 0] * side < 0.26)]
    return b.mean(0)


def hip_width(P, L):
    b = band(P, L["crotch"] + 0.05, 0.01)
    b = b[np.abs(b[:, 0]) < 0.26]
    return np.ptp(b[:, 0])


KX = hip_width(PN, LN) / hip_width(PO, LO)
print(f"骨盆寬比例 {KX:.3f}")


def map_body(p, side):
    """軀幹或腿上的點：高度分段對應；左右用骨盆寬比例（腿則對齊腿的中心），前後對齊核心切片中心。"""
    zo = p[2]
    zn = map_z(zo)
    zo_c, zn_c = min(zo, LO["top"] - 0.03), min(zn, LN["top"] - 0.03)
    co, cn = core(PO, zo_c, side), core(PN, zn_c, side)
    x = p[0] * KX if side == 0 else cn[0] + (p[0] - co[0])
    return np.array([x, cn[1] + (p[1] - co[1]), zn])


def arm_ends(t):
    """肩關節到指尖。舊的肩關節直接用舊骨頭；新的取手臂軸線上、高度對應過去的那一點。"""
    w = "Left" if t == "L" else "Right"
    so = Vector(old_arm.data.bones[P_ + w + "Arm"].head_local)
    c, d = LN["axis" + t]
    zs = map_z(so.z)
    sn = Vector(c + d * (zs - c[2]) / d[2])
    return so, Vector(LO["tip" + t]), sn, Vector(LN["tip" + t])


def frame(s, f, t):
    d = (f - s).normalized()
    side = Vector((1 if t == "L" else -1, 0, 0))
    fwd = d.cross(side).normalized()
    return d, fwd.cross(d).normalized(), fwd


def map_arm(p, t):
    """手臂與手指：肩到指尖的比例位置＋垂直方向的偏移（依手臂長度等比例）。"""
    so, fo, sn, fn = arm_ends(t)
    do, xo, yo = frame(so, fo, t)
    dn, xn, yn = frame(sn, fn, t)
    k = (fn - sn).length / (fo - so).length
    v = Vector(p) - so
    return np.array(sn + (dn * v.dot(do) + xn * v.dot(xo) + yn * v.dot(yo)) * k)


def map_foot(p, t):
    (a0, a1), (b0, b1) = LO["foot" + t], LN["foot" + t]
    return b0 + (np.array(p) - a0) / (a1 - a0) * (b1 - b0)


def part(name):
    n = name.replace(P_, "")
    for t, w in (("L", "Left"), ("R", "Right")):
        if n.startswith(w + "Hand") or n in (w + "ForeArm", w + "Arm"):
            return "arm", t
        if n in (w + "Foot", w + "ToeBase", w + "Toe_End"):
            return "foot", t
        if n in (w + "UpLeg", w + "Leg"):
            return "leg", t
    return "body", None


def map_point(p, name, is_tail):
    kind, t = part(name)
    if kind == "arm":
        return map_arm(p, t)
    if kind == "foot":
        return map_foot(p, t)
    if kind == "leg":
        # 大腿根部在胯下以上，用軀幹的切片；以下用腿的切片
        return map_body(p, 0 if p[2] > LO["crotch"] - 0.01 else (1 if t == "L" else -1))
    return map_body(p, 0)


# ════════ 搬骨頭 ════════
old_rest = {b.name: (b.matrix_local.copy(), b.head_local.copy(), b.tail_local.copy()) for b in old_arm.data.bones}
new_arm = old_arm.copy()
new_arm.data = old_arm.data.copy()
new_arm.animation_data_clear()
new_arm.name = "SmartRigArmature"
old_arm.name = "OldArmature"
scene.collection.objects.link(new_arm)
for o in scene.objects:
    o.select_set(o is new_arm)
bpy.context.view_layer.objects.active = new_arm
bpy.ops.object.mode_set(mode="EDIT")
eb = new_arm.data.edit_bones
heads = {n: map_point(np.array(h), n, False) for n, (_, h, _t) in old_rest.items()}
tails = {}
for n, (_, h, t) in old_rest.items():
    kids = [c for c in eb[n].children if c.use_connect]
    tails[n] = heads[kids[0].name] if kids else map_point(np.array(t), n, True)
# ════════ 主要關節：直接在新身體上量＋真人比例（守備員是 Q 版比例，照比例換算會把腳踝、膝蓋、肩膀放錯高度） ════════
# 身高 1.903（含頭盔約 3 cm、鞋底約 2.5 cm）。實測：褲襠 0.89、肩頂 1.59、鞋口約 0.12
def leg_center(z, s):
    b = band(PN, z, 0.008)
    b = b[(b[:, 0] * s > 0.01) & (b[:, 0] * s < 0.3)]
    return b.mean(0)


def setb(n, h, t):
    heads[P_ + n], tails[P_ + n] = np.array(h, float), np.array(t, float)


setb("Hips", (0, 0.01, 0.99), (0, 0.01, 1.08))
setb("Spine", (0, 0.03, 1.08), (0, 0.035, 1.24))
setb("Spine1", (0, 0.035, 1.24), (0, 0.04, 1.40))
setb("Spine2", (0, 0.04, 1.40), (0, 0.04, 1.48))
setb("Neck", (0, 0.03, 1.53), (0, 0.015, 1.66))
setb("Head", (0, 0.015, 1.66), (0, 0.01, 1.80))
setb("HeadTop_End", (0, 0.01, 1.88), (0, 0.01, 2.0))
heads["headfront"], tails["headfront"] = np.array((0, -0.13, 1.66)), np.array((0, -0.13, 1.80))
for s, w, t in ((1, "Left", "L"), (-1, "Right", "R")):
    c55, c14 = leg_center(0.55, s), leg_center(0.14, s)
    hip = (0.105 * s, 0.0, 0.95)
    knee = (c55[0], c55[1], 0.55)  # 膝：0.285×身高＋鞋底
    ankle = (c14[0], 0.05, 0.09)  # 腳踝：鞋口下方、偏腳跟
    ball = (c14[0] + 0.01 * s, -0.07, 0.035)  # 前腳掌：腳長的 70%
    toe = (c14[0] + 0.012 * s, -0.155, 0.03)
    setb(w + "UpLeg", hip, knee)
    setb(w + "Leg", knee, ankle)
    setb(w + "Foot", ankle, ball)
    setb(w + "ToeBase", ball, toe)
    setb(w + "Toe_End", toe, (toe[0], toe[1] - 0.03, toe[2]))
    # 手臂：肩關節在手臂軸線上 z=1.50 處；肘、腕依真人上臂：前臂：手 ＝ 0.186：0.146：0.108
    c, d = LN["axis" + t]
    S = c + d * (1.50 - c[2]) / d[2]
    S = np.array((0.22 * s, 0.02, 1.50))  # 軸線外插會偏到背後；肩關節固定在肩頂（1.59）下方、身體前後中線
    F = np.array(LN["tip" + t])
    E, Wr = S + (F - S) * 0.423, S + (F - S) * 0.755
    print(f"{w} 肩 {S.round(3)} 肘 {E.round(3)} 腕 {Wr.round(3)} 指尖 {F.round(3)}  膝 {np.round(knee, 3)} 踝 {np.round(ankle, 3)}")
    setb(w + "Shoulder", (0.03 * s, 0.04, 1.48), S)
    setb(w + "Arm", S, E)
    setb(w + "ForeArm", E, Wr)
    # 手掌與手指：舊的「腕→指尖」座標系對到新的，依手長等比例
    wo = Vector(old_rest[P_ + w + "Hand"][1])
    fo = Vector(LO["tip" + t])
    wn, fn = Vector(Wr), Vector(F)
    do, xo, yo = frame(wo, fo, t)
    dn, xn, yn = frame(wn, fn, t)
    kh = (fn - wn).length / (fo - wo).length
    for n, (_, h, tl) in old_rest.items():
        if n.startswith(P_ + w + "Hand"):
            for src, dst in ((h, heads), (tl, tails)):
                v = Vector(src) - wo
                dst[n] = np.array(wn + (dn * v.dot(do) + xn * v.dot(xo) + yn * v.dot(yo)) * kh)
    heads[P_ + w + "Hand"] = np.array(Wr)
for n, (m, h, t) in old_rest.items():
    e = eb[n]
    hn, tn = Vector(heads[n]), Vector(tails[n])
    yo = (t - h).normalized()
    yn = (tn - hn).normalized()
    q = yo.rotation_difference(yn)
    m3 = (q.to_matrix() @ m.to_3x3()).to_4x4()
    m3.translation = hn
    e.use_connect = False
    e.matrix = m3
    e.length = (tn - hn).length
for n in old_rest:
    if old_arm.data.bones[n].use_connect:
        eb[n].use_connect = True
bpy.ops.object.mode_set(mode="OBJECT")
for n in ("Hips", "LeftArm", "LeftForeArm", "LeftHand", "LeftUpLeg", "LeftLeg", "LeftFoot", "Neck", "Head"):
    b = new_arm.data.bones[P_ + n]
    print(f"{n:12s} 頭 {np.round(b.head_local[:], 3)}  尾 {np.round(b.tail_local[:], 3)}")


# ════════ 檢查圖：骨頭畫在身體上（正面、側面） ════════
def save_overlay():
    if not CHECK:
        return
    os.makedirs(CHECK, exist_ok=True)
    lines = [(np.array(b.head_local[:]), np.array(b.tail_local[:])) for b in new_arm.data.bones]
    np.save(os.path.join(CHECK, "bones.npy"), np.array(lines))
    idx = np.random.default_rng(0).choice(len(PN), min(len(PN), 12000), replace=False)
    np.save(os.path.join(CHECK, "body.npy"), PN[idx])


save_overlay()

# ════════ 權重 ════════
new_body.parent = None
for o in scene.objects:
    o.select_set(o in (new_body, new_arm))
bpy.context.view_layer.objects.active = new_arm
bpy.ops.object.parent_set(type="ARMATURE_AUTO")
nz = np.zeros(len(new_body.data.vertices))
for v in new_body.data.vertices:
    nz[v.index] = sum(g.weight for g in v.groups)
print(f"權重：頂點 {len(nz)}  沒有任何權重的頂點 {int(np.sum(nz < 1e-4))}")
bad = np.where(nz < 1e-4)[0]
if len(bad) > len(nz) * 0.01:
    print("自動權重失敗（太多頂點沒權重），停止")
    sys.exit(1)
if len(bad):
    # 少數沒算到的點（通常是很窄的縫裡）：照抄最近一個有權重的點
    from mathutils.kdtree import KDTree
    good = np.where(nz >= 1e-4)[0]
    kd = KDTree(len(good))
    for i, gi in enumerate(good):
        kd.insert(new_body.data.vertices[gi].co, i)
    kd.balance()
    for vi in bad:
        _, i, _ = kd.find(new_body.data.vertices[vi].co)
        src = new_body.data.vertices[good[i]]
        for g in src.groups:
            new_body.vertex_groups[g.group].add([int(vi)], g.weight, "REPLACE")
    print(f"補上 {len(bad)} 個沒權重的頂點")

# ════════ 臀部權重修正 ════════
# 自動權重把臀部算給大腿骨：大腿往前抬，屁股就跟著被拉扁。真人的臀部長在骨盆上，
# 所以臀線（約 0.86）以上、身體後側的皮膚，把大腿的權重移回骨盆；前側留到鼠蹊（約 0.93）以上才移，髖才折得起來
def sstep(a, b, x):
    t = min(1.0, max(0.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


g_hips = new_body.vertex_groups[P_ + "Hips"]
g_legs = [new_body.vertex_groups[P_ + w + "UpLeg"].index for w in ("Left", "Right")]
moved = 0
for v in new_body.data.vertices:
    z, y = v.co.z, v.co.y
    if z < 0.84 or z > 1.2:
        continue
    back = sstep(-0.03, 0.06, y)
    take = back * sstep(0.86, 0.98, z) + (1 - back) * sstep(0.93, 1.05, z)
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
print(f"臀部權重修正：{moved} 個頂點")

# ════════ 動作：複製世界旋轉 ════════
k = heads[P_ + "Hips"][2] / old_rest[P_ + "Hips"][1].z  # 骨盆位移依骨盆高度等比例（腿長不同，用身高比例腳會陷進地面）
old_arm.scale = (k, k, k)
for pb in new_arm.pose.bones:
    c = pb.constraints.new("COPY_ROTATION")
    c.target = old_arm
    c.subtarget = pb.name
    if pb.parent is None:
        c2 = pb.constraints.new("COPY_LOCATION")
        c2.target = old_arm
        c2.subtarget = pb.name
for o in scene.objects:
    o.select_set(o is new_arm)
bpy.context.view_layer.objects.active = new_arm
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
    print(f"烘焙動作 {name}  {f0}～{f1}")
for pb in new_arm.pose.bones:
    for c in list(pb.constraints):
        pb.constraints.remove(c)

# 每個動作放進 NLA，匯出時才會全部帶出去
ad = new_arm.animation_data or new_arm.animation_data_create()
for a in new_acts:
    tr = ad.nla_tracks.new()
    tr.name = a.name
    tr.strips.new(a.name, int(a.frame_range[0]), a)
    tr.mute = True
ad.action = None

# ════════ 匯出 ════════
bpy.data.objects.remove(old_body)
bpy.data.objects.remove(old_arm)
for a in list(bpy.data.actions):
    if a.name.endswith("_old"):
        bpy.data.actions.remove(a)
new_body.name = "output_unwrapped"
for o in scene.objects:
    o.select_set(o in (new_body, new_arm))
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_animations=True,
                          export_animation_mode="NLA_TRACKS", export_image_format="JPEG", export_image_quality=95)
print("已匯出:", OUT, os.path.getsize(OUT), "bytes")
