"""把角色設定圖（正面／側面／背面）轉成 3D 模型並算出預覽圖。第 3 版：加強頭部。

做法：
  1. 以背景色差切出三個視角的輪廓，去掉腳下的影子。
  2. 頭部先把耳朵等細小突出物從輪廓分開，頭顱本身才會是圓的。
  3. 正面輪廓逐列取出每一段的寬度，深度參考側面輪廓，疊成橢圓截面後連成立體（充氣）。
  4. 體素重建把各部位融合成一張連續表面，再平滑。
  5. 貼圖：正面／背面依法線方向投影；表面越斜越改用模糊後的底色，避免細節被拉長；
     頭部正側面使用側面圖（耳朵、鬢角、帽子側面）。

執行：
  /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python sheet_to_model.py -- <輸出資料夾>
"""
import math
import os
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.normpath(os.path.join(HERE, "..", "..", "public", "models", "_候選預覽", "concept-player-sheet.png"))
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = argv[0] if argv else os.path.join(HERE, "out_sheet")
os.makedirs(OUT, exist_ok=True)
HEIGHT = 1.72  # 角色總高（公尺）
NECK = 0.615  # 脖子高度佔總高的比例（以上算頭部）

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
COL = scene.collection


# ════════ 1. 讀圖、切輪廓 ════════
def load_rgb(path):
    img = bpy.data.images.load(path)
    w, h = img.size
    buf = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(buf)
    return buf.reshape(h, w, 4)[::-1, :, :3] * 255.0  # 第一列在最上面


def dilate(m, k):
    p = np.pad(m, k + 1)
    out = p.copy()
    for dy in range(-k, k + 1):
        for dx in range(-k, k + 1):
            out |= np.roll(np.roll(p, dy, 0), dx, 1)
    return out[k + 1:-k - 1, k + 1:-k - 1]


def erode(m, k):
    return ~dilate(~m, k)


rgb = load_rgb(SRC)
H, W, _ = rgb.shape
corners = np.concatenate([rgb[:24, :24].reshape(-1, 3), rgb[:24, -24:].reshape(-1, 3)])
bg = np.median(corners, axis=0)
mask = np.sqrt(((rgb - bg) ** 2).sum(axis=2)) > 26
mask = dilate(erode(mask, 1), 1)
mask = erode(dilate(mask, 2), 2)

cols = mask.sum(axis=0) > 3
figs, start = [], None
for x in range(W):
    if cols[x] and start is None:
        start = x
    if (not cols[x] or x == W - 1) and start is not None:
        if x - start > 60:
            figs.append((start, x))
        start = None
assert len(figs) >= 3, "找不到三個視角"


def crop(x0, x1):
    sub = mask[:, x0:x1]
    rows = np.where(sub.sum(axis=1) > 2)[0]
    y0, y1 = rows[0], rows[-1] + 1
    m = sub[y0:y1].copy()
    c = rgb[y0:y1, x0:x1].copy()
    # 腳下的接觸陰影：最底部 10% 內「低彩度、偏亮的灰」不算身體
    h = m.shape[0]
    lum = c.mean(axis=2)
    sat = c.max(axis=2) - c.min(axis=2)
    shadow = (sat < 18) & (lum > 112) & (lum < 215)
    shadow[: int(h * 0.9)] = False
    m &= ~shadow
    m = erode(dilate(m, 3), 3)
    m = dilate(erode(m, 2), 2)
    keep = np.where(m.sum(axis=1) > 6)[0]
    return m[: keep[-1] + 1], c[: keep[-1] + 1]


front_m, front_c = crop(*figs[0])
side_m, side_c = crop(*figs[1])
back_m, back_c = crop(*figs[2])
Hf, Wf = front_m.shape
Hs, Ws = side_m.shape
Hb, Wb = back_m.shape
sf, ss, sb = HEIGHT / Hf, HEIGHT / Hs, HEIGHT / Hb


