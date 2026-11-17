"""第 7 版球員：Meshy 自動綁好的骨架（Mixamo 命名）＋ Meshy 文字轉動畫產生的動作，整理成遊戲用的 GLB。

和第 6 版不同：骨架、皮膚權重、動作都不是程式手刻的（手刻的權重讓手臂像骨折）。這支腳本只負責：
  1. 整體等比例縮放到身高 1.903 m（和第 6 版相同，背號、裝備等座標都可以沿用）
  2. 九個動作改成遊戲用的名字、轉到遊戲要的方向、處理骨盆位移、從揮棒切出打擊預備
  3. 加上球棒（跟著兩手的指根連線走），打擊時手指彎起來握住球棒
  4. 切出帽子、標記布料／皮膚區域（給換隊色用）

執行：
  /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python rig_v7.py -- <meshy_rigged_anims.glb> <輸出.glb> [姿勢預覽資料夾]
"""
import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Quaternion, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from meshy_common import mark_regions, split_cap  # noqa: E402

argv = sys.argv[sys.argv.index("--") + 1:]
SRC, OUT = argv[0], argv[1]
PREVIEW = argv[2] if len(argv) > 2 else None
FPS = 30
HEIGHT = 1.903  # 和第 6 版相同的身高
P = "mixamorig:"

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = FPS  # 先設好再匯入：動作的格數才會照每秒 30 格換算
bpy.ops.import_scene.gltf(filepath=SRC)
arm = next(o for o in scene.objects if o.type == "ARMATURE")
body = next(o for o in scene.objects if o.type == "MESH" and o.parent is arm)
for o in list(scene.objects):
    if o not in (arm, body):
        bpy.data.objects.remove(o)
body.name = "player"
body.data.name = "player"

# ════════ 1. 等比例縮放（網格頂點與骨頭的靜止位置一起放大；物件本身維持沒有縮放） ════════
zs = [(body.matrix_world @ v.co).z for v in body.data.vertices]
K = HEIGHT / (max(zs) - min(zs))
body.data.transform(Matrix.Scale(K, 4))
bpy.context.view_layer.objects.active = arm
for o in scene.objects:
    o.select_set(o is arm)
bpy.ops.object.mode_set(mode="EDIT")
for eb in arm.data.edit_bones:
    eb.head *= K
    eb.tail *= K
bpy.ops.object.mode_set(mode="OBJECT")
print(f"縮放 ×{K:.4f}")

# ════════ 減面：每人 3.1 萬三角形，全隊 18 人加主審就有 60 萬，還要再畫一次陰影。減到約 1.2 萬 ════════
# 先合併貼圖接縫上重複的點（網格在接縫處才連得起來，減面時不會裂開），骨頭權重會跟著保留
TRIS = 12000
for o in scene.objects:
    o.select_set(o is body)
bpy.context.view_layer.objects.active = body
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.mesh.remove_doubles(threshold=1e-5)
bpy.ops.object.mode_set(mode="OBJECT")
tris0 = sum(len(p.vertices) - 2 for p in body.data.polygons)
dec = body.modifiers.new("dec", "DECIMATE")
dec.ratio = min(1.0, TRIS / tris0)
dec.use_collapse_triangulate = True
while body.modifiers[0] != dec:
    bpy.ops.object.modifier_move_up(modifier=dec.name)
bpy.ops.object.modifier_apply(modifier=dec.name)
print(f"減面 {tris0} → {sum(len(p.vertices) - 2 for p in body.data.polygons)} 三角形")
for o in scene.objects:
    o.select_set(o is arm)
bpy.context.view_layer.objects.active = arm  # 之後要編輯骨架（加球棒骨頭）

# ════════ 材質：顏色貼圖保留 2048；法線、粗糙度貼圖縮到 1024；不要金屬感 ════════
mat = body.data.materials[0]
nt = mat.node_tree
bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
for link in list(bsdf.inputs["Metallic"].links):
    nt.links.remove(link)
bsdf.inputs["Metallic"].default_value = 0.0
base_img = bsdf.inputs["Base Color"].links[0].from_node.image
for img in bpy.data.images:
    if img is not base_img and img.size[0] > 1024:
        img.scale(1024, 1024)
