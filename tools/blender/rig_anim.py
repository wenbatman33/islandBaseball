"""替匯出後的球員模型加上骨架、球棒、球，並製作動作（待機、揮棒、投球），匯出成帶動作的 GLB。

執行：
  /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python rig_anim.py -- <輸入.glb> <rig.json> <輸出.glb> [姿勢預覽資料夾]

座標：角色面向 -Y，+X 是角色的左手邊，+Z 朝上。
姿勢角度（度）是「繞骨架座標軸」的旋轉，並跟著父骨頭一起轉：
  X 負值＝手腳往前擺；Y：左側肢體負值往外張、右側正值往外張；Z 正值＝往角色的左邊轉。
"""
import json
import math
import os
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Euler, Matrix, Vector

argv = sys.argv[sys.argv.index("--") + 1:]
SRC, RIG_JSON, OUT = argv[0], argv[1], argv[2]
PREVIEW = argv[3] if len(argv) > 3 else None
FPS = 30

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = FPS
bpy.ops.import_scene.gltf(filepath=SRC)
player = bpy.data.objects["player"]
cap = bpy.data.objects.get("cap")
R = json.load(open(RIG_JSON))

# ════════ 骨架 ════════
yT, yH, cz, neck = R["y_torso"], R["y_head"], R["crotch_z"], R["neck_z"]
lx = R["leg_x"]
J = {}  # 名稱 → (頭, 尾, 父)
J["hips"] = ((0, yT, cz + 0.05), (0, yT, cz + 0.15), None)
J["spine"] = ((0, yT, cz + 0.15), (0, yT, 0.80), "hips")
J["chest"] = ((0, yT, 0.80), (0, yT, neck - 0.03), "spine")
J["head"] = ((0, (yT + yH) / 2, neck), (0, yH, neck + 0.5), "chest")
ARM = {}
for key, h in R["hands"].items():
    W, d, L = Vector(h["p"]), Vector(h["d"]), h["L"] * 0.86
    s = "L" if W.x > 0 else "R"
    S = W - d * ((0.93 - W.z) / -d.z)  # 沿手臂方向往上推回肩膀的高度
    E = S + (W - S) * 0.64  # 手肘放在短袖下緣以下，袖口才會整圈跟著上臂、不會被摺亂
    palm = W + d * 0.3 * L
    ARM[s] = dict(S=S, E=E, W=W, tip=W + d * L, palm=palm, d=d)
    J["upperarm." + s] = (tuple(S), tuple(E), "chest")
    J["forearm." + s] = (tuple(E), tuple(W), "upperarm." + s)
    J["hand." + s] = (tuple(W), tuple(W + d * 0.5 * L), "forearm." + s)
    J["fingers." + s] = (tuple(W + d * 0.52 * L), tuple(W + d * L), "hand." + s)
    ARM[s]["L"] = L
for s, sx in (("L", lx), ("R", -lx)):
    J["thigh." + s] = ((sx, yT, cz + 0.03), (sx, yT, 0.29), "hips")
    J["shin." + s] = ((sx, yT, 0.29), (sx, yT, 0.10), "thigh." + s)
    J["foot." + s] = ((sx, yT, 0.10), (sx, yT - 0.13, 0.03), "shin." + s)
pr = ARM["R"]["palm"]
J["bat"] = (tuple(pr), tuple(pr + Vector((0, -0.12, 0))), None)
J["ball"] = (tuple(pr + Vector((0, -0.045, 0))), tuple(pr + Vector((0, -0.09, 0))), "hand.R")

arm_data = bpy.data.armatures.new("rig")
arm = bpy.data.objects.new("rig", arm_data)
scene.collection.objects.link(arm)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode="EDIT")
for name, (h, t, parent) in J.items():
    b = arm_data.edit_bones.new(name)
    b.head, b.tail = Vector(h), Vector(t)
    if parent:
        b.parent = arm_data.edit_bones[parent]
bpy.ops.object.mode_set(mode="OBJECT")

# ════════ 球棒與球 ════════
def solid_material(name, rgb):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bs = m.node_tree.nodes["Principled BSDF"]
    bs.inputs["Base Color"].default_value = (*rgb, 1)
    bs.inputs["Roughness"].default_value = 0.7
    return m