def runs_of(row, min_w=3):
    d = np.diff(np.concatenate([[0], row.astype(np.int8), [0]]))
    a = np.where(d == 1)[0]
    b = np.where(d == -1)[0]
    return [(int(x0), int(x1)) for x0, x1 in zip(a, b) if x1 - x0 >= min_w]


def axis_of(m):
    """用頭部那幾列的中心當作身體中軸。"""
    h = m.shape[0]
    cs = []
    for r in range(int(h * 0.12), int(h * 0.3)):
        rr = runs_of(m[r])
        if rr:
            widest = max(rr, key=lambda t: t[1] - t[0])
            cs.append((widest[0] + widest[1]) / 2)
    return float(np.median(cs))


ax_f = axis_of(front_m)
ax_b = axis_of(back_m)
ext = []
for r in range(int(Hs * 0.42), int(Hs * 0.56)):
    xs = np.where(side_m[r])[0]
    if len(xs):
        ext.append((xs[0] + xs[-1]) / 2)
ax_s = float(np.median(ext))

# ════════ 2. 頭部：把耳朵等突出物分開，並在側面圖找出耳朵位置 ════════
neck_row = int(Hf * (1 - NECK))
R_OPEN = max(6, int(round(0.024 / sf)))
opened = dilate(erode(front_m, R_OPEN), R_OPEN) & front_m
front_body = front_m.copy()
front_body[:neck_row] = opened[:neck_row]
front_bits = front_m & ~front_body  # 耳朵、帽頂釦、髮梢等


def label(m):
    """簡易連通區域標記，回傳 [(面積, 中心x, 中心y, 像素座標陣列)]，由大到小。"""
    seen = np.zeros_like(m)
    out = []
    hh, ww = m.shape
    for y0, x0 in zip(*np.where(m)):
        if seen[y0, x0]:
            continue
        stack = [(y0, x0)]
        seen[y0, x0] = True
        pts = []
        while stack:
            y, x = stack.pop()
            pts.append((y, x))
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                ny, nx = y + dy, x + dx
                if 0 <= ny < hh and 0 <= nx < ww and m[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    stack.append((ny, nx))
        p = np.array(pts)
        out.append((len(pts), p[:, 1].mean(), p[:, 0].mean(), p))
    return sorted(out, key=lambda t: -t[0])


skin_ref = np.median(front_c[int(Hf * 0.30):int(Hf * 0.33), int(ax_f) - 12:int(ax_f) + 12].reshape(-1, 3), axis=0)
r0, r1 = int(Hs * 0.14), int(Hs * 0.37)
skin_side = (np.sqrt(((side_c[r0:r1] - skin_ref) ** 2).sum(axis=2)) < 52) & side_m[r0:r1]
skin_side = dilate(erode(skin_side, 1), 1)
blobs = label(skin_side)
face_blob = blobs[0]
# 耳朵的前後位置：正面圖中耳朵所在的高度，對到側面圖同一高度上「最靠後的那段膚色」
head_half_px = max((x1 - x0) / 2 for r in range(0, neck_row) for (x0, x1) in runs_of(front_body[r]))
ear_rows = [r for r in range(0, neck_row)
            if any(abs((x0 + x1) / 2 - ax_f) > head_half_px * 0.8 for (x0, x1) in runs_of(front_bits[r], min_w=2))
            and HEIGHT * 0.66 < (Hf - r) * sf < HEIGHT * 0.84]
skin_full = (np.sqrt(((side_c - skin_ref) ** 2).sum(axis=2)) < 52) & side_m
ear_xs = []
for r in ear_rows:
    rs = min(Hs - 1, int(round(Hs - (Hf - r) * sf / ss)))
    rr = [t for t in runs_of(skin_full[rs], min_w=5)]
    if len(rr) >= 2:  # 至少有耳朵和臉兩段膚色時，最靠後的那段才是耳朵
        ear_xs.append((rr[0][0] + rr[0][1]) / 2)
Y_EAR = -(float(np.median(ear_xs)) - ax_s) * ss if ear_xs else 0.02
print(f"膚色 {skin_ref.round()}｜耳朵所在列數 {len(ear_rows)}｜側面圖耳朵位置 {'y=%.3f m（%d 列有效）' % (Y_EAR, len(ear_xs)) if ear_xs else '未偵測到，用預設 0.02'}")


# ════════ 3. 貼圖：外擴、抹除、模糊 ════════
def pad_fill(c, m, erase=None):
    """把輪廓外的像素填成鄰近的輪廓內顏色。erase 為要抹掉重填的區域。"""
    col = c.copy()
    filled = erode(m, 2)
    if erase is not None:
        filled &= ~erase
    col[~filled] = 0
    for _ in range(70):
        f = filled.astype(np.float32)[..., None]
        s = np.zeros_like(col)
        n = np.zeros(filled.shape + (1,), dtype=np.float32)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)):
            s += np.roll(np.roll(col * f, dy, 0), dx, 1)
            n += np.roll(np.roll(f, dy, 0), dx, 1)
        new = (~filled) & (n[..., 0] > 0)
        col[new] = (s / np.maximum(n, 1))[new]
        filled = filled | new
    return col


