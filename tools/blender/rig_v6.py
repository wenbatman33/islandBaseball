"""第 6 版球員（Meshy 模型）：加上骨架、球棒、球，並製作動作，匯出成帶動作的 GLB。
由 rig_anim.py 改來：關節位置全部讀 rig_v6.json（不再寫死舊 Q 版身材的高度），
動作檔 poses.py 是照舊身材寫的，載入後依腿長、手臂長的比例換算。

執行：
  /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python rig_v6.py -- <輸入.glb> <rig_v6.json> <輸出.glb> [姿勢預覽資料夾]

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
R = json.load(open(RIG_JSON))


def split_cap(ob, z_min):
    """Meshy 的模型帽子和頭是同一塊網格。依貼圖顏色把頭頂的深綠色面切出來成為獨立的 cap，
    遊戲裡打者才能藏起帽子、換上頭盔（帽子底下沒有頭髮，會被頭盔蓋住）。"""
    img = next(n.image for n in ob.data.materials[0].node_tree.nodes if n.type == "TEX_IMAGE")
    w, h = img.size
    px = np.array(img.pixels[:]).reshape(h, w, 4)
    uv = ob.data.uv_layers.active.data
    sel = []
    for p in ob.data.polygons:
        u = sum(uv[i].uv.x for i in p.loop_indices) / p.loop_total
        v = sum(uv[i].uv.y for i in p.loop_indices) / p.loop_total
        r, g, b, _ = px[min(h - 1, int(v * h)) % h, min(w - 1, int(u * w)) % w]
        z = (ob.matrix_world @ p.center).z
        sel.append(bool(z > z_min and g > r + 0.015 and g >= b and r + g + b < 0.9))
    me = ob.data
    for p, s in zip(me.polygons, sel):
        p.select = s
    bpy.context.view_layer.objects.active = ob
    for o in bpy.data.objects:
        o.select_set(o is ob)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_mode(type="FACE")
    bpy.ops.object.mode_set(mode="OBJECT")
    for p, s in zip(me.polygons, sel):
        p.select = s
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.separate(type="SELECTED")
    bpy.ops.object.mode_set(mode="OBJECT")
    new = next(o for o in bpy.data.objects if o.type == "MESH" and o is not ob and o.name.startswith(ob.name))
    new.name = "cap"
    new.data.name = "cap"
    print(f"帽子切出 {sum(sel)} 面")
    return new


cap = split_cap(player, R["cap_z"])


def mark_regions(ob):
    """每個三角形取貼圖上 7 個點的多數顏色，標成「球衣布料」或「皮膚」，寫進頂點顏色（R＝布料、G＝皮膚）。
    遊戲換隊色時整塊布料直接換色，不再逐點猜（Meshy 貼圖細節多，逐點判斷會漏掉很多點，深色球衣上出現白色斑點）。"""
    img = next(n.image for n in ob.data.materials[0].node_tree.nodes if n.type == "TEX_IMAGE")
    w, h = img.size
    px = np.array(img.pixels[:]).reshape(h, w, 4)[:, :, :3]
    me = ob.data
    uv = np.array([d.uv[:] for d in me.uv_layers.active.data])
    BARY = np.array([[1 / 3, 1 / 3, 1 / 3], [0.6, 0.2, 0.2], [0.2, 0.6, 0.2], [0.2, 0.2, 0.6], [0.45, 0.45, 0.1], [0.45, 0.1, 0.45], [0.1, 0.45, 0.45]])
    attr = me.color_attributes.new("region", "BYTE_COLOR", "CORNER")
    counts = {"布料": 0, "皮膚": 0, "其他": 0}
    for p in me.polygons:
        li = list(p.loop_indices)[:3]
        pts = BARY @ uv[li]
        xs = np.clip((pts[:, 0] * w).astype(int), 0, w - 1)
        ys = np.clip((pts[:, 1] * h).astype(int), 0, h - 1)
        c = px[ys, xs]
        r, g, b = c[:, 0], c[:, 1], c[:, 2]
        lum = 0.299 * r + 0.587 * g + 0.114 * b
        green = (g - np.maximum(r, b)) > 0.03
        ratio = np.minimum(np.minimum(r, g), b) / np.maximum(np.maximum(r, g), np.maximum(b, 1e-3))
        cream = (lum > 0.45) & (ratio > 0.72) & ~green
        skin = (r > g) & (g > b) & ((r - b) > 0.12) & (lum > 0.2) & ~cream
        n_c, n_s, n_g = cream.sum(), skin.sum(), green.sum()
        z = (ob.matrix_world @ p.center).z
        # 球衣上的滾邊、鈕扣只是細節：布料佔多數就整塊算布料；領口以上不會有布料
        is_cloth = z < R["neck_z"] - 0.02 and n_c >= 3 and n_c >= n_s
        is_skin = not is_cloth and n_s >= 4
        col = (1.0 if is_cloth else 0.0, 1.0 if is_skin else 0.0, 0.0, 1.0)
        for i in p.loop_indices:
            attr.data[i].color = col
        counts["布料" if is_cloth else "皮膚" if is_skin else "其他"] += 1
    me.color_attributes.active_color = attr
    print(f"區域標記：{counts}")


mark_regions(player)

# ════════ 骨架 ════════
yT, yH, cz, neck = R["y_torso"], R["y_head"], R["crotch_z"], R["neck_z"]
yL, yA = R["y_leg"], R["y_ankle"]
ANKLE_Z = R["ankle"][1]
ARMPIT_Z = R["armpit_z"]
J = {}  # 名稱 → (頭, 尾, 父)
J["hips"] = ((0, yT, R["hips_z"]), (0, yT, R["spine_z"]), None)
J["spine"] = ((0, yT, R["spine_z"]), (0, yT, R["chest_z"]), "hips")
J["chest"] = ((0, yT, R["chest_z"]), (0, yT, neck - 0.03), "spine")
J["head"] = ((0, (yT + yH) / 2, neck), (0, yH, neck + 0.5), "chest")
ARM = {}
for sign, s in ((1, "L"), (-1, "R")):
    W = Vector((sign * R["wrist"][0], yT, R["wrist"][1]))
    d = Vector((sign * R["arm_dir"][0], 0, R["arm_dir"][1])).normalized()
    L = R["hand_L"] * 0.86
    S = W - d * ((R["shoulder_z"] - W.z) / -d.z)  # 沿手臂方向往上推回肩關節的高度
    E = S + (W - S) * 0.6  # 手肘
    palm = W + d * 0.3 * L
    ARM[s] = dict(S=S, E=E, W=W, tip=W + d * L, palm=palm, d=d, L=L)
    J["upperarm." + s] = (tuple(S), tuple(E), "chest")
    J["forearm." + s] = (tuple(E), tuple(W), "upperarm." + s)
    J["hand." + s] = (tuple(W), tuple(W + d * 0.5 * L), "forearm." + s)
    J["fingers." + s] = (tuple(W + d * 0.52 * L), tuple(W + d * L), "hand." + s)
for sign, s in ((1, "L"), (-1, "R")):
    hip = (sign * R["hip_x"], yL, cz + 0.03)
    knee = (sign * R["knee"][0], yL, R["knee"][1])
    ank = (sign * R["ankle"][0], yA, ANKLE_Z)
    toe = (sign * R["toe"][0], R["toe"][1], R["toe"][2])
    J["thigh." + s] = (hip, knee, "hips")
    J["shin." + s] = (knee, ank, "thigh." + s)
    J["foot." + s] = (ank, toe, "shin." + s)
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


BAT_LEN = 0.82  # 握把以上的長度（真實球棒全長約 86 公分）；比真實稍粗一點，遠鏡頭才看得清楚
# (沿球棒方向的位置, 半徑)：握把底的圓頭 → 握把 → 漸粗 → 棒頭
prof = [(-0.05, 0.001), (-0.048, 0.026), (-0.034, 0.026), (-0.026, 0.016), (BAT_LEN * 0.25, 0.016), (BAT_LEN * 0.5, 0.022),
        (BAT_LEN * 0.7, 0.035), (BAT_LEN * 0.9, 0.039), (BAT_LEN * 0.975, 0.035), (BAT_LEN, 0.001)]
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
bmesh.ops.create_uvsphere(bm, u_segments=16, v_segments=10, radius=0.037)
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
head_m = z > neck + 0.08  # 和下面脖子過渡區的上緣一致
# 手臂：靠近「肩—肘—腕—指尖」折線的頂點
arm_m = np.zeros(n, dtype=bool)
arm_side = np.zeros(n, dtype=int)
for s, A in ARM.items():
    d_arm = np.minimum.reduce([seg_dist(P, A["S"], A["E"]), seg_dist(P, A["E"], A["W"]), seg_dist(P, A["W"], A["tip"])])
    sign = 1 if s == "L" else -1
    d_hand = seg_dist(P, A["W"], A["tip"])
    # 腋下以下手臂和身體是分開的，範圍可以放寬（袖子很胖）；手的範圍再大一點，拇指才不會被漏掉
    m = (x * sign > 0) & ~head_m & (
        (z < ARMPIT_Z) & (np.abs(x) > np.abs(A["W"][0] - A["d"][0] / A["d"][2] * (z - A["W"][2])) - 0.075) & (np.abs(x) > 0.2) & (d_arm < 0.11)
        | (z >= ARMPIT_Z) & (np.abs(x) > 0.17) & (d_arm < 0.1)
        | (np.abs(x) > 0.24) & (d_hand < 0.16))
    arm_m |= m
    arm_side[m] = sign
leg_m = (z < cz - 0.01) & ~arm_m
torso_m = ~head_m & ~arm_m & ~leg_m

Wt["head"][head_m] = 1.0
for s, sign in (("L", 1), ("R", -1)):
    m = arm_m & (arm_side == sign)
    A = ARM[s]
    Wt["upperarm." + s][m] = gauss(seg_dist(P[m], A["S"], A["E"]), 0.065)
    Wt["forearm." + s][m] = gauss(seg_dist(P[m], A["E"], A["W"]), 0.055)
    Wt["hand." + s][m] = gauss(seg_dist(P[m], A["W"], A["tip"]), 0.05) * 1.5
    # 肩膀：沿著上臂方向，從肩關節往內 4 公分到往外 9 公分之間，由胸口漸層交給手臂（腋下才不會被硬扯）
    ua = np.array(A["E"]) - np.array(A["S"])
    ua_len = np.linalg.norm(ua)
    along_u = (P[m] - np.array(A["S"])) @ (ua / ua_len)
    sh = np.clip((along_u + 0.03) / 0.12, 0, 1)  # 漸層只到肩頭下方：袖子要整圈跟著上臂，舉手時才不會被留在肩膀上
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
    for k, sg in (("thigh." + s, 0.09), ("shin." + s, 0.08), ("foot." + s, 0.06)):
        Wt[k][m] = gauss(seg_dist(P[m], J[k][0], J[k][1]), sg)
    Wt["foot." + s][m & (z < ANKLE_Z - 0.02)] += 2.0
    # 軀幹下緣靠近大腿根部的地方帶一點大腿的權重
    m = torso_m & (x * sign > 0) & (z < cz + 0.1)
    Wt["thigh." + s][m] = gauss(seg_dist(P[m], J["thigh." + s][0], J["thigh." + s][1]), 0.08) * 0.6
for k, sg in (("hips", 0.13), ("spine", 0.13), ("chest", 0.13)):
    Wt[k][torso_m] = gauss(seg_dist(P[torso_m], J[k][0], J[k][1]), sg)
# 腋下附近的身體側面帶一部分上臂的權重，手臂抬起時衣服才會跟著被帶動而不是撕開
_tsum = Wt["hips"] + Wt["spine"] + Wt["chest"]
for s, sign in (("L", 1), ("R", -1)):
    A = ARM[s]
    m = torso_m & (x * sign > 0) & (z > ARMPIT_Z - 0.17)
    d_u = seg_dist(P[m], A["S"], A["E"])
    wa = np.clip((0.16 - d_u) / 0.08, 0, 1) * 0.55
    for k in ("hips", "spine", "chest"):
        Wt[k][m] *= (1 - wa)
    Wt["upperarm." + s][m] = wa * np.maximum(_tsum[m], 1e-6)
    Wt[k][leg_m] += gauss(seg_dist(P[leg_m], J[k][0], J[k][1]), 0.05) * (0.5 if k == "hips" else 0)
# 脖子在胸和頭之間過渡。打擊、投球時頭相對胸口會轉將近 100 度，過渡區要夠長才不會扯出條紋；
# 起點在領口以上，衣領維持跟著胸口
NK0, NK1 = neck - 0.01, neck + 0.08
nk = ~arm_m & (z > NK0) & (z <= NK1)
tt = (z[nk] - NK0) / (NK1 - NK0)
tt = tt * tt * (3 - 2 * tt)
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
keep[gid[head_m & (z > neck + 0.1)]] = True  # 頭維持整塊跟著頭骨
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


def grip_matrix(s, h, D, sign):
    """握棒時手的朝向：手指指向 h（和球棒垂直），手指彎曲的軸和球棒 D 平行，手指才會繞著球棒握住。
    手指彎曲是繞著「靜止姿勢時的前後軸」轉（見 apply_pose），換到手骨自己的座標就是 a_local。"""
    B = REST["hand." + s]
    a_local = (B.inverted() @ Vector((0, 1, 0))).normalized()
    e1 = Vector((0, 1, 0))
    e2 = (a_local - e1 * a_local.dot(e1)).normalized()
    e3 = e1.cross(e2)
    D = D.normalized() * sign
    t1 = (h - D * h.dot(D)).normalized()
    t2 = D
    t3 = t1.cross(t2)
    return Matrix((t1, t2, t3)).transposed() @ Matrix((e1, e2, e3))


GRIP_SIGN = {"L": 1, "R": 1}


def solve_arm(s, palm, C, pole_local, hand_dir=None, twist=0.0, bat_dir=None):
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
    Mh = aim("hand." + s, h, twist, carry=carry_f)
    if bat_dir is not None:
        # 握棒：手掌轉到讓手指繞著球棒握住。轉動的角度一半分給前臂，手腕才不會像糖果紙一樣擰在一起
        Mg = grip_matrix(s, Mh @ Vector((0, 1, 0)), bat_dir, GRIP_SIGN[s])
        q = (Mg @ Mh.inverted()).to_quaternion()
        ang = q.angle if q.axis.dot(Mh @ Vector((0, 1, 0))) >= 0 else -q.angle
        if ang > math.pi:
            ang -= 2 * math.pi
        Mf2 = Matrix.Rotation(ang * 0.5, 3, fdir) @ Mf
        set_world(pf, pf.head.copy(), Mf2)
        Mh = Mg
    set_world(ph, ph.head.copy(), Mh)


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
    D = None
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
            solve_arm(s, palms[s], C, pole, hdir.get(s), pose.get("twist" + s, 0.0), D if s in hdir else None)
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

# poses.py 是照舊的 Q 版身材寫的（腿短、手短）。換算到新身材：
#   腳的位置、骨盆位移 → 依腿長比例；手和球棒握把（相對胸口）→ 依手臂長比例
OLD = R["old"]
LEG_K = (cz - ANKLE_Z) / (OLD["crotch_z"] - OLD["ankle_z"])
ARM_K = R["arm_len"] / OLD["arm_len"]
print(f"動作換算：腿 ×{LEG_K:.3f}、手臂 ×{ARM_K:.3f}")


def convert_pose(pz):
    out = dict(pz)
    for s in ("L", "R"):
        if "foot" + s in pz:
            x, y, z = pz["foot" + s]
            out["foot" + s] = (x * LEG_K, y * LEG_K + yA, ANKLE_Z + (z - OLD["ankle_z"]) * LEG_K)
        if "ik" + s in pz:
            out["ik" + s] = tuple(c * ARM_K for c in pz["ik" + s])
    if "_root" in pz:
        out["_root"] = tuple(c * LEG_K for c in pz["_root"])
    if "bat_g" in pz:
        out["bat_g"] = tuple(c * ARM_K for c in pz["bat_g"])
    return out


CLIPS = {name: [(f, convert_pose(pz)) for f, pz in keys] for name, keys in CLIPS.items()}
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
                          export_animations=True, export_animation_mode="NLA_TRACKS", export_skins=True,
                          export_vertex_color="ACTIVE")  # 區域標記（頂點顏色）也要匯出
print("已匯出:", OUT, os.path.getsize(OUT), "bytes")