BAT_LEN = 1.12  # 握把以上的長度。Q 版比例：球棒誇張化，長度接近角色肩高、棒頭和手臂差不多粗
# (沿球棒方向的位置, 半徑)：握把底的圓頭 → 握把 → 漸粗 → 棒頭
prof = [(-0.08, 0.001), (-0.078, 0.042), (-0.055, 0.042), (-0.04, 0.025), (BAT_LEN * 0.22, 0.025), (BAT_LEN * 0.45, 0.036),
        (BAT_LEN * 0.68, 0.058), (BAT_LEN * 0.9, 0.066), (BAT_LEN * 0.975, 0.058), (BAT_LEN, 0.001)]
bm = bmesh.new()
rings = []
for (t, r) in prof:
    rings.append([bm.verts.new(pr + Vector((r * math.cos(a), -t, r * math.sin(a)))) for a in (2 * math.pi * i / 16 for i in range(16))])
for a, b in zip(rings, rings[1:]):
    for i in range(16):
        j = (i + 1) % 16
        bm.faces.new([a[i], b[i], b[j], a[j]])
bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
me = bpy.data.meshes.new("bat")
bm.to_mesh(me)
bm.free()
for p in me.polygons:
    p.use_smooth = True
bat = bpy.data.objects.new("bat_mesh", me)  # 不可和骨頭同名，否則載入後會被改名
scene.collection.objects.link(bat)
bat.data.materials.append(solid_material("bat_wood", (0.5, 0.3, 0.13)))

bm = bmesh.new()
bmesh.ops.create_uvsphere(bm, u_segments=16, v_segments=10, radius=0.034)
for v in bm.verts:
    v.co += Vector(J["ball"][0])
me = bpy.data.meshes.new("ball")
bm.to_mesh(me)
bm.free()
for p in me.polygons:
    p.use_smooth = True
ball = bpy.data.objects.new("ball_mesh", me)
scene.collection.objects.link(ball)
ball.data.materials.append(solid_material("ball_white", (0.9, 0.88, 0.82)))

# ════════ 綁定：依頂點到各骨頭的距離給權重 ════════
def seg_dist(P, a, b):
    a, b = np.array(a), np.array(b)
    ab = b - a
    t = np.clip(((P - a) @ ab) / (ab @ ab), 0, 1)
    return np.linalg.norm(P - (a + t[:, None] * ab), axis=1)


def gauss(d, sigma):
    return np.exp(-(d / sigma) ** 2)


names = list(J.keys())
P = np.array([player.matrix_world @ v.co for v in player.data.vertices])
n = len(P)
Wt = {k: np.zeros(n) for k in names}
x, z = P[:, 0], P[:, 2]
head_m = z > neck + 0.02
# 手臂：靠近「肩—肘—腕—指尖」折線的頂點
arm_m = np.zeros(n, dtype=bool)
arm_side = np.zeros(n, dtype=int)
for s, A in ARM.items():
    d_arm = np.minimum.reduce([seg_dist(P, A["S"], A["E"]), seg_dist(P, A["E"], A["W"]), seg_dist(P, A["W"], A["tip"])])
    sign = 1 if s == "L" else -1
    d_hand = seg_dist(P, A["W"], A["tip"])
    # 腋下以下手臂和身體是分開的，範圍可以放寬（袖子很胖）；手的範圍再大一點，拇指才不會被漏掉
    m = (x * sign > 0) & ~head_m & (
        (z < 0.8) & (np.abs(x) > np.abs(A["W"][0] - A["d"][0] / A["d"][2] * (z - A["W"][2])) - 0.055) & (np.abs(x) > 0.2) & (d_arm < 0.1)
        | (z >= 0.8) & (np.abs(x) > 0.15) & (d_arm < 0.085)
        | (np.abs(x) > 0.2) & (d_hand < 0.14))
    arm_m |= m
    arm_side[m] = sign
leg_m = (z < cz - 0.01) & ~arm_m
torso_m = ~head_m & ~arm_m & ~leg_m