for img in list(bpy.data.images):
    if img.name in ("Render Result", "Viewer Node"):
        bpy.data.images.remove(img)

# ════════ 2. 動作 ════════
# Meshy 匯出的 AI 動作名稱是生成時的編號（依時間排序），照生成順序對回名字
uuids = sorted((a for a in bpy.data.actions if a.name.startswith("_")), key=lambda a: a.name)
NAMES = ["pitch", "idle", "ready", "crouch", "catchUp", "throw", "swing"]
assert len(uuids) == len(NAMES), [a.name for a in uuids]
SRC_ACT = dict(zip(NAMES, uuids))
SRC_ACT["run"] = bpy.data.actions["Running"]

# (來源, 開始秒, 結束秒, 轉向角度, 骨盆位移處理, 來回播放)
#   轉向：投球的跨步、傳球的方向轉成朝 -Y；揮棒轉成預備時左肩朝 -Y（投手方向），和舊動作的慣例相同（見 poses.py）
#   位移：keep＝保留；none＝去掉水平位移；back＝出手後慢慢收回原位（換回待機時才不會瞬間移位）
CLIPS = {
    "idle": ("idle", None, None, 0, "none", False),
    "ready": ("ready", None, None, 0, "none", False),
    "crouch": ("crouch", None, None, 0, "none", False),
    "catchUp": ("catchUp", None, None, 0, "none", False),
    "run": ("run", None, None, 0, "none", False),
    "pitch": ("pitch", 0.0, 1.75, 120, ("back", 1.3), False),
    "throw": ("throw", 0.75, 1.6, -21, "none", False),
    "stance": ("swing", 0.0, 0.5, -98, "keep", True),
    "swing": ("swing", 0.0, 1.5, -98, "keep", False),
}
BATTING = {"stance", "swing"}

if arm.animation_data is None:
    arm.animation_data_create()
for tr in list(arm.animation_data.nla_tracks):
    arm.animation_data.nla_tracks.remove(tr)
pbs = arm.pose.bones
hips = pbs[P + "Hips"]
REST_HIPS = (arm.data.bones[P + "Hips"].head_local).copy()


def use_action(act):
    arm.animation_data.action = act
    if getattr(act, "slots", None) and len(act.slots):
        arm.animation_data.action_slot = act.slots[0]


def sample(src, t0, t1):
    """逐格取出來源動作：每根骨頭的局部變換，以及骨盆在骨架空間的矩陣。"""
    use_action(src)
    f0, f1 = src.frame_range
    t0 = f0 / FPS if t0 is None else t0
    t1 = f1 / FPS if t1 is None else t1
    frames = []
    n = int(round((t1 - t0) * FPS))
    for i in range(n + 1):
        f = (t0 + i / FPS) * FPS
        scene.frame_set(int(math.floor(f)), subframe=f - math.floor(f))
        frames.append(({pb.name: pb.matrix_basis.copy() for pb in pbs}, hips.matrix.copy()))
    return frames


# ── 握棒：手指彎起來（打擊時） ──
FINGERS = [f"{s}Hand{f}{j}" for s in ("Left", "Right") for f in ("Index", "Middle", "Ring", "Pinky") for j in (1, 2, 3)]
THUMBS = [f"{s}HandThumb{j}" for s in ("Left", "Right") for j in (2, 3)]
CURL_AXIS = Vector((1, 0, 0))  # Mixamo 手指骨頭：繞自己的 X 軸彎
CURL = {1: 55, 2: 75, 3: 55}


def grip_fingers():
    for n in FINGERS:
        pb = pbs[P + n]
        j = int(n[-1])
        q = Quaternion(CURL_AXIS, math.radians(CURL[j]))
        pb.rotation_quaternion = pb.rotation_quaternion @ q
    for n in THUMBS:
        pb = pbs[P + n]
        pb.rotation_quaternion = pb.rotation_quaternion @ Quaternion(CURL_AXIS, math.radians(30))


# ── 球棒 ──
bpy.ops.object.mode_set(mode="EDIT")
eb = arm.data.edit_bones.new("bat")
grip0 = arm.data.edit_bones[P + "RightHand"].head.copy()
eb.head = grip0
eb.tail = grip0 + Vector((0, -0.12, 0))
bpy.ops.object.mode_set(mode="OBJECT")
bat_pb = pbs["bat"]
bat_pb.rotation_mode = "QUATERNION"
BAT_REST = arm.data.bones["bat"].matrix_local.to_3x3()