def box_blur(a, r, passes=3):
    out = a.astype(np.float64)
    k = 2 * r + 1
    for _ in range(passes):
        for axis in (0, 1):
            padw = [(0, 0)] * out.ndim
            padw[axis] = (r, r)
            p = np.pad(out, padw, mode="edge")
            c = np.cumsum(p, axis=axis)
            zero = np.zeros_like(np.take(c, [0], axis=axis))
            c = np.concatenate([zero, c], axis=axis)
            n = out.shape[axis]
            out = (np.take(c, range(k, k + n), axis=axis) - np.take(c, range(0, n), axis=axis)) / k
    return out.astype(np.float32)


def save_tex(col, name):
    h, w, _ = col.shape
    img = bpy.data.images.new(name, w, h, alpha=False)
    flat = np.ones((h, w, 4), dtype=np.float32)
    flat[..., :3] = np.clip(col[::-1] / 255.0, 0, 1)
    img.pixels.foreach_set(flat.reshape(-1))
    path = os.path.join(OUT, name + ".png")
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    return path


BLUR_R = 20
front_p = pad_fill(front_c, front_m)
back_p = pad_fill(back_c, back_m)
# 側面貼圖只負責耳朵、頭髮、帽子側面：把臉上的深色五官抹掉，交給正面圖
erase = np.zeros_like(side_m)
fy, fx = face_blob[3][:, 0] + r0, face_blob[3][:, 1]
bx0 = int(fx.min() + (fx.max() - fx.min()) * 0.3)
box = (slice(int(fy.min()), int(fy.max()) + 1), slice(bx0, Ws))
erase[box] = side_c[box].mean(axis=2) < 150
erase = dilate(erase, 3)
side_p = pad_fill(side_c, side_m, erase)
TEX = {
    "front": save_tex(front_p, "tex_front"),
    "back": save_tex(back_p, "tex_back"),
    "side": save_tex(side_p, "tex_side"),
    "front_blur": save_tex(box_blur(front_p, BLUR_R), "tex_front_blur"),
    "back_blur": save_tex(box_blur(back_p, BLUR_R), "tex_back_blur"),
    "side_blur": save_tex(box_blur(side_p, BLUR_R), "tex_side_blur"),
}


# ════════ 4. 依輪廓充氣成立體 ════════
def side_depth(z):
    """高度 z 處，側面輪廓的前後範圍（世界座標 y，前方為負）。側面圖的人物面向右。"""
    r = min(Hs - 1, max(0, int(round(Hs - z / ss))))
    xs = np.where(side_m[r])[0]
    if not len(xs):
        return -0.05, 0.05
    return -(xs[-1] - ax_s) * ss, -(xs[0] - ax_s) * ss


