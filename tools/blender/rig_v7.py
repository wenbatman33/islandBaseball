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
TRIS = int(os.environ.get("RIG_TRIS", 12000))
PRO = os.environ.get("RIG_PRO") == "1"
for o in scene.objects:
    o.select_set(o is body)
bpy.context.view_layer.objects.active = body
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.mesh.remove_doubles(threshold=1e-5)
bpy.ops.object.mode_set(mode="OBJECT")
tris0 = sum(len(p.vertices) - 2 for p in body.data.polygons)
# 臉、頭盔和胸前的隊名是最常被近看的地方，減面時優先保留；省下的面數從褲子、背部這些大片平滑的區域拿
keep = body.vertex_groups.new(name="_keep")
_zs = [v.co.z for v in body.data.vertices]
_h = max(_zs) - min(_zs)
for v in body.data.vertices:
    z, y = (v.co.z - min(_zs)) / _h, v.co.y
    w = 1.0 if z > 0.82 else (0.6 if 0.62 < z < 0.78 and y < -0.04 else 0.0)
    if w:
        keep.add([v.index], w, "REPLACE")
dec = body.modifiers.new("dec", "DECIMATE")
dec.ratio = min(1.0, TRIS / tris0)
dec.use_collapse_triangulate = True
dec.vertex_group = "_keep"
dec.invert_vertex_group = True  # 這個修改器的權重越高減得越多，反轉後才是「權重高的保留」
dec.vertex_group_factor = 8.0
while body.modifiers[0] != dec:
    bpy.ops.object.modifier_move_up(modifier=dec.name)
bpy.ops.object.modifier_apply(modifier=dec.name)
print(f"減面 {tris0} → {sum(len(p.vertices) - 2 for p in body.data.polygons)} 三角形")
_top = max(v.co.z for v in body.data.vertices)
print("頭部三角形", sum(1 for p in body.data.polygons if p.center.z > _top * 0.82))
body.vertex_groups.remove(body.vertex_groups["_keep"])
# ════════ 修正腿的關節：Meshy 自動綁定把髖關節放在胯下下方（0.78 m）、膝蓋高了約 10 公分（0.59 m），
# 腿會在大腿中段彎曲、大腿上半黏在骨盆上。移到模型實際的位置後，用 Blender 依骨頭重新計算腿部的皮膚權重 ════════
LEG_FIX = {"hip": 0.88, "knee": 0.49, "ankle": 0.13}  # 高度（公尺，身高 1.903 m 的模型）