# 球棒方向（相對胸口：+X 角色左手邊、-Y 胸前、+Z 上，和 poses.py 相同）。AI 動作的手沒有真的握棒，
# 從手的方向推不出球棒方向，所以照揮棒的節奏直接指定：(秒, 方向)
BAT_DIR = {
    "stance": [(0.0, (-0.5, 0.3, 0.81))],
    "swing": [(0.0, (-0.5, 0.3, 0.81)), (0.55, (-0.5, 0.3, 0.81)), (0.7, (-0.55, 0.38, 0.74)), (0.88, (-0.72, 0.32, 0.6)), (1.0, (-0.85, -0.5, -0.15)),
              (1.08, (0.0, -0.98, 0.2)), (1.25, (0.75, 0.45, 0.5)), (1.5, (0.75, 0.45, 0.5))],
}
CHEST = P + "Spine2"
CHEST_REST = arm.data.bones[CHEST].matrix_local.to_3x3()


def bat_dir(name, t):
    keys = BAT_DIR.get(name)
    if not keys:
        return None
    if t <= keys[0][0] or len(keys) == 1:
        v = Vector(keys[0][1])
    elif t >= keys[-1][0]:
        v = Vector(keys[-1][1])
    else:
        i = max(j for j, k in enumerate(keys) if k[0] <= t)
        (ta, a), (tb, b) = keys[i], keys[i + 1]
        u = (t - ta) / (tb - ta)
        u = u * u * (3 - 2 * u)
        v = Vector(a).normalized().slerp(Vector(b).normalized(), u) if Vector(a).dot(Vector(b)) > -0.99 else Vector(a).lerp(Vector(b), u)
    C = pbs[CHEST].matrix.to_3x3() @ CHEST_REST.inverted()  # 胸口相對靜止姿勢轉了多少
    v = (C @ v.normalized()).normalized()
    if name == "swing":
        # 擊球前後：球棒水平掃過本壘板上方（用場地方向指定，不跟胸口的傾斜走，否則會朝下）。
        # 場地方向：打者面向 -X（本壘板）、投手在 -Y、捕手在 +Y
        a, b = Vector((-0.9, 0.35, 0.05)).normalized(), Vector((-0.45, -0.88, 0.15)).normalized()
        u = min(1.0, max(0.0, (t - 1.0) / 0.08))
        wv = a.slerp(b, u * u * (3 - 2 * u))
        k = min(1.0, max(0.0, (t - 0.9) / 0.07)) * min(1.0, max(0.0, (1.2 - t) / 0.1))
        k = k * k * (3 - 2 * k)
        v = v.slerp(wv, k) if v.dot(wv) > -0.95 else (v.lerp(wv, k)).normalized()
    return v


def place_bat(name=None, t=0.0):
    """握點在兩手中間（棒尾再往下一點），方向照 BAT_DIR；不是打擊動作時球棒放在右手（遊戲裡會藏起來）。"""
    bpy.context.view_layer.update()
    W = lambda n: pbs[P + n].head
    D = bat_dir(name, t)
    if D is None:
        D = (W("RightHandMiddle1") - W("RightHand")).normalized()
    mid = (W("LeftHand") + W("RightHand") + W("LeftHandMiddle1") + W("RightHandMiddle1")) / 4
    G = mid - D * 0.08
    q = (BAT_REST @ Vector((0, 1, 0))).rotation_difference(D)
    bat_pb.matrix = Matrix.Translation(G) @ (q.to_matrix() @ BAT_REST).to_4x4()


# ── 左右鏡射（AI 生成的揮棒是左打：雙手在左肩、往右轉身；遊戲的動作檔要右打，左打者在遊戲裡再整個鏡射） ──
REST = {b.name: b.matrix_local.copy() for b in arm.data.bones}
PARENT = {b.name: (b.parent.name if b.parent else None) for b in arm.data.bones}
ORDER = [b.name for b in arm.data.bones]  # 父骨頭一定排在子骨頭前面
SX = Matrix.Scale(-1, 4, Vector((1, 0, 0)))


def twin(n):
    return n.replace("Left", "\0").replace("Right", "Left").replace("\0", "Right")