N = 40
EXP = 2.4
comps = {}
STEP = 2
head_half = max((x1 - x0) / 2 for r in range(0, neck_row) for (x0, x1) in runs_of(front_body[r])) * sf
for r in range(0, Hf, STEP):
    z = (Hf - r) * sf
    yf, yb = side_depth(z)
    yc, ry = (yf + yb) / 2, max(0.012, (yb - yf) / 2)
    rr = runs_of(front_body[r])
    central = [t for t in rr if t[0] <= ax_f <= t[1]]
    for (x0, x1) in rr:
        xc = ((x0 + x1) / 2 - ax_f) * sf
        rx = (x1 - x0) / 2 * sf
        if central and (x0, x1) == central[0]:
            comps.setdefault("body", []).append((z, xc, rx, yc, ry))
        elif central:
            name = "armL" if xc < 0 else "armR"
            comps.setdefault(name, []).append((z, xc, rx, 0.0, rx * 0.72))
        else:
            name = "legL" if xc < 0 else "legR"
            d = ry if z < 0.13 else min(ry, rx * 1.25)
            comps.setdefault(name, []).append((z, xc, rx, yc, d))
    # 頭部的突出物：耳朵放在側面圖偵測到的前後位置，其餘跟著側面輪廓
    if r < neck_row:
        for (x0, x1) in runs_of(front_bits[r], min_w=2):
            xc = ((x0 + x1) / 2 - ax_f) * sf
            rx = (x1 - x0) / 2 * sf
            is_ear = abs(xc) > head_half * 0.8 and HEIGHT * 0.66 < z < HEIGHT * 0.84
            name = ("ear" if is_ear else "bit") + ("L" if xc < 0 else "R")
            if is_ear:
                continue  # 耳朵由側面圖畫在頭的側面，不另外做凸塊（位置對不準時會浮在臉旁）
            else:
                comps.setdefault(name, []).append((z, xc, rx, yc, min(ry, max(0.012, rx * 1.3))))

bm = bmesh.new()


def ring(z, xc, rx, yc, ry):
    vs = []
    e = 2.0 if z > HEIGHT * NECK else EXP  # 頭部用正橢圓
    for i in range(N):
        t = 2 * math.pi * i / N
        c, s = math.cos(t), math.sin(t)
        x = xc + rx * math.copysign(abs(c) ** (2 / e), c)
        y = yc + ry * math.copysign(abs(s) ** (2 / e), s)
        vs.append(bm.verts.new((x, y, z)))
    return vs


for name, rows in comps.items():
    rows.sort(key=lambda t: -t[0])
    seg, segs = [rows[0]], []
    for prev, cur in zip(rows, rows[1:]):
        if prev[0] - cur[0] > sf * STEP * 2.5:
            segs.append(seg)
            seg = []
        seg.append(cur)
    segs.append(seg)
    built = 0
    for seg in segs:
        if len(seg) < 3:
            continue
        loops = [ring(*row) for row in seg]
        for a, b in zip(loops, loops[1:]):
            for i in range(N):
                j = (i + 1) % N
                bm.faces.new([a[i], a[j], b[j], b[i]])
        bm.faces.new(loops[0])
        bm.faces.new(list(reversed(loops[-1])))
        built += 1
    print(f"{name}: {len(rows)} 列, {built} 段")

bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
mesh = bpy.data.meshes.new("player")
bm.to_mesh(mesh)
bm.free()
obj = bpy.data.objects.new("player", mesh)
COL.objects.link(obj)

rm = obj.modifiers.new("remesh", "REMESH")
rm.mode = "VOXEL"
rm.voxel_size = 0.0065
rm.use_smooth_shade = True
sm = obj.modifiers.new("smooth", "SMOOTH")
sm.factor = 0.6
sm.iterations = 12