Wt["head"][head_m] = 1.0
for s, sign in (("L", 1), ("R", -1)):
    m = arm_m & (arm_side == sign)
    A = ARM[s]
    Wt["upperarm." + s][m] = gauss(seg_dist(P[m], A["S"], A["E"]), 0.05)
    Wt["forearm." + s][m] = gauss(seg_dist(P[m], A["E"], A["W"]), 0.045)
    Wt["hand." + s][m] = gauss(seg_dist(P[m], A["W"], A["tip"]), 0.04) * 1.5
    # 肩膀：沿著上臂方向，從肩關節往內 4 公分到往外 9 公分之間，由胸口漸層交給手臂（腋下才不會被硬扯）
    ua = np.array(A["E"]) - np.array(A["S"])
    ua_len = np.linalg.norm(ua)
    along_u = (P[m] - np.array(A["S"])) @ (ua / ua_len)
    sh = np.clip((along_u + 0.04) / 0.2, 0, 1)  # 漸層一路延伸到腋下
    sh = sh * sh * (3 - 2 * sh)
    for k in ("upperarm." + s, "forearm." + s, "hand." + s):
        Wt[k][m] *= sh
    tot_arm = Wt["upperarm." + s][m] + Wt["forearm." + s][m] + Wt["hand." + s][m]
    Wt["chest"][m] = np.maximum(tot_arm, 1e-6) * (1 - sh) / np.maximum(sh, 1e-3) + (sh < 1e-3) * 1.0
    hand_only = m & (z < A["W"][2] - 0.01)
    for k in ("upperarm." + s, "forearm." + s, "chest"):
        Wt[k][hand_only] = 0
    Wt["hand." + s][hand_only] = 1
    # 四指：沿手的方向超過指根的部分，在指根附近和手掌漸層過渡（拇指比較靠近手腕，不會被算進來）
    along = (P - np.array(A["W"])) @ np.array(A["d"]) / A["L"]
    fm = m & (along > 0.5)
    f_w = np.clip((along[fm] - 0.5) / 0.12, 0, 1)
    Wt["fingers." + s][fm] = f_w
    Wt["hand." + s][fm] = 1 - f_w
    m = leg_m & (x * sign > 0)
    for k, sg in (("thigh." + s, 0.07), ("shin." + s, 0.06), ("foot." + s, 0.05)):
        Wt[k][m] = gauss(seg_dist(P[m], J[k][0], J[k][1]), sg)
    Wt["foot." + s][m & (z < 0.09)] += 2.0
    # 軀幹下緣靠近大腿根部的地方帶一點大腿的權重
    m = torso_m & (x * sign > 0) & (z < cz + 0.08)
    Wt["thigh." + s][m] = gauss(seg_dist(P[m], J["thigh." + s][0], J["thigh." + s][1]), 0.06) * 0.6
for k, sg in (("hips", 0.1), ("spine", 0.1), ("chest", 0.1)):
    Wt[k][torso_m] = gauss(seg_dist(P[torso_m], J[k][0], J[k][1]), sg)
# 腋下附近的身體側面帶一部分上臂的權重，手臂抬起時衣服才會跟著被帶動而不是撕開
_tsum = Wt["hips"] + Wt["spine"] + Wt["chest"]
for s, sign in (("L", 1), ("R", -1)):
    A = ARM[s]
    m = torso_m & (x * sign > 0) & (z > 0.68)
    d_u = seg_dist(P[m], A["S"], A["E"])
    wa = np.clip((0.13 - d_u) / 0.07, 0, 1) * 0.55
    for k in ("hips", "spine", "chest"):
        Wt[k][m] *= (1 - wa)
    Wt["upperarm." + s][m] = wa * np.maximum(_tsum[m], 1e-6)
    Wt[k][leg_m] += gauss(seg_dist(P[leg_m], J[k][0], J[k][1]), 0.05) * (0.5 if k == "hips" else 0)
# 脖子附近在胸和頭之間過渡
nk = ~arm_m & (z > neck - 0.03) & (z <= neck + 0.02)
tt = (z[nk] - (neck - 0.03)) / 0.05
for k in names:
    Wt[k][nk] *= (1 - tt)
Wt["head"][nk] += tt