def _flip(axis):
    m = Matrix.Identity(4)
    m[axis][axis] = -1
    return m


# 每根骨頭鏡射後要翻轉哪一個局部軸，才會和對側骨頭的靜止方向一致（三個軸都試，取最接近的）
FLIP = {}
for n in ORDER:
    t = twin(n)
    if t not in REST:
        t = n
    best = min((sum(abs(a - b) for ra, rb in zip(SX @ REST[n] @ _flip(k), REST[t]) for a, b in zip(ra[:3], rb[:3])), k) for k in range(3))
    FLIP[n] = _flip(best[1])


def pose_mats(basis):
    M = {}
    for n in ORDER:
        p = PARENT[n]
        B = basis.get(n, Matrix.Identity(4))
        M[n] = (REST[n] if p is None else M[p] @ REST[p].inverted() @ REST[n]) @ B
    return M


def mirror_frame(basis):
    M = pose_mats(basis)
    T = {}
    for n in ORDER:
        t = twin(n) if twin(n) in REST else n
        T[t] = SX @ M[n] @ FLIP[n]
    out = {}
    for n in ORDER:
        p = PARENT[n]
        local = REST[n] if p is None else REST[p].inverted() @ REST[n]
        parent_m = Matrix.Identity(4) if p is None else T[p]
        out[n] = local.inverted() @ parent_m.inverted() @ T[n]
    return out, T[P + "Hips"]


MIRROR = {"stance", "swing"}

# ── 自己修正打擊預備：AI 的預備縮成一團（駝背、手肘夾緊、雙手擋在臉前）。在 AI 動作上再加一層骨頭角度 ──
# (骨頭, 繞骨頭自己的軸, 角度)。Mixamo 骨頭的局部 X 軸是左右方向（彎腰／挺胸），Z 軸是前後方向（側彎、手臂張開）
ADJUST = [
    ("Spine", "X", -6), ("Spine1", "X", -6), ("Spine2", "X", -5),  # 挺胸：三節脊椎各往後一點
    ("Neck", "X", 8), ("Head", "X", 6),  # 頭不跟著往後仰，視線維持看投手
]

# ── 打擊預備的雙手：參考棒球遊戲常見的預備姿勢，用手臂反推（IK）把雙手放到後肩 ──
# 座標相對胸口（Spine2，靜止姿勢的方向：+X 角色左手邊、-Y 胸前、+Z 上）。右打者的後肩在 -X
GRIP = Vector((-0.17, -0.11, 0.13))  # 握點：後肩前方、約肩膀高度
STANCE_BAT = Vector((-0.5, 0.3, 0.81))  # 球棒往捕手方向斜立約 45 度
POLE = {"Right": Vector((-0.75, 0.25, -0.6)), "Left": Vector((0.15, -0.65, -0.75))}  # 後手肘往外下、前手肘朝下指向本壘
HAND_GAP = 0.085  # 兩手在球棒上的距離（右手在上）


def ik_arm(side, T, pole):
    up, fo, ha = pbs[P + side + "Arm"], pbs[P + side + "ForeArm"], pbs[P + side + "Hand"]
    L1 = (REST[P + side + "ForeArm"].translation - REST[P + side + "Arm"].translation).length
    L2 = (REST[P + side + "Hand"].translation - REST[P + side + "ForeArm"].translation).length
    S = up.head.copy()
    dv = T - S
    dist = min(max(dv.length, abs(L1 - L2) + 0.01), L1 + L2 - 0.003)
    dn = dv.normalized()
    a = (L1 * L1 - L2 * L2 + dist * dist) / (2 * dist)
    h = math.sqrt(max(0.0, L1 * L1 - a * a))
    pv = pole - dn * pole.dot(dn)
    pv = pv.normalized() if pv.length > 1e-5 else Vector((0, 0, -1))
    E = S + dn * a + pv * h
    q = (fo.head - S).normalized().rotation_difference((E - S).normalized())
    up.matrix = Matrix.Translation(S) @ (q.to_matrix() @ up.matrix.to_3x3()).to_4x4()
    bpy.context.view_layer.update()
    q = (ha.head - fo.head).normalized().rotation_difference((S + dn * dist - fo.head).normalized())
    fo.matrix = Matrix.Translation(fo.head.copy()) @ (q.to_matrix() @ fo.matrix.to_3x3()).to_4x4()
    bpy.context.view_layer.update()