# ════════ 5. 投影貼圖 ════════
mat = bpy.data.materials.new("projected")
mat.use_nodes = True
nt = mat.node_tree
bsdf = nt.nodes["Principled BSDF"]
coord = nt.nodes.new("ShaderNodeTexCoord")
sep = nt.nodes.new("ShaderNodeSeparateXYZ")
nt.links.new(coord.outputs["Object"], sep.inputs[0])
geo = nt.nodes.new("ShaderNodeNewGeometry")
nsep = nt.nodes.new("ShaderNodeSeparateXYZ")
nt.links.new(geo.outputs["Normal"], nsep.inputs[0])


def mnode(op, a, b=None, clamp=False):
    n = nt.nodes.new("ShaderNodeMath")
    n.operation = op
    n.use_clamp = clamp
    for idx, v in enumerate((a, b)):
        if v is None:
            continue
        if isinstance(v, (int, float)):
            n.inputs[idx].default_value = v
        else:
            nt.links.new(v, n.inputs[idx])
    return n.outputs[0]


def smooth_range(value, lo, hi):
    n = nt.nodes.new("ShaderNodeMapRange")
    n.interpolation_type = "SMOOTHSTEP"
    nt.links.new(value, n.inputs["Value"])
    n.inputs["From Min"].default_value = lo
    n.inputs["From Max"].default_value = hi
    n.inputs["To Min"].default_value = 0.0
    n.inputs["To Max"].default_value = 1.0
    return n.outputs["Result"]


def mix_color(fac, a, b):
    m = nt.nodes.new("ShaderNodeMix")
    m.data_type = "RGBA"
    nt.links.new(fac, m.inputs["Factor"])
    nt.links.new(a, m.inputs["A"])
    nt.links.new(b, m.inputs["B"])
    return m.outputs["Result"]


def uv(axis, scale_u, offset_u, scale_v):
    mu = nt.nodes.new("ShaderNodeMath")
    mu.operation = "MULTIPLY_ADD"
    mu.inputs[1].default_value = scale_u
    mu.inputs[2].default_value = offset_u
    nt.links.new(sep.outputs[axis], mu.inputs[0])
    mv = nt.nodes.new("ShaderNodeMath")
    mv.operation = "MULTIPLY"
    mv.inputs[1].default_value = scale_v
    nt.links.new(sep.outputs["Z"], mv.inputs[0])
    comb = nt.nodes.new("ShaderNodeCombineXYZ")
    nt.links.new(mu.outputs[0], comb.inputs[0])
    nt.links.new(mv.outputs[0], comb.inputs[1])
    return comb.outputs[0]


def tex(path, vec):
    t = nt.nodes.new("ShaderNodeTexImage")
    t.image = bpy.data.images.load(path)
    t.extension = "EXTEND"
    nt.links.new(vec, t.inputs["Vector"])
    return t.outputs["Color"]


def view_color(key, vec, facing):
    """某個視角的顏色：正對時用清晰貼圖，越斜越換成模糊的底色，避免細節被拉長。"""
    t = smooth_range(facing, 0.3, 0.62)
    # 只有頭部做模糊替換；身體（四肢）維持清晰貼圖
    t = mnode("SUBTRACT", 1.0, mnode("MULTIPLY", mnode("SUBTRACT", 1.0, t), HEAD_MASK))
    return mix_color(t, tex(TEX[key + "_blur"], vec), tex(TEX[key], vec))