M = np.stack([Wt[k] for k in names], axis=1)
tot = M.sum(axis=1)
bad = tot < 1e-6
M[bad, names.index("chest")] = 1
M /= M.sum(axis=1, keepdims=True)
# 權重沿著網格平滑幾次：手臂和身體的交界（袖口、肩膀）才不會一邊動一邊不動而撕開。
# 匯入的模型在貼圖接縫處頂點是分開的，必須把同一個位置的頂點當成同一點來算，否則接縫兩邊會裂開。
_, gid = np.unique(np.round(P / 2e-5).astype(np.int64), axis=0, return_inverse=True)
gid = gid.ravel()
ng = gid.max() + 1
cnt = np.bincount(gid, minlength=ng).astype(float)[:, None]
G = np.zeros((ng, M.shape[1]))
np.add.at(G, gid, M)
G /= cnt
ed = gid[np.array([e.vertices[:] for e in player.data.edges])]
ed = np.unique(np.sort(ed[ed[:, 0] != ed[:, 1]], axis=1), axis=0)
deg = np.bincount(ed.ravel(), minlength=ng).astype(float)[:, None]
keep = np.zeros(ng, dtype=bool)
keep[gid[head_m & (z > neck + 0.06)]] = True  # 頭維持整塊跟著頭骨
for _ in range(6):
    acc = np.zeros_like(G)
    np.add.at(acc, ed[:, 0], G[ed[:, 1]])
    np.add.at(acc, ed[:, 1], G[ed[:, 0]])
    Gs = 0.5 * G + 0.5 * acc / np.maximum(deg, 1)
    Gs[keep] = G[keep]
    G = Gs
M = G[gid]
M /= M.sum(axis=1, keepdims=True)
groups = {k: player.vertex_groups.new(name=k) for k in names}
for bi, k in enumerate(names):
    idx = np.where(M[:, bi] > 0.01)[0]
    for i in idx:
        groups[k].add([int(i)], float(M[i, bi]), "REPLACE")
print(f"綁定：頭 {head_m.sum()} 手臂 {arm_m.sum()} 腿 {leg_m.sum()} 軀幹 {torso_m.sum()} 頂點；沒有權重 {bad.sum()}")


def bind_rigid(ob, bone):
    g = ob.vertex_groups.new(name=bone)
    g.add(list(range(len(ob.data.vertices))), 1.0, "REPLACE")


if cap:
    bind_rigid(cap, "head")
bind_rigid(bat, "bat")
bind_rigid(ball, "ball")
MESHES = [o for o in (player, cap, bat, ball) if o]
for ob in MESHES:
    ob.parent = arm
    mod = ob.modifiers.new("rig", "ARMATURE")
    mod.object = arm

# ════════ 動作 ════════
REST = {b.name: b.matrix_local.to_3x3() for b in arm_data.bones}
for pb in arm.pose.bones:
    pb.rotation_mode = "QUATERNION"
arm.animation_data_create()


def aim(rest_name, direction, twist=0.0, carry=None):
    """讓骨頭的軸指向 direction（骨架座標）。carry＝父骨頭目前帶動的旋轉：
    從「跟著父骨頭轉過之後的靜止方向」用最短的旋轉轉過去，這樣只有擺動、不會多出扭轉（否則袖子會像擰毛巾）。"""
    B = (carry @ REST[rest_name]) if carry is not None else REST[rest_name]
    q = (B @ Vector((0, 1, 0))).rotation_difference(direction.normalized())
    M3 = q.to_matrix() @ B
    if twist:
        M3 = Matrix.Rotation(math.radians(twist), 3, direction.normalized()) @ M3
    return M3


def set_world(pb, head, M3):
    pb.matrix = Matrix.Translation(head) @ M3.to_4x4()
    bpy.context.view_layer.update()


CHEST_HEAD = Vector(J["chest"][0])
L1 = {s: (ARM[s]["E"] - ARM[s]["S"]).length for s in ARM}
L2 = {s: (ARM[s]["W"] - ARM[s]["E"]).length for s in ARM}
PALM_OFF = {s: 0.3 * ARM[s]["L"] for s in ARM}  # 手腕到掌心的距離