def place_hands(name, t):
    f = ADJUST_W.get(name)
    w = f(t) if f else 0.0
    if w <= 0:
        return
    bpy.context.view_layer.update()
    ch = pbs[CHEST]
    C = ch.matrix.to_3x3() @ CHEST_REST.inverted()
    G = ch.head + C @ GRIP
    D = (C @ STANCE_BAT).normalized()
    bones = [P + s + n for s in ("Right", "Left") for n in ("Arm", "ForeArm")]
    ai = {n: pbs[n].rotation_quaternion.copy() for n in bones}
    # 手腕在握點旁邊（球棒穿過拳頭，手腕離球棒約 6 公分，偏向自己的手肘那一側）
    for side, along in (("Right", HAND_GAP), ("Left", 0.0)):
        P0 = G + D * along
        pole = (C @ POLE[side]).normalized()
        wrist = P0 + (pole - D * pole.dot(D)).normalized() * 0.06
        ik_arm(side, wrist, pole)
    for n in bones:  # 和 AI 動作依強度混合（揮棒時漸漸交回 AI）
        pbs[n].rotation_quaternion = ai[n].slerp(pbs[n].rotation_quaternion, w)
    bpy.context.view_layer.update()
# 修正的強度隨時間變化：預備全程套用；揮棒在開始轉身前套用，擊球前漸漸退掉，揮擊本身維持 AI 的動作
ADJUST_W = {"stance": lambda t: 1.0, "swing": lambda t: 1.0 if t < 0.55 else max(0.0, 1 - (t - 0.55) / 0.3)}


def apply_adjust(name, t):
    f = ADJUST_W.get(name)
    if not f:
        return
    w = f(t)
    if w <= 0:
        return
    for bone, axis, deg in ADJUST:
        pb = pbs[P + bone]
        pb.rotation_quaternion = pb.rotation_quaternion @ Quaternion(Vector({"X": (1, 0, 0), "Y": (0, 1, 0), "Z": (0, 0, 1)}[axis]), math.radians(deg * w))


def build(name, spec):
    src_name, t0, t1, yaw, move, pingpong = spec
    frames = sample(SRC_ACT[src_name], t0, t1)
    if name in MIRROR:
        frames = [mirror_frame(b) for b, _ in frames]
    if pingpong:
        frames = frames + frames[-2:0:-1]
    R = Matrix.Rotation(math.radians(yaw), 4, "Z")
    p_start = frames[0][1].translation.copy()
    act = bpy.data.actions.new(name)
    use_action(act)
    n = len(frames)
    for i, (basis, hm) in enumerate(frames):
        for pb in pbs:
            if pb.name in basis:
                pb.matrix_basis = basis[pb.name]
        # 骨盆：繞原點轉向；水平位移依設定保留或去掉
        d = hm.translation - p_start
        d.z = 0
        if move == "keep":
            w = 1.0
        elif move == "none":
            w = 0.0
        else:
            t_back = move[1] - (t0 or 0)
            t = i / FPS
            span = max(1e-3, (n - 1) / FPS - t_back)
            u = min(1.0, max(0.0, (t - t_back) / span))
            w = 1.0 - u * u * (3 - 2 * u)
        M = R @ hm
        M.translation = Vector((REST_HIPS.x, REST_HIPS.y, hm.translation.z)) + (R.to_3x3() @ d) * w
        hips.matrix = M
        t_src = (t0 or 0) + (i if not pingpong or i < (len(frames) + 2) // 2 else len(frames) - i) / FPS
        if name in BATTING:
            grip_fingers()
            apply_adjust(name, t_src)
            place_hands(name, t_src)
        place_bat(name, t_src)
        for pb in pbs:
            pb.keyframe_insert("rotation_quaternion", frame=i)
            pb.keyframe_insert("location", frame=i)
    print(f"動作 {name}：{n} 格（{(n - 1) / FPS:.2f} 秒），轉向 {yaw}°")
    return act


for pb in pbs:
    pb.rotation_mode = "QUATERNION"
ACTIONS = {name: build(name, spec) for name, spec in CLIPS.items()}

# ════════ 3. 球棒網格（綁在 bat 骨頭上） ════════
BAT_LEN = 0.82
prof = [(-0.05, 0.001), (-0.048, 0.026), (-0.034, 0.026), (-0.026, 0.016), (BAT_LEN * 0.25, 0.016), (BAT_LEN * 0.5, 0.022),
        (BAT_LEN * 0.7, 0.035), (BAT_LEN * 0.9, 0.039), (BAT_LEN * 0.975, 0.035), (BAT_LEN, 0.001)]
bm = bmesh.new()
rings = [[bm.verts.new(grip0 + Vector((r * math.cos(a), -t, r * math.sin(a)))) for a in (2 * math.pi * i / 16 for i in range(16))] for (t, r) in prof]
for a, b in zip(rings, rings[1:]):
    for i in range(16):
        j = (i + 1) % 16
        bm.faces.new([a[i], b[i], b[j], a[j]])
bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
me = bpy.data.meshes.new("bat")
bm.to_mesh(me)
bm.free()
for poly in me.polygons:
    poly.use_smooth = True
bat = bpy.data.objects.new("bat_mesh", me)
scene.collection.objects.link(bat)
wood = bpy.data.materials.new("bat_wood")
wood.use_nodes = True
wood.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.5, 0.3, 0.13, 1)
wood.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.6
bat.data.materials.append(wood)
g = bat.vertex_groups.new(name="bat")
g.add(list(range(len(bat.data.vertices))), 1.0, "REPLACE")
bat.parent = arm
bat.modifiers.new("rig", "ARMATURE").object = arm