NECK_Z = HEIGHT * NECK
HEAD_MASK = smooth_range(sep.outputs["Z"], NECK_Z, NECK_Z + 0.05)
uv_f = uv("X", 1 / (sf * Wf), ax_f / Wf, 1 / (sf * Hf))
uv_b = uv("X", -1 / (sb * Wb), ax_b / Wb, 1 / (sb * Hb))
uv_s = uv("Y", -1 / (ss * Ws), ax_s / Ws, 1 / (ss * Hs))  # 側面圖的人物面向右
# 只看水平方向的斜度：把法線的 X、Y 分量正規化（朝上或朝下的表面，例如帽簷下方，不算斜面）
nx_raw, ny_raw = nsep.outputs["X"], nsep.outputs["Y"]
hlen = mnode("SQRT", mnode("ADD", mnode("ADD", mnode("MULTIPLY", nx_raw, nx_raw), mnode("MULTIPLY", ny_raw, ny_raw)), 1e-6))
ny = mnode("DIVIDE", ny_raw, hlen)
abs_nx = mnode("ABSOLUTE", mnode("DIVIDE", nx_raw, hlen))
col_f = view_color("front", uv_f, mnode("MULTIPLY", ny, -1.0))
col_b = view_color("back", uv_b, ny)
col_s = view_color("side", uv_s, abs_nx)
fac_fb = smooth_range(ny, -0.12, 0.12)
# 側面圖只用在頭部且接近正側面的地方（身體側面的手臂位置和 A 字站姿不同）
side_w = mnode("MULTIPLY", smooth_range(abs_nx, 0.62, 0.82), HEAD_MASK)
color_out = mix_color(side_w, mix_color(fac_fb, col_f, col_b), col_s)
nt.links.new(color_out, bsdf.inputs["Base Color"])
bsdf.inputs["Roughness"].default_value = 0.85
for key in ("Emission Color", "Emission"):
    if key in bsdf.inputs:
        nt.links.new(color_out, bsdf.inputs[key])
        break
bsdf.inputs["Emission Strength"].default_value = 0.55
obj.data.materials.append(mat)

# ════════ 6. 場景與算圖 ════════
gm = bpy.data.materials.new("ground")
gm.use_nodes = True
gm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.55, 0.56, 0.6, 1)
gm.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 1.0
gb = bmesh.new()
bmesh.ops.create_grid(gb, x_segments=1, y_segments=1, size=12)
gmesh = bpy.data.meshes.new("ground")
gb.to_mesh(gmesh)
gb.free()
ground = bpy.data.objects.new("ground", gmesh)
COL.objects.link(ground)
ground.data.materials.append(gm)

world = bpy.data.worlds.new("world")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.74, 0.75, 0.78, 1)
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.45
scene.world = world

rig = bpy.data.objects.new("light_rig", None)
COL.objects.link(rig)


def area(name, loc, energy, size):
    data = bpy.data.lights.new(name, "AREA")
    data.energy = energy
    data.size = size
    ob = bpy.data.objects.new(name, data)
    COL.objects.link(ob)
    ob.location = loc
    ob.parent = rig
    ob.rotation_euler = (Vector((0, 0, 0.95)) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()


area("key", (-2.6, -4.2, 4.2), 200, 3.5)
area("fill", (3.6, -3.0, 2.0), 70, 4.5)
area("rim", (0.5, 4.2, 3.6), 120, 3.0)

cam_data = bpy.data.cameras.new("cam")
cam = bpy.data.objects.new("cam", cam_data)
COL.objects.link(cam)
scene.camera = cam
for name in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
    try:
        scene.render.engine = name
        break
    except Exception:
        continue
try:
    scene.eevee.taa_render_samples = 48
except Exception:
    pass
scene.view_settings.view_transform = "Standard"
scene.render.image_settings.file_format = "PNG"


def shoot(name, angle_deg, res=(900, 1200), aim=0.88, scale=2.0, elev=0.0):
    a = math.radians(angle_deg)
    rig.rotation_euler = (0, 0, a)
    dist = 7.0
    pos = Vector((math.sin(a) * dist, -math.cos(a) * dist, aim + elev))
    cam.location = pos
    cam.rotation_euler = (Vector((0, 0, aim)) - pos).to_track_quat("-Z", "Y").to_euler()
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = scale
    scene.render.resolution_x, scene.render.resolution_y = res
    scene.render.filepath = os.path.join(OUT, name)
    bpy.ops.render.render(write_still=True)


for ang in (0, 25, 45, 60, 90, 135, 180):
    shoot(f"body_{ang:03d}.png", ang)
for ang in (0, 25, 45, 60, 75, 90):
    shoot(f"head_{ang:03d}.png", ang, res=(800, 800), aim=1.4, scale=0.82, elev=0.6)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, "player_from_sheet.blend"))
print("完成")