def solve_arm(s, palm, C, pole_local, hand_dir=None, twist=0.0):
    """兩節手臂的反向運動：給掌心的位置，算出上臂、前臂、手的方向。"""
    C3 = C.to_3x3()
    S = arm.pose.bones["upperarm." + s].head.copy()
    T = palm - (palm - S).normalized() * PALM_OFF[s]
    dv = T - S
    reach = L1[s] + L2[s] - 0.004
    dist = min(max(dv.length, abs(L1[s] - L2[s]) + 0.01), reach)
    dn = dv.normalized()
    T = S + dn * dist
    a = (L1[s] ** 2 - L2[s] ** 2 + dist ** 2) / (2 * dist)
    hgt = math.sqrt(max(0.0, L1[s] ** 2 - a ** 2))
    pole = C3 @ Vector(pole_local)
    pole = (pole - dn * pole.dot(dn))
    pole = pole.normalized() if pole.length > 1e-5 else Vector((0, 0, -1))
    E = S + dn * a + pole * hgt
    Mu = aim("upperarm." + s, E - S, carry=C3)
    set_world(arm.pose.bones["upperarm." + s], S, Mu)
    carry_u = Mu @ REST["upperarm." + s].inverted()
    pf = arm.pose.bones["forearm." + s]
    fdir = (T - pf.head).normalized()
    Mf = aim("forearm." + s, fdir, carry=carry_u)
    set_world(pf, pf.head.copy(), Mf)
    carry_f = Mf @ REST["forearm." + s].inverted()
    # 手順著前臂延伸；握棒時往「垂直球棒」的方向偏一半，手腕才不會折斷
    h = fdir if hand_dir is None else (fdir + hand_dir.normalized()).normalized()
    ph = arm.pose.bones["hand." + s]
    set_world(ph, ph.head.copy(), aim("hand." + s, h, twist, carry=carry_f))


LEG1 = {s: (Vector(J["shin." + s][0]) - Vector(J["thigh." + s][0])).length for s in ("L", "R")}
LEG2 = {s: (Vector(J["foot." + s][0]) - Vector(J["shin." + s][0])).length for s in ("L", "R")}


def solve_leg(s, ankle, toe, heel, Ch3):
    """腳踩在指定位置：給腳踝的位置與腳尖方向，反推大腿、小腿。Ch3＝骨盆帶動的旋轉。"""
    pt = arm.pose.bones["thigh." + s]
    Hp = pt.head.copy()
    dv = Vector(ankle) - Hp
    reach = LEG1[s] + LEG2[s] - 0.004
    dist = min(max(dv.length, 0.12), reach)
    dn = dv.normalized()
    T = Hp + dn * dist
    a = (LEG1[s] ** 2 - LEG2[s] ** 2 + dist ** 2) / (2 * dist)
    hgt = math.sqrt(max(0.0, LEG1[s] ** 2 - a ** 2))
    toe_v = Vector((toe[0], toe[1], 0)).normalized()
    pole = (Ch3 @ Vector((0, -1, 0)) + toe_v).normalized()  # 膝蓋朝向「骨盆正面」和「腳尖」之間
    pole = pole - dn * pole.dot(dn)
    pole = pole.normalized() if pole.length > 1e-5 else toe_v
    K = Hp + dn * a + pole * hgt
    Mt = aim("thigh." + s, K - Hp, carry=Ch3)
    set_world(pt, Hp, Mt)
    ps = arm.pose.bones["shin." + s]
    Ms = aim("shin." + s, T - ps.head, carry=Mt @ REST["thigh." + s].inverted())
    set_world(ps, ps.head.copy(), Ms)
    # 腳掌：鞋底維持水平，只依腳尖方向轉；heel＝腳跟抬起的角度
    yaw = math.atan2(-toe_v.x, -toe_v.y)  # 靜止時腳尖朝 -Y
    Mf = Matrix.Rotation(-yaw, 3, "Z") @ Matrix.Rotation(math.radians(heel), 3, "X") @ REST["foot." + s]
    pfoot = arm.pose.bones["foot." + s]
    set_world(pfoot, pfoot.head.copy(), Mf)