# ════════ 4. 帽子、區域標記 ════════
arm.animation_data.action = None
for pb in pbs:
    pb.matrix_basis = Matrix.Identity(4)
bpy.context.view_layer.update()
cap = split_cap(body, 1.64)
mark_regions(body)

# ════════ 姿勢預覽 ════════
if PREVIEW:
    os.makedirs(PREVIEW, exist_ok=True)
    w = bpy.data.worlds.new("w")
    w.use_nodes = True
    w.node_tree.nodes["Background"].inputs["Color"].default_value = (0.5, 0.53, 0.58, 1)
    scene.world = w
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 3
    sun.rotation_euler = (math.radians(50), 0, math.radians(30))
    scene.collection.objects.link(sun)
    cd = bpy.data.cameras.new("cam")
    cd.sensor_fit = "VERTICAL"
    cd.angle_y = math.radians(36)
    cam = bpy.data.objects.new("cam", cd)
    scene.collection.objects.link(cam)
    scene.camera = cam
    scene.render.engine = "BLENDER_EEVEE"
    scene.view_settings.view_transform = "Standard"
    scene.render.resolution_x, scene.render.resolution_y = 300, 380
    for name, act in ACTIONS.items():
        use_action(act)
        n = int(act.frame_range[1])
        for k, f in enumerate((0, n // 3, 2 * n // 3, n)):
            scene.frame_set(f)
            t = Vector((0, 0, 1.0))
            # 投手方向（-Y）往回看，和比賽的打擊鏡頭差不多；打擊動作另外從捕手方向看
            for tag, off in (("p", (1.2, -3.2, 0.6)), ("c", (1.4, 3.0, 0.6))):
                cam.location = t + Vector(off)
                cam.rotation_euler = (t - cam.location).to_track_quat("-Z", "Y").to_euler()
                scene.render.filepath = os.path.join(PREVIEW, f"{name}_{k}_{tag}.png")
                bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(cam)
    bpy.data.objects.remove(sun)

# ════════ 匯出 ════════
arm.animation_data.action = None
for name, act in ACTIONS.items():
    tr = arm.animation_data.nla_tracks.new()
    tr.name = name
    st = tr.strips.new(name, 0, act)
    st.name = name
for pb in pbs:
    pb.matrix_basis = Matrix.Identity(4)
for o in scene.objects:
    o.select_set(o in (arm, body, cap, bat))
bpy.context.view_layer.objects.active = arm
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_image_format="JPEG", export_image_quality=92,
                          export_animations=True, export_animation_mode="NLA_TRACKS", export_skins=True, export_vertex_color="ACTIVE")
print("已匯出:", OUT, os.path.getsize(OUT), "bytes")