def leg_center(z0, z1, side):
    """模型在這個高度範圍、這一側的腿的截面中心（x, y）。"""
    pts = [body.matrix_world @ v.co for v in body.data.vertices]
    sel = [p for p in pts if z0 < p.z < z1 and p.x * side > 0.025 and abs(p.x) < 0.3]
    xs = sorted(p.x for p in sel)
    ys = sorted(p.y for p in sel)
    return Vector((xs[len(xs) // 2], (ys[0] + ys[-1]) / 2))


# 正規流程的模型（RIG_PRO=1）：關節已照真人比例對位、權重從基礎人體轉印，不要再搬關節或重算權重
if not PRO:
    for o in scene.objects:
        o.select_set(o is arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    ebs = arm.data.edit_bones
    for side, s in ((1, "Left"), (-1, "Right")):
        j = {}
        for k, z in LEG_FIX.items():
            c = leg_center(z - 0.03, z + 0.03, side)
            j[k] = Vector((c.x, c.y, z))
        up, lg, ft = ebs[P + s + "UpLeg"], ebs[P + s + "Leg"], ebs[P + s + "Foot"]
        print(f"{s} 髖 {up.head.z:.3f}→{j['hip'].z:.3f}  膝 {lg.head.z:.3f}→{j['knee'].z:.3f}  踝 {ft.head.z:.3f}→{j['ankle'].z:.3f}")
        up.head, up.tail = j["hip"], j["knee"]
        lg.head, lg.tail = j["knee"], j["ankle"]
        ft.head = j["ankle"]
    bpy.ops.object.mode_set(mode="OBJECT")

    # 腿部權重：在一份複製的網格上算 Blender 的自動權重（依骨頭位置），只把腿和臀部那些頂點換過來
    LEG_BONES = {P + s + b for s in ("Left", "Right") for b in ("UpLeg", "Leg", "Foot", "ToeBase", "Toe_End")}
    tmp = body.copy()
    tmp.data = body.data.copy()
    scene.collection.objects.link(tmp)
    tmp.modifiers.clear()
    tmp.parent = None
    for g in list(tmp.vertex_groups):
        tmp.vertex_groups.remove(g)
    for o in scene.objects:
        o.select_set(o in (tmp, arm))
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")
    names_b = {g.index: g.name for g in body.vertex_groups}
    names_t = {g.index: g.name for g in tmp.vertex_groups}
    replaced = 0
    for v, vt in zip(body.data.vertices, tmp.data.vertices):
        z = (body.matrix_world @ v.co).z
        if z > LEG_FIX["hip"] + 0.1:
            continue  # 腰部以上維持 Meshy 的權重
        auto = {names_t[g.group]: g.weight for g in vt.groups if g.weight > 0.01}
        if not any(n in LEG_BONES for n in auto):
            continue  # 這一點不是腿（例如垂在大腿旁的手）
        # 腰帶附近（髖關節以上）逐漸由原本的權重過渡到新的
        k = min(1.0, max(0.0, (LEG_FIX["hip"] + 0.1 - z) / 0.12))
        old = {names_b[g.group]: g.weight for g in v.groups}
        new = {}
        for n, w in old.items():
            new[n] = new.get(n, 0) + w * (1 - k)
        for n, w in auto.items():
            new[n] = new.get(n, 0) + w * k
        tot = sum(new.values()) or 1
        for g in list(v.groups):
            body.vertex_groups[names_b[g.group]].remove([v.index])
        for n, w in new.items():
            if w / tot < 0.01:
                continue
            if n not in body.vertex_groups:
                body.vertex_groups.new(name=n)
            body.vertex_groups[n].add([v.index], w / tot, "REPLACE")
        replaced += 1
    bpy.data.objects.remove(tmp)
    print(f"腿部權重重算：{replaced} 個頂點")


# 手指權重：Meshy 的手指黏在一起雕，權重也亂（小指第 2、3 節帶到指根、無名指第 3 節帶到手指中段），
# 彎手指時網格不會沿關節折。改成依「沿手指方向的距離」分到 手掌／第 1／2／3 節（關節前後 1 公分過渡），
# 左右位置決定屬於哪根手指；大拇指維持 Meshy 原本的權重
def poly_dist(p, pts):
    best = 9.0
    for a, b in zip(pts, pts[1:]):
        ab = b - a
        t = min(1.0, max(0.0, (p - a).dot(ab) / max(ab.length_squared, 1e-9)))
        best = min(best, (a + ab * t - p).length)
    return best


def fix_fingers(blend=0.01):
    bones = arm.data.bones
    count = 0
    for s in ("Left", "Right"):
        hp = bones[P + s + "Hand"].head_local
        lat = (bones[P + s + "HandIndex1"].head_local - bones[P + s + "HandPinky1"].head_local).normalized()
        fwd = bones[P + s + "HandMiddle1"].head_local - hp
        fwd = (fwd - lat * fwd.dot(lat)).normalized()
        chains = {}
        for f in ("Index", "Middle", "Ring", "Pinky"):
            js = [(bones[P + s + f"Hand{f}{j}"].head_local - hp).dot(fwd) for j in (1, 2, 3)]
            chains[f] = ((bones[P + s + f"Hand{f}1"].head_local - hp).dot(lat), js)
        mine = {g.index for g in body.vertex_groups if g.name.startswith(P + s + "Hand")}
        lines = {}
        for f in ("Index", "Middle", "Ring", "Pinky", "Thumb"):
            js_ = [bones[P + s + f"Hand{f}{j}"] for j in (1, 2, 3)]
            lines[f] = [b.head_local for b in js_] + [js_[-1].tail_local]
            if f != "Thumb":
                lines[f] = [hp + (lines[f][0] - hp) * 0.6] + lines[f]  # 從手掌中段開始
        for v in body.data.vertices:
            if not v.groups:
                continue
            dom = max(v.groups, key=lambda g: g.weight)
            dn = body.vertex_groups[dom.group].name
            if dom.group not in mine:
                continue
            pw = body.matrix_world @ v.co
            # 離哪一根手指的骨頭折線最近就歸哪根（Meshy 把不少四指的點綁到大拇指，大拇指幾乎不彎，那些點就一直翹著）
            f = min(lines, key=lambda k: poly_dist(pw, lines[k]))
            if f == "Thumb":
                continue  # 真的是大拇指：維持原本
            d = pw - hp
            a = d.dot(fwd)
            js = chains[f][1]
            if a < js[0] - blend and dn == P + s + "Hand":
                continue  # 手掌、手腕：維持原本（含和前臂的過渡）
            u = [min(1.0, max(0.0, (a - j + blend) / (2 * blend))) for j in js]
            u = [1.0] + u + [0.0]
            segs = [P + s + "Hand"] + [P + s + f"Hand{f}{j}" for j in (1, 2, 3)]
            new = {n: u[k] - u[k + 1] for k, n in enumerate(segs) if u[k] - u[k + 1] > 0.01}
            for g in list(v.groups):
                body.vertex_groups[g.group].remove([v.index])
            tot = sum(new.values())
            for n, w in new.items():
                if n not in body.vertex_groups:
                    body.vertex_groups.new(name=n)
                body.vertex_groups[n].add([v.index], w / tot, "REPLACE")
            count += 1
    print(f"手指權重重算：{count} 個頂點")


if not PRO:
    fix_fingers()
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
BLEND = {"crouch": ("ready", 0.45)}  # 動作名: (混合的另一個動作, 原動作佔的比例)

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
CURL = {1: 80, 2: 100, 3: 75}
THUMB_CURL = 45


def curl_axes():
    """Meshy 的手指骨頭軸向每根都不同（食指與小指的 X 軸差 90°），不能一律繞 X 彎。
    改成依手心方向替每一節算彎曲軸：手心法線 N 朝身體內側，軸 = 骨頭方向 × N，正轉時指尖往手心捲"""
    bones = arm.data.bones
    axes = {}
    for s in ("Left", "Right"):
        hand = bones[P + s + "Hand"].head_local
        lat = (bones[P + s + "HandIndex1"].head_local - bones[P + s + "HandPinky1"].head_local).normalized()
        fwd = bones[P + s + "HandMiddle1"].y_axis.normalized()
        n = fwd.cross(lat).normalized()
        if n.x * -hand.x < 0:  # 手心朝身體中線
            n = -n
        for nm in [f for f in FINGERS + THUMBS if f.startswith(s)]:
            b = bones[P + nm]
            r = b.matrix_local.to_3x3()
            a = r.col[1].normalized().cross(n)
            if a.length < 1e-4:
                continue
            axes[nm] = (r.inverted() @ a).normalized()
    return axes


CURL_AXES = curl_axes()


def grip_fingers():
    for n in FINGERS:
        pb = pbs[P + n]
        q = Quaternion(CURL_AXES[n], math.radians(CURL[int(n[-1])]))
        pb.rotation_quaternion = pb.rotation_quaternion @ q
    for n in THUMBS:
        pb = pbs[P + n]
        pb.rotation_quaternion = pb.rotation_quaternion @ Quaternion(CURL_AXES[n], math.radians(THUMB_CURL))


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
BAT_PREV = None
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
    global BAT_PREV
    bpy.context.view_layer.update()
    W = lambda n: pbs[P + n].head
    D = None
    if BAT_HOLD is not None:
        G, D = BAT_HOLD
        q = (BAT_REST @ Vector((0, 1, 0))).rotation_difference(D)
        bat_pb.matrix = Matrix.Translation(G) @ (q.to_matrix() @ BAT_REST).to_4x4()
        return
    if name in BATTING:
        # 真人動作的雙手本來就握在同一根球棒上：球棒方向＝下面那隻手（左手）的握點指向上面那隻手（右手）的握點
        gl = (W("LeftHand") + W("LeftHandMiddle1")) / 2
        gr = (W("RightHand") + W("RightHandMiddle1")) / 2
        v = gr - gl
        if v.length > 0.02:
            D = v.normalized()
            if BAT_PREV is not None:
                D = BAT_PREV.slerp(D, 0.5) if BAT_PREV.dot(D) > -0.9 else D  # 稍微平滑，動作捕捉的手腕會有細小抖動
            BAT_PREV = D.copy()
    if D is None:
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
    global BAT_PREV
    BAT_PREV = None
    if src_name.startswith("pose_"):
        frames = fielding_frames(src_name[5:])
    elif src_name.startswith("cmu"):
        frames = sample_cmu(t0, t1, CMU_MORE.get(src_name))
    else:
        frames = sample(SRC_ACT[src_name], t0, t1)
    if name in BLEND:
        # 和另一個動作混合：AI 生成的「蹲低」是坐到腳跟上的全蹲，守備員接滾地球只會半蹲，
        # 所以每根骨頭取「守備預備」和「全蹲」之間的姿勢（骨盆高度之後由踩地修正重新對齊）
        other, w = BLEND[name]
        fo = sample(SRC_ACT[other], None, None)
        mixed = []
        for i, (basis, hm) in enumerate(frames):
            ob, ohm = fo[min(i, len(fo) - 1)]
            nb = {}
            for k, m in basis.items():
                if k not in ob:
                    nb[k] = m
                    continue
                q = ob[k].to_quaternion().slerp(m.to_quaternion(), w)
                nm = q.to_matrix().to_4x4()
                nm.translation = ob[k].translation.lerp(m.translation, w)
                nb[k] = nm
            nh = ohm.to_quaternion().slerp(hm.to_quaternion(), w).to_matrix().to_4x4()
            nh.translation = ohm.translation.lerp(hm.translation, w)
            mixed.append((nb, nh))
        frames = mixed
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
        # 腳踩地：腿的關節修正過、長度比例和動作原本的骨架不同，骨盆高度要重新對齊，讓較低的那隻腳貼地
        bpy.context.view_layer.update()
        drop = min(pbs[P + s + b].head.z - REST[P + s + b].translation.z for s in ("Left", "Right") for b in ("Foot", "ToeBase"))
        M.translation.z -= drop
        hips.matrix = M
        t_src = (t0 or 0) + (i if not pingpong or i < (len(frames) + 2) // 2 else len(frames) - i) / FPS
        global BAT_HOLD
        BAT_HOLD = None
        if name in BATTING:
            grip_fingers()
            if src_name == "cmu":
                widen_stance(name, t_src - (t0 or 0))
                hold_bat(name, t_src - (t0 or 0))
            else:
                apply_adjust(name, t_src)
                place_hands(name, t_src)
        place_bat(name, t_src)
        for pb in pbs:
            pb.keyframe_insert("rotation_quaternion", frame=i)
            pb.keyframe_insert("location", frame=i)
    print(f"動作 {name}：{n} 格（{(n - 1) / FPS:.2f} 秒），轉向 {yaw}°")
    return act


# ════════ CMU 真人動作捕捉（124_07「Baseball Swing」，CMU 開放資料，可用於商業專案）重新對應到我們的骨架 ════════
# 打擊改用這段真人拿球棒錄下的動作：AI 不懂球棒，生成的揮棒雙手會分開，還得鏡射、手動拼接
CMU_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "art", "mocap", "124_07.bvh")
CMU_MAP = {"Hips": "Hips", "LowerBack": "Spine", "Spine": "Spine1", "Spine1": "Spine2", "Neck": "Neck", "Head": "Head"}
for s in ("Left", "Right"):
    for b in ("Shoulder", "Arm", "ForeArm", "Hand", "UpLeg", "Leg", "Foot", "ToeBase"):
        CMU_MAP[s + b] = s + b
# CMU 的靜止姿勢是 T 字、我們是 A 字：手腳先把靜止方向對齊，再套用旋轉（軀幹本來就都朝上，不用對齊）
ALIGN = {s + b for s in ("Left", "Right") for b in ("Shoulder", "Arm", "ForeArm", "Hand", "UpLeg", "Leg", "Foot", "ToeBase")}

before = set(scene.objects)
bpy.ops.import_anim.bvh(filepath=CMU_FILE, global_scale=1.0, use_fps_scale=True, update_scene_fps=False,
                        update_scene_duration=False, axis_forward="-Z", axis_up="Y", rotate_mode="NATIVE")
cmu = next(o for o in scene.objects if o not in before)
cmu.name = "cmu_src"
CW = cmu.matrix_world.copy()
CW3 = CW.to_3x3().normalized()


def _bone_dir(M, b):
    return ((M @ b.tail_local) - (M @ b.head_local)).normalized()


SRC_REST = {s: (CW3 @ cmu.data.bones[s].matrix_local.to_3x3()).normalized().to_quaternion() for s in CMU_MAP}
ALIGNED = {}
for s, t in CMU_MAP.items():
    q = REST[P + t].to_3x3().normalized().to_quaternion()
    if t in ALIGN:
        q = _bone_dir(Matrix.Identity(4), arm.data.bones[P + t]).rotation_difference(_bone_dir(CW, cmu.data.bones[s])) @ q
    ALIGNED[P + t] = (s, q)
scene.frame_set(1)  # 第 1 格是 T 字站姿：用它的骨盆高度算兩邊的比例（靜止姿勢的骨盆在原點，不能用）
CMU_K = REST_HIPS.z / (CW @ cmu.pose.bones["Hips"].head).z

# 同一位受試者的其他真人動作（骨架相同，靜止姿勢與比例都沿用上面的）：124_01 是完整的投球
CMU_MORE = {}
for _key, _file in {"cmu_pitch": "124_01.bvh"}.items():
    _before = set(scene.objects)
    bpy.ops.import_anim.bvh(filepath=os.path.join(os.path.dirname(CMU_FILE), _file), global_scale=1.0, use_fps_scale=True,
                            update_scene_fps=False, update_scene_duration=False, axis_forward="-Z", axis_up="Y", rotate_mode="NATIVE")
    CMU_MORE[_key] = next(o for o in scene.objects if o not in _before)
    CMU_MORE[_key].name = _key


def sample_cmu(t0, t1, src=None):
    frames = []
    n = int(round((t1 - t0) * FPS))
    for i in range(n + 1):
        f = 1 + (t0 + i / FPS) * FPS  # 匯入時已換算成每秒 30 格，第 1 格是 0 秒
        scene.frame_set(int(math.floor(f)), subframe=f - math.floor(f))
        cp = (src or cmu).pose.bones
        M, basis = {}, {}
        for n_ in ORDER:
            p = PARENT[n_]
            local = REST[n_] if p is None else REST[p].inverted() @ REST[n_]
            pm = Matrix.Identity(4) if p is None else M[p]
            base = pm @ local
            if n_ in ALIGNED:
                s, q_al = ALIGNED[n_]
                q_pose = (CW3 @ cp[s].matrix.to_3x3()).normalized().to_quaternion()
                W = q_pose @ SRC_REST[s].inverted() @ q_al
                pos = (CW @ cp[s].head) * CMU_K if n_ == P + "Hips" else base.translation
                M[n_] = Matrix.Translation(pos) @ W.to_matrix().to_4x4()
            else:
                M[n_] = base
            basis[n_] = local.inverted() @ pm.inverted() @ M[n_]
        frames.append((basis, M[P + "Hips"]))
    return frames


# ── 雙手握棒：這位受試者預備時兩手相距約 28 公分（可能沒有真的握棒），所以身體、手肘方向用真人資料，
#    兩手用手臂反推收攏到同一根球棒上。握點＝真人兩手的中點（路徑是真的），球棒角度照揮棒節奏指定 ──
# (揮棒片段內的秒數, 相對胸口的方向)：+X 角色左手邊、-Y 胸前、+Z 上；右打者的後肩在 -X
CMU_BAT = {
    "stance": [(0.0, (-0.45, 0.3, 0.84))],
    "swing": [(0.0, (-0.45, 0.3, 0.84)), (0.3, (-0.5, 0.38, 0.78)), (0.5, (-0.65, 0.4, 0.64)), (0.6, (-0.85, 0.2, 0.3)),
              (0.8, (0.2, -0.95, 0.25)), (0.95, (0.75, 0.4, 0.5)), (1.15, (0.75, 0.45, 0.5))],
}
CONTACT = 0.67  # 擊球：球棒水平掃過本壘板上方（用場地方向指定，不跟胸口的傾斜走）
BAT_TILT = (0.65, 0.3)  # 預備球棒：往背後斜多少、往捕手斜多少（相對垂直 0.85）
STANCE_HIGH = (0.20, 0.25, 1.0)  # 預備握點：比後肩關節高多少、往本壘方向離身體多遠（手和胸口之間留空間）、拉過去的比例


def cmu_bat_dir(name, t):
    keys = CMU_BAT[name]
    if t <= keys[0][0] or len(keys) == 1:
        v = Vector(keys[0][1]).normalized()
    elif t >= keys[-1][0]:
        v = Vector(keys[-1][1]).normalized()
    else:
        i = max(j for j, k in enumerate(keys) if k[0] <= t)
        (ta, a), (tb, b) = keys[i], keys[i + 1]
        u = (t - ta) / (tb - ta)
        u = u * u * (3 - 2 * u)
        a, b = Vector(a).normalized(), Vector(b).normalized()
        v = a.slerp(b, u) if a.dot(b) > -0.95 else a.lerp(b, u).normalized()
    C = pbs[CHEST].matrix.to_3x3() @ CHEST_REST.inverted()
    v = (C @ v).normalized()
    if name == "swing":
        wa, wb = Vector((-0.9, 0.35, 0.05)).normalized(), Vector((-0.45, -0.88, 0.15)).normalized()
        u = min(1.0, max(0.0, (t - CONTACT) / 0.08))
        wv = wa.slerp(wb, u * u * (3 - 2 * u))
        k = min(1.0, max(0.0, (t - (CONTACT - 0.08)) / 0.06)) * min(1.0, max(0.0, (CONTACT + 0.18 - t) / 0.08))
        k = k * k * (3 - 2 * k)
        v = v.slerp(wv, k) if v.dot(wv) > -0.95 else v.lerp(wv, k).normalized()
    return v


BAT_HOLD = None  # (握點, 方向)：給 place_bat 用


def stance_weight(name, t):
    """預備姿勢的調整有多少比例：預備整段 1，揮棒開始 0.3 秒內平順降到 0"""
    if name == "stance":
        return 1.0
    if t >= 0.3:
        return 0.0
    k = 1 - t / 0.3
    return k * k * (3 - 2 * k)


STANCE_WIDE = (0.09, 0.035)  # 預備：兩腳各沿投手方向往外移幾公尺、骨盆再降幾公尺（膝蓋多彎一點）


def ik_leg(side, T, pole):
    up, lo, ft = pbs[P + side + "UpLeg"], pbs[P + side + "Leg"], pbs[P + side + "Foot"]
    L1 = (REST[P + side + "Leg"].translation - REST[P + side + "UpLeg"].translation).length
    L2 = (REST[P + side + "Foot"].translation - REST[P + side + "Leg"].translation).length
    S = up.head.copy()
    dv = T - S
    dist = min(max(dv.length, abs(L1 - L2) + 0.01), L1 + L2 - 0.003)
    dn = dv.normalized()
    a = (L1 * L1 - L2 * L2 + dist * dist) / (2 * dist)
    h = math.sqrt(max(0.0, L1 * L1 - a * a))
    pv = pole - dn * pole.dot(dn)
    pv = pv.normalized() if pv.length > 1e-5 else Vector((-1, 0, 0))
    E = S + dn * a + pv * h
    q = (lo.head - S).normalized().rotation_difference((E - S).normalized())
    up.matrix = Matrix.Translation(S) @ (q.to_matrix() @ up.matrix.to_3x3()).to_4x4()
    bpy.context.view_layer.update()
    q = (ft.head - lo.head).normalized().rotation_difference((S + dn * dist - lo.head).normalized())
    lo.matrix = Matrix.Translation(lo.head.copy()) @ (q.to_matrix() @ lo.matrix.to_3x3()).to_4x4()
    bpy.context.view_layer.update()


# ════════ 守備姿勢：照內野手的標準姿勢直接擺關節（AI 生成的守備預備是歪一邊的弓箭步、蹲低是坐到腳跟的全蹲） ════════
#   drop 骨盆下降；lean 上身前傾角度；wide 每隻腳往外移；hands 左右手腕位置（相對兩腳中點的地面：+X 左、-Y 前、+Z 上）
#   守備預備：雙腳比肩寬、膝蓋彎、重心在前腳掌、雙手放在膝蓋前方
#   蹲低（接滾地球）：臀部壓低、背打平、手套伸到身體前方貼近地面、另一手在手套上方準備蓋球
FIELD_POSE = {
    "ready": dict(drop=0.17, lean=30, wide=0.14, hands={"Left": (0.22, -0.36, 0.60), "Right": (-0.22, -0.36, 0.60)}),
    "crouch": dict(drop=0.36, lean=58, wide=0.22, hands={"Left": (0.06, -0.52, 0.20), "Right": (-0.10, -0.46, 0.32)}),
}


def _turn(pb, deg):
    """骨頭繞自己的根部、沿骨架的 X 軸轉（正值往前傾）。"""
    h = pb.head.copy()
    pb.matrix = Matrix.Translation(h) @ Matrix.Rotation(math.radians(deg), 4, "X") @ Matrix.Translation(-h) @ pb.matrix
    bpy.context.view_layer.update()


def fielding_frames(kind, n=90):
    c = FIELD_POSE[kind]
    frames = []
    for i in range(n):
        for pb in pbs:
            pb.matrix_basis = Matrix.Identity(4)
        bpy.context.view_layer.update()
        breath = math.sin(2 * math.pi * i / (n - 1))  # 輕微起伏，頭尾相接
        feet = {s: REST[P + s + "Foot"].translation.copy() for s in ("Left", "Right")}
        mid = (feet["Left"] + feet["Right"]) / 2
        # 骨盆：往下、往後坐，並前傾（前傾的四成在骨盆，其餘分給脊椎）
        M = hips.matrix.copy()
        M.translation = REST_HIPS + Vector((0, c["drop"] * 0.55, -c["drop"] + 0.006 * breath))
        hips.matrix = M
        bpy.context.view_layer.update()
        _turn(hips, c["lean"] * 0.4)
        for b in ("Spine", "Spine1", "Spine2"):
            _turn(pbs[P + b], c["lean"] * 0.2 + 0.4 * breath)
        _turn(pbs[P + "Neck"], -c["lean"] * 0.45)  # 抬頭看前方
        _turn(pbs[P + "Head"], -c["lean"] * 0.3)
        # 腳：往外站開，腳掌維持貼地；膝蓋朝前並略往外
        for s, sign in (("Left", 1), ("Right", -1)):
            T = feet[s] + Vector((sign * c["wide"], 0, 0))
            ik_leg(s, T, Vector((sign * 0.45, -1, 0)).normalized())
            ft = pbs[P + s + "Foot"]
            ft.matrix = Matrix.Translation(ft.head.copy()) @ (Matrix.Rotation(math.radians(sign * 14), 3, "Z") @ REST[P + s + "Foot"].to_3x3()).to_4x4()
            bpy.context.view_layer.update()
        # 手：手肘朝外、略往後
        for s, sign in (("Left", 1), ("Right", -1)):
            T = Vector((mid.x, mid.y, 0)) + Vector(c["hands"][s])
            ik_arm(s, T, Vector((sign * 0.8, 0.45, -0.1)).normalized())
        bpy.context.view_layer.update()
        frames.append(({pb.name: pb.matrix_basis.copy() for pb in pbs}, hips.matrix.copy()))
    return frames


def widen_stance(name, t):
    """職業打者的預備：兩腳比肩膀寬、膝蓋朝腳尖方向往外彎、重心壓低。用腿的 IK 把腳往外移，腳掌維持原本貼地的方向"""
    k = stance_weight(name, t)
    if k <= 0:
        return
    bpy.context.view_layer.update()
    W = lambda n: pbs[P + n].head.copy()
    line = W("LeftFoot") - W("RightFoot")  # 後腳→前腳（朝投手）
    line.z = 0
    line.normalize()
    keep = {s: (W(s + "Foot"), pbs[P + s + "Foot"].matrix.to_3x3().copy(), W(s + "ToeBase")) for s in ("Left", "Right")}
    M = hips.matrix.copy()
    M.translation.z -= STANCE_WIDE[1] * k
    hips.matrix = M
    bpy.context.view_layer.update()
    for s, sign in (("Left", 1), ("Right", -1)):
        foot, rot, toe = keep[s]
        T = foot + line * (sign * STANCE_WIDE[0] * k)
        fwd = toe - foot
        fwd.z = 0
        pole = (fwd.normalized() + line * sign * 0.6).normalized()  # 膝蓋朝腳尖、稍微往外
        ik_leg(s, T, pole)
        ft = pbs[P + s + "Foot"]
        ft.matrix = Matrix.Translation(ft.head.copy()) @ rot.to_4x4()
        bpy.context.view_layer.update()


def hold_bat(name, t):
    global BAT_HOLD
    bpy.context.view_layer.update()
    W = lambda n: pbs[P + n].head.copy()
    G = (W("LeftHand") + W("RightHand") + W("LeftHandMiddle1") + W("RightHandMiddle1")) / 4
    k = stance_weight(name, t)
    sdir = (W("RightShoulder") - W("LeftShoulder")).normalized()  # 往後肩（捕手）那側
    if k > 0:
        # 握點在後肩上方、離頭盔約一個頭寬（影片裡職業打者的位置），揮棒開始 0.3 秒內回到真人動作的軌跡
        chest_fwd = Vector((0, 0, 1)).cross(sdir).normalized()  # 胸口朝向（本壘）
        ear = W("RightArm") + Vector((0, 0, STANCE_HIGH[0])) + chest_fwd * STANCE_HIGH[1] + sdir * 0.04
        G = G.lerp(ear, k * STANCE_HIGH[2])
    D = cmu_bat_dir(name, t)
    if k > 0:
        # 預備時球棒往打者背後（遠離本壘）、稍微往捕手斜過頭頂，和影片裡職業打者一樣
        cf = Vector((0, 0, 1)).cross(sdir).normalized()
        tilt = (Vector((0, 0, 0.85)) - cf * BAT_TILT[0] + sdir * BAT_TILT[1]).normalized()
        D = D.lerp(tilt, k).normalized()
    poles = {}
    for side in ("Right", "Left"):
        S, E, H = W(side + "Arm"), W(side + "ForeArm"), W(side + "Hand")
        ax = (H - S).normalized()
        pv = (E - S) - ax * (E - S).dot(ax)  # 真人手肘偏向的方向
        poles[side] = pv.normalized() if pv.length > 1e-4 else Vector((0, 0, -1))
    if k > 0:
        # 預備時後手肘抬高、往外張（職業打者的後手臂接近水平）
        up = (sdir * 0.7 + Vector((0, 0, 0.7))).normalized()
        poles["Right"] = poles["Right"].lerp(up, k * 0.8).normalized()
        # 前手肘朝地、稍微朝本壘：前上臂垂在胸前、前臂往上接到手，兩手臂成 V 字
        fwd = Vector((0, 0, 1)).cross(sdir).normalized()  # 胸口朝向（本壘）
        down = (Vector((0, 0, -0.7)) + fwd * 0.7).normalized()  # 往下也往本壘，前手臂離開胸口
        poles["Left"] = poles["Left"].lerp(down, k * 0.9).normalized()
    for side, along in (("Right", 0.05), ("Left", -0.04)):  # 右手在上
        P0 = G + D * along
        pole = poles[side]
        # 手掌轉向包住球棒：食指那側朝棒頭、指頭方向垂直球棒，並盡量順著真人前臂的方向（決定手繞球棒轉多少）
        Lr, Fr, Nr, Hr = HAND_REST[side]
        fa = W(side + "Hand") - W(side + "ForeArm")
        g = fa - D * fa.dot(D)
        g = g.normalized() if g.length > 1e-4 else (pole - D * pole.dot(D)).normalized()
        B0 = Matrix((Lr, Fr, Lr.cross(Fr))).transposed()
        B1 = Matrix((D, g, D.cross(g))).transposed()
        R = B1 @ B0.transposed()
        # 拳心：彎好的中指四個關節點的中心（換成手骨頭自己的座標），讓球棒穿過這裡，手腕往回推
        ha = pbs[P + side + "Hand"]
        mids = [pbs[P + side + f"HandMiddle{j}"].head for j in (1, 2, 3)] + [pbs[P + side + "HandMiddle3"].tail]
        ofs = ha.matrix.inverted() @ (sum(mids, Vector()) / 4)
        wrist = P0 - (R @ Hr) @ ofs
        ik_arm(side, wrist, pole)
        ha.matrix = Matrix.Translation(ha.head.copy()) @ (R @ Hr).to_4x4()
        bpy.context.view_layer.update()
    BAT_HOLD = (G - D * 0.09, D)


# 手的靜止方向（骨架座標）：L 小指→食指、F 手腕→指頭、N 手心朝向
HAND_REST = {}
for _s in ("Left", "Right"):
    _b = arm.data.bones
    _L = (_b[P + _s + "HandIndex1"].head_local - _b[P + _s + "HandPinky1"].head_local).normalized()
    _F = _b[P + _s + "HandMiddle1"].head_local - _b[P + _s + "Hand"].head_local
    _F = (_F - _L * _F.dot(_L)).normalized()
    _N = _F.cross(_L)
    if _N.x * -_b[P + _s + "Hand"].head_local.x < 0:
        _N = -_N
    HAND_REST[_s] = (_L, _F, _N, _b[P + _s + "Hand"].matrix_local.to_3x3())


# 打擊兩段：預備（雙手穩定在後肩的那一段，來回播放成循環）、揮棒（抬腳 → 跨步 → 2.87 秒擊球 → 收棒）
CLIPS["stance"] = ("cmu", 0.8, 2.2, 0, "none", True)
CLIPS["swing"] = ("cmu", 2.2, 3.35, 0, "keep", False)
# 投球、傳球維持原本的動作（CLIPS 最上面的設定）。試過改用真人投球 124_01（"cmu_pitch"，2.2～4.0 秒、轉向 -6°），
# 使用者比較後選擇原本的版本，所以不覆蓋
CLIPS["ready"] = ("pose_ready", None, None, 0, "none", False)
CLIPS["crouch"] = ("pose_crouch", None, None, 0, "none", False)
BLEND = {}
MIRROR = set()
ADJUST_W = {}  # 真人動作不需要手動修正姿勢

for pb in pbs:
    pb.rotation_mode = "QUATERNION"
ACTIONS = {name: build(name, spec) for name, spec in CLIPS.items()}
bpy.data.objects.remove(cmu)
for _o in CMU_MORE.values():
    bpy.data.objects.remove(_o)

# ════════ 3. 球棒網格（綁在 bat 骨頭上） ════════
BAT_LEN = 1.05  # 卡通比例的打者（頭大）配真實長度的球棒看起來太短、也掃不到本壘板外側，加長
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
# 帽子、頭盔直接做在身上的模型（RIG_NO_CAP=1）不切帽子：每種角色各用自己的模型，不需要換帽子
cap = None if os.environ.get("RIG_NO_CAP") == "1" else split_cap(body, 1.64)
mark_regions(body)


# 打擊手套區域（頂點顏色 B）：手腕往指頭方向的手掌與手指。遊戲裡打者整隻手換成手套顏色，也蓋掉黏在一起的手指
def mark_gloves(ob):
    """頂點顏色 B＝1：手（打擊手套）。護腕不在這裡標：網格太疏、畫出來鋸齒狀，改由遊戲著色器依靜止位置逐像素算"""
    attr = ob.data.color_attributes["region"]
    side_of = {}
    for s in ("Left", "Right"):
        for g in ob.vertex_groups:
            if g.name.startswith(P + s + "Hand") or g.name == P + s + "ForeArm":
                side_of[g.index] = s
    info = {}
    for s in ("Left", "Right"):
        hb = arm.data.bones[P + s + "Hand"]
        fa = arm.data.bones[P + s + "ForeArm"]
        fwd = (arm.data.bones[P + s + "HandMiddle1"].head_local - hb.head_local).normalized()
        ax = (hb.head_local - fa.head_local).normalized()
        info[s] = (hb.head_local, fwd, ax)
    region = {}
    for v in ob.data.vertices:
        if not v.groups:
            continue
        dom = max(v.groups, key=lambda g: g.weight)
        if dom.group not in side_of:
            continue
        s = side_of[dom.group]
        hp, fwd, ax = info[s]
        d = ob.matrix_world @ v.co - hp
        hand_w = sum(g.weight for g in v.groups if g.group in side_of and ob.vertex_groups[g.group].name.startswith(P + s + "Hand"))
        if hand_w >= 0.5 and d.dot(fwd) > -0.015:
            region[v.index] = 1.0
            continue
    for p in ob.data.polygons:
        for li in p.loop_indices:
            k = region.get(ob.data.loops[li].vertex_index)
            if k is not None:
                c = attr.data[li].color
                attr.data[li].color = (c[0], c[1], k, 1.0)
    print(f"打擊手套區域：{len(region)} 個頂點")


mark_gloves(body)

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