def apply_pose(pose):
    for pb in arm.pose.bones:
        B = REST[pb.name]
        rot = pose.get(pb.name, (0, 0, 0))
        Rm = Euler([math.radians(a) for a in rot], "ZYX").to_matrix()
        pb.rotation_quaternion = (B.inverted() @ Rm @ B).to_quaternion()
        pb.location = (0, 0, 0)
        pb.scale = (1, 1, 1)
    if "_root" in pose:
        arm.pose.bones["hips"].location = REST["hips"].inverted() @ Vector(pose["_root"])
    if pose.get("_ball") is not None:
        sc = pose["_ball"]
        arm.pose.bones["ball"].scale = (sc, sc, sc)
    bpy.context.view_layer.update()
    # 胸口帶動的座標系：手和球棒的目標位置都是相對於胸口來指定
    C = arm.pose.bones["chest"].matrix @ arm_data.bones["chest"].matrix_local.inverted()
    palms, hdir = {}, {}
    if "bat_g" in pose:
        G = C @ (CHEST_HEAD + Vector(pose["bat_g"]))
        D = (C.to_3x3() @ Vector(pose["bat_d"])).normalized()
        set_world(arm.pose.bones["bat"], G, aim("bat", D))
        palms["L"], palms["R"] = G + D * 0.005, G + D * 0.085  # 左手在下、右手在上
        for s in ("L", "R"):
            S = arm.pose.bones["upperarm." + s].head
            v = palms[s] - S
            hdir[s] = (v - D * v.dot(D)).normalized()  # 手垂直於球棒伸過去
    for s in ("L", "R"):
        if "ik" + s in pose:
            palms[s] = C @ (CHEST_HEAD + Vector(pose["ik" + s]))
    for s in ("L", "R"):
        if s in palms:
            sign = 1 if s == "L" else -1
            pole = pose.get("pole" + s, (sign * 0.5, 0.25, -0.85))
            solve_arm(s, palms[s], C, pole, hdir.get(s), pose.get("twist" + s, 0.0))
    Ch3 = (arm.pose.bones["hips"].matrix @ arm_data.bones["hips"].matrix_local.inverted()).to_3x3()
    for s in ("L", "R"):
        if "foot" + s in pose:
            solve_leg(s, pose["foot" + s], pose.get("toe" + s, (0, -1, 0)), pose.get("heel" + s, 0.0), Ch3)
    for pb in arm.pose.bones:
        if pb.name != "hips" and pb.name != "bat":
            pb.location = (0, 0, 0)
    bpy.context.view_layer.update()


DEFAULTS = {"_root": (0, 0, 0), "poleL": (0.5, 0.25, -0.85), "poleR": (-0.5, 0.25, -0.85),
            "toeL": (0, -1, 0), "toeR": (0, -1, 0), "heelL": 0.0, "heelR": 0.0, "twistL": 0.0, "twistR": 0.0}
STEP_KEYS = {"_ball"}  # 不內插，直接沿用前一個關鍵格的值


def sample(keys, frame):
    """依關鍵格內插出這一格的姿勢參數（Catmull-Rom，速度連續，不會每個關鍵格都停一下）。"""
    frames = [k[0] for k in keys]
    i = max(0, max(j for j, f in enumerate(frames) if f <= frame))
    i = min(i, len(keys) - 2)
    t = (frame - frames[i]) / max(1e-6, frames[i + 1] - frames[i])
    n_k = len(keys)
    if keys[0][1] == keys[-1][1] and n_k > 2:  # 循環動作：頭尾相接，循環點的速度才連續
        idx = [(i - 1) % (n_k - 1), i, i + 1, (i + 2) % (n_k - 1) if i + 2 > n_k - 1 else i + 2]
    else:
        idx = [max(0, i - 1), i, i + 1, min(n_k - 1, i + 2)]
    names = set()
    for _f, pz in keys:
        names |= set(pz)
    out = {}
    for nm in names:
        if nm in STEP_KEYS:
            out[nm] = keys[i][1].get(nm, keys[i + 1][1].get(nm))
            continue
        present = [nm in keys[j][1] for j in range(len(keys))]
        if not all(present) and nm in ("bat_g", "bat_d", "ikL", "ikR", "footL", "footR"):
            raise ValueError(f"{nm} 必須在這個動作的每個關鍵格都有值")
        vals = []
        for j in idx:
            v = keys[j][1].get(nm, DEFAULTS.get(nm, (0, 0, 0)))
            vals.append(np.atleast_1d(np.array(v, dtype=float)))
        p0, p1, p2, p3 = vals
        v = 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3)
        out[nm] = float(v[0]) if len(v) == 1 else tuple(float(c) for c in v)
    return out


def make_action(name, keys):
    """每一格都依內插後的參數重新擺姿勢並記錄：手一定握在球棒上、腳一定踩在指定位置。"""
    act = bpy.data.actions.new(name)
    arm.animation_data.action = act
    prev = None
    for frame in range(int(keys[0][0]), int(keys[-1][0]) + 1):
        apply_pose(sample(keys, frame))
        for pb in arm.pose.bones:
            q = pb.rotation_quaternion
            if prev is not None and prev[pb.name].dot(q) < 0:  # 四元數取同一邊，避免繞遠路
                pb.rotation_quaternion = -q
            pb.keyframe_insert("rotation_quaternion", frame=frame)
        prev = {pb.name: pb.rotation_quaternion.copy() for pb in arm.pose.bones}
        arm.pose.bones["hips"].keyframe_insert("location", frame=frame)
        arm.pose.bones["ball"].keyframe_insert("scale", frame=frame)
        arm.pose.bones["bat"].keyframe_insert("location", frame=frame)
    for fc in getattr(act, "fcurves", []):
        for kp in fc.keyframe_points:
            kp.interpolation = "LINEAR"
    return act


def merge(*ds):
    out = {}
    for d in ds:
        out.update(d)
    return out


exec(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "poses.py"), encoding="utf-8").read())
ACTIONS = {name: make_action(name, keys) for name, keys in CLIPS.items()}

# ════════ 姿勢預覽 ════════
if PREVIEW:
    os.makedirs(PREVIEW, exist_ok=True)
    for ob in MESHES:
        for mat in ob.data.materials:
            nt = mat.node_tree
            tex = next((nd for nd in nt.nodes if nd.type == "TEX_IMAGE"), None)
            out = next(nd for nd in nt.nodes if nd.type == "OUTPUT_MATERIAL")
            em = nt.nodes.new("ShaderNodeEmission")
            if tex:
                nt.links.new(tex.outputs["Color"], em.inputs["Color"])
            else:
                em.inputs["Color"].default_value = nt.nodes["Principled BSDF"].inputs["Base Color"].default_value
            nt.links.new(em.outputs[0], out.inputs["Surface"])
    world = bpy.data.worlds.new("w")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.48, 0.5, 0.55, 1)
    scene.world = world
    cam_data = bpy.data.cameras.new("cam")
    cam_data.angle = math.radians(32)
    cam = bpy.data.objects.new("cam", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    for nm in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
        try:
            scene.render.engine = nm
            break
        except Exception:
            continue
    scene.view_settings.view_transform = "Standard"
    scene.render.image_settings.file_format = "PNG"
    scene.render.resolution_x = scene.render.resolution_y = 480
    for name, frames in PREVIEW_FRAMES.items():
        arm.animation_data.action = ACTIONS[name]
        bat.hide_render = name not in ("swing", "stance")
        ball.hide_render = name != "pitch"
        for f in frames:
            scene.frame_set(f)
            # a＝投手方向看過來、b＝正上方俯視（看球棒軌跡與腳有沒有滑）、c＝側面、d＝上半身特寫
            for vn, az, el, dist, ctr in (("a", 0, 8, 4.6, Vector((0, -0.15, 0.85))), ("b", 0, 89, 5.2, Vector((0, -0.15, 0.6))),
                                          ("c", -90, 8, 4.6, Vector((0, -0.15, 0.85))),
                                          ("d", 35, 10, 2.5, arm.pose.bones["chest"].head.copy() + Vector((0, 0, 0.08)))):
                a, e = math.radians(az), math.radians(el)
                pos = ctr + Vector((math.sin(a) * math.cos(e), -math.cos(a) * math.cos(e), math.sin(e))) * dist
                cam.location = pos
                cam.rotation_euler = (ctr - pos).to_track_quat("-Z", "Y").to_euler()
                scene.render.filepath = os.path.join(PREVIEW, f"{name}_{f:03d}_{vn}.png")
                bpy.ops.render.render(write_still=True)
    bat.hide_render = ball.hide_render = False
    # 預覽用的發光材質要改回原本的接法，否則匯出的檔案會沒有貼圖
    for ob in MESHES:
        for mat in ob.data.materials:
            nt = mat.node_tree
            out = next(nd for nd in nt.nodes if nd.type == "OUTPUT_MATERIAL")
            nt.links.new(nt.nodes["Principled BSDF"].outputs[0], out.inputs["Surface"])

# ════════ 匯出 ════════
arm.animation_data.action = None
for name, act in ACTIONS.items():
    tr = arm.animation_data.nla_tracks.new()
    tr.name = name
    st = tr.strips.new(name, int(act.frame_range[0]), act)
    st.name = name
apply_pose({})
for o in bpy.data.objects:
    o.select_set(o in MESHES or o is arm)
bpy.context.view_layer.objects.active = arm
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_image_format="JPEG", export_image_quality=92,
                          export_animations=True, export_animation_mode="NLA_TRACKS", export_skins=True)
print("已匯出:", OUT, os.path.getsize(OUT), "bytes")
