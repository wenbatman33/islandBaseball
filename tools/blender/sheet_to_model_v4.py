"""把角色設定圖（正面／側面／背面）轉成 3D 模型並算出預覽圖。第 4 版：帽子獨立建模、耳朵做成實體。

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


T_CAP = 0.012  # 帽子布料厚度（頭顱比帽冠內縮這麼多）
TB = 0.02  # 帽簷厚度


def fill_holes(m):
    """把被包住的洞（帽徽）填滿。"""
    out = np.zeros_like(m)
    out[0, :] = out[-1, :] = out[:, 0] = out[:, -1] = True
    out &= ~m
    for i in range(4000):
        g = out | np.roll(out, 1, 0) | np.roll(out, -1, 0) | np.roll(out, 1, 1) | np.roll(out, -1, 1)
        g &= ~m
        if i % 16 == 0 and (g == out).all():
            break
        out = g
    return ~out


def cap_mask(c, m):
    """帽子＝頭部範圍內偏綠的像素（含帽徽）。"""
    k = (c[..., 1] - np.maximum(c[..., 0], c[..., 2]) > 7) & m
    k[int(m.shape[0] * 0.30):] = False
    k = erode(dilate(k, 4), 4)
    k = fill_holes(k)
    k = dilate(erode(k, 2), 2)
    return k & m


cap_f, cap_s, cap_b = cap_mask(front_c, front_m), cap_mask(side_c, side_m), cap_mask(back_c, back_m)
side_nocap = side_m & ~dilate(cap_s, 2)

# 正面：帽簷拱形中央的最低點
band = cap_f[:, int(ax_f) - 10:int(ax_f) + 10].sum(axis=1) > 10
r_arch = int(np.where(band)[0][-1])
r_captop_f = int(np.where(cap_f.sum(axis=1) > 3)[0][0])
# 側面：帽子每列的前緣／後緣、帽簷尖端、帽簷從帽冠伸出的那一列
rows_s = np.where(cap_s.sum(axis=1) > 3)[0]
fx = np.full(Hs, -1.0)
bxs = np.full(Hs, -1.0)
for r in rows_s:
    xs = np.where(cap_s[r])[0]
    fx[r], bxs[r] = xs[-1], xs[0]
x_tip = fx.max()
r_tip = int(np.mean([r for r in rows_s if fx[r] >= x_tip - 4]))
# 帽簷尖端以上、拱形最低點以上，輪廓內全部都是帽子（帽徽貼到邊緣時遮罩會斷掉，這裡補齊）
cap_s[:r_tip] = side_m[:r_tip]
cap_f[:r_arch - 2] = front_m[:r_arch - 2]
side_nocap = side_m & ~dilate(cap_s, 2)
rows_s = np.where(cap_s.sum(axis=1) > 3)[0]
for r in rows_s:
    xs = np.where(cap_s[r])[0]
    fx[r], bxs[r] = xs[-1], xs[0]
rs_bot = int(rows_s[-1])
# 帽冠前緣＝帽簷下方那段臉／瀏海的前緣再往外一層布料（帽簷和帽冠的輪廓是連續的，無法從轉折判斷）
r_under = int(max(r for r in rows_s if fx[r] > x_tip - 40))  # 帽簷底面最低的一列
face_fx = []
for r in range(r_under + 4, r_under + 50):
    nc = np.where(side_nocap[r])[0]
    if len(nc) >= 8:
        face_fx.append(nc[-1])
X_CROWN = float(np.percentile(face_fx, 60)) + T_CAP / ss + 3
r_bt = int(next(r for r in rows_s if fx[r] >= X_CROWN))
fx_bt = X_CROWN


def crown_fx(r):
    """帽冠（不含帽簷）在側面圖第 r 列的前緣。"""
    return min(fx[r], X_CROWN)


z_bt = (Hs - r_bt) * ss  # 帽簷上緣接到帽冠的高度
z_tip = (Hs - r_tip) * ss
y_tip = -(x_tip - ax_s) * ss
z_fr = z_bt - 0.03  # 帽冠前緣下擺
y_fr = -(X_CROWN - ax_s) * ss
z_br = (Hs - rs_bot) * ss  # 帽冠後緣下擺
y_br = -(bxs[rs_bot] - ax_s) * ss
print(f"帽子：簷接點列 {r_bt} 尖端列 {r_tip} 後緣列 {rs_bot}｜z_bt={z_bt:.3f} z_tip={z_tip:.3f} y_tip={y_tip:.3f} y_fr={y_fr:.3f} z_br={z_br:.3f} y_br={y_br:.3f}")


def rim_z(y):
    """帽冠下擺所在的斜面（前高後低）。"""
    return z_fr + (z_br - z_fr) * (y - y_fr) / (y_br - y_fr)


# 膚色：正面與側面各取頭部膚色的中位數，把側面圖的色調對齊正面圖
skin_ref = np.median(front_c[int(Hf * 0.30):int(Hf * 0.33), int(ax_f) - 12:int(ax_f) + 12].reshape(-1, 3), axis=0)
r0, r1 = int(Hs * 0.14), int(Hs * 0.37)
skin_side = (np.sqrt(((side_c[r0:r1] - skin_ref) ** 2).sum(axis=2)) < 52) & side_m[r0:r1]
skin_side = dilate(erode(skin_side, 1), 1)
blobs = label(skin_side)
face_blob = blobs[0]
fskin = (np.sqrt(((front_c[:neck_row] - skin_ref) ** 2).sum(axis=2)) < 52) & front_m[:neck_row]
gain = np.median(front_c[:neck_row][fskin], axis=0) / np.maximum(1, np.median(side_c[r0:r1][skin_side], axis=0))
print("側面圖膚色校正倍率", gain.round(3))
side_c = np.clip(side_c * gain, 0, 255)

# 耳朵：輪廓外緣是膚色的那幾列就是耳朵；頭本身的輪廓在這段平滑內收，外側多出來的才是耳朵
def skin_px(r, x):
    return float(np.sqrt(((front_c[r, x] - skin_ref) ** 2).sum())) < 60


def edge_x(r, sgn):
    rr = [t for t in runs_of(front_m[r]) if t[0] <= ax_f <= t[1]]
    if not rr:
        return None
    return rr[0][0] if sgn < 0 else rr[0][1] - 1


ears = {}
ear_range = None
for sgn, key in ((-1, "L"), (1, "R")):
    def half_w(r):
        x = edge_x(r, sgn)
        return None if x is None else abs(x - ax_f)

    def edge_is_skin(r):
        x = edge_x(r, sgn)
        if x is None:
            return False
        return sum(skin_px(r, x - sgn * k) for k in range(3, 9)) >= 4

    top = next((r for r in range(r_arch, neck_row - 8) if all(edge_is_skin(r + k) for k in range(4))), None)
    if top is None:
        continue
    bot = next((r + 6 for r in range(top + 8, neck_row - 8) if half_w(r + 6) < half_w(r) - 14), top + int(0.085 / sf))
    r_a, r_b = top - 3, min(neck_row - 1, bot + 4)
    w_a, w_b = half_w(r_a), half_w(r_b)
    em = np.zeros_like(front_m)
    for r in range(r_a, r_b + 1):
        t = (r - r_a) / (r_b - r_a)
        w = w_a + (w_b - w_a) * (t * t * (3 - 2 * t))
        xe = int(round(ax_f + sgn * w))
        if sgn < 0:
            em[r, :xe] = front_body[r, :xe]
            front_body[r, :xe] = False
        else:
            em[r, xe + 1:] = front_body[r, xe + 1:]
            front_body[r, xe + 1:] = False
    ears[key] = np.argwhere(em)
    ear_range = ear_range or (top, bot)
    print(f"耳朵 {key}：列 {top}–{bot}，頭寬 {w_a:.0f}→{w_b:.0f} px，耳朵像素 {len(ears[key])}")
front_bits = front_m & ~front_body
head_half_px = max((x1 - x0) / 2 for r in range(0, neck_row) for (x0, x1) in runs_of(front_body[r]))
head_half = head_half_px * sf
skin_full = (np.sqrt(((side_c - skin_ref) ** 2).sum(axis=2)) < 52) & side_m
ear_c, ear_w = [], []
if ear_range:
    for r in range(ear_range[0] + 4, ear_range[1] - 4):
        rs = min(Hs - 1, int(round(Hs - (Hf - r) * sf / ss)))
        rr = runs_of(skin_full[rs], min_w=5)
        if len(rr) >= 2:
            ear_c.append((rr[0][0] + rr[0][1]) / 2)
            ear_w.append((rr[0][1] - rr[0][0]) / 2)
Y_EAR = -(float(np.median(ear_c)) - ax_s) * ss if ear_c else 0.03
EAR_RY = float(np.median(ear_w)) * ss if ear_w else 0.04
print(f"耳朵：正面找到 {list(ears)}｜側面有效列 {len(ear_c)}｜y={Y_EAR:.3f} 前後半徑={EAR_RY:.3f}")


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
face_y, face_x = face_blob[3][:, 0] + r0, face_blob[3][:, 1]
bx0 = int(face_x.min() + (face_x.max() - face_x.min()) * 0.3)
box = (slice(int(face_y.min()), int(face_y.max()) + 1), slice(bx0, Ws))
s_lum = side_c.mean(axis=2)
s_dark = (s_lum < 110) & side_m & ~cap_s
s_dark[:r0] = False
s_dark[r1:] = False
s_near_cap = dilate(cap_s, 4)
feat_s = np.zeros_like(side_m)
for area_px, cx, cy, pts in label(s_dark):
    # 沒連到帽子、又在臉前半部的深色塊＝眼睛、眉毛、嘴（頭髮都連到帽子，保留原本的輪廓）
    if cx > bx0 and not s_near_cap[pts[:, 0], pts[:, 1]].any():
        feat_s[pts[:, 0], pts[:, 1]] = True
s_dist = np.sqrt(((side_c - skin_ref) ** 2).sum(axis=2))
light = np.zeros_like(side_m)
light[box] = (s_dist[box] > 34) & (s_lum[box] >= 110)  # 眼白、反光
erase = dilate(feat_s, 6) | (light & dilate(feat_s, 30) & side_m)
erase = dilate(erase, 2)
side_p = pad_fill(side_c, side_m, erase)
# 頭（帽子底下）用的貼圖：把帽子抹掉，用旁邊的頭髮／膚色補上
# 耳朵內側那一條（鬢角、耳朵輪廓線）貼到頭側會被拉成長條，先抹掉用旁邊的顏色補
ear_all = np.zeros_like(front_m)
for pts in ears.values():
    ear_all[pts[:, 0], pts[:, 1]] = True
strip = dilate(ear_all, 12) & front_m & ~ear_all
front_h = pad_fill(front_c, front_m, strip)
back_h = pad_fill(back_c, back_m)
side_h = pad_fill(side_c, side_m, erase)
# 帽子底下是頭髮：直接填頭髮的顏色
hsel = (front_c[:neck_row].mean(axis=2) < 50) & front_m[:neck_row] & ~cap_f[:neck_row]
hair_rgb = np.median(front_c[:neck_row][hsel], axis=0)
front_h[dilate(cap_f, 3)] = hair_rgb
back_h[dilate(cap_b, 3)] = hair_rgb
side_h[dilate(cap_s, 3)] = hair_rgb
# 模糊底色用的正面圖：先把五官（眼睛、眉毛、嘴）抹成膚色，否則臉側會糊出灰色的眼睛殘影
f_lum = front_c[:neck_row].mean(axis=2)
f_sat = front_c[:neck_row].max(axis=2) - front_c[:neck_row].min(axis=2)
dark = (f_lum < 110) & front_m[:neck_row] & ~cap_f[:neck_row]
near_cap = dilate(cap_f, 4)[:neck_row]
feat = np.zeros_like(front_m)
for area_px, cx, cy, pts in label(dark):
    if not near_cap[pts[:, 0], pts[:, 1]].any():  # 沒有連到帽子的深色塊＝五官（頭髮都連到帽子）
        feat[pts[:, 0], pts[:, 1]] = True
feat = dilate(feat, 7)
white = np.zeros_like(front_m)
white[:neck_row] = (f_sat < 30) & (f_lum > 185) & front_m[:neck_row] & ~cap_f[:neck_row]
feat |= dilate(white, 3) & dilate(feat, 25)
front_soft = pad_fill(front_h, front_m, feat)
front_soft[dilate(cap_f, 3)] = hair_rgb
TEX_HEAD = {
    "front_soft": save_tex(box_blur(front_soft, BLUR_R + 8), "texh_front_soft"),
    "back_soft": save_tex(box_blur(back_h, BLUR_R + 8), "texh_back_soft"),
    "side_soft": save_tex(box_blur(side_h, BLUR_R), "texh_side_soft"),
    "front": save_tex(front_h, "texh_front"),
    "back": save_tex(back_h, "texh_back"),
    "side": save_tex(side_h, "texh_side"),
    "front_blur": save_tex(box_blur(front_soft, BLUR_R), "texh_front_blur"),
    "back_blur": save_tex(box_blur(back_h, BLUR_R), "texh_back_blur"),
    "side_blur": save_tex(box_blur(side_h, BLUR_R), "texh_side_blur"),
}
# 檢查用：帽子遮罩與量到的位置
dbg = side_c.copy()
dbg[cap_s] = dbg[cap_s] * 0.5 + np.array([255, 0, 0]) * 0.5
for r in rows_s:
    dbg[r, int(crown_fx(r)) - 1:int(crown_fx(r)) + 2] = (255, 255, 0)
dbg[r_tip - 1:r_tip + 2, int(x_tip) - 12:] = (0, 255, 255)
if ear_c:
    ex = int(np.median(ear_c))
    dbg[:, ex - 1:ex + 1][int(Hs * 0.2):int(Hs * 0.36)] = (255, 0, 255)
save_tex(dbg, "dbg_side")
dbg = front_c.copy()
dbg[cap_f] = dbg[cap_f] * 0.5 + np.array([255, 0, 0]) * 0.5
dbg[front_bits] = (255, 0, 255)
dbg[r_arch - 1:r_arch + 1] = (255, 255, 0)
save_tex(dbg, "dbg_front")
TEX = {
    "front_soft": save_tex(box_blur(front_p, BLUR_R), "tex_front_soft"),
    "back_soft": save_tex(box_blur(back_p, BLUR_R), "tex_back_soft"),
    "side_soft": save_tex(box_blur(side_p, BLUR_R), "tex_side_soft"),
    "front": save_tex(front_p, "tex_front"),
    "back": save_tex(back_p, "tex_back"),
    "side": save_tex(side_p, "tex_side"),
    "front_blur": save_tex(box_blur(front_p, BLUR_R), "tex_front_blur"),
    "back_blur": save_tex(box_blur(back_p, BLUR_R), "tex_back_blur"),
    "side_blur": save_tex(box_blur(side_p, BLUR_R), "tex_side_blur"),
}


# 設定圖解析度偏低（頭只有三百多像素寬），貼圖先放大兩倍並稍微銳化，邊緣才不會有鋸齒
import subprocess
UPSCALE = """
import sys
from PIL import Image, ImageFilter
for p in sys.argv[1:]:
    im = Image.open(p).convert('RGB')
    im = im.resize((im.width * 2, im.height * 2), Image.LANCZOS)
    if '_blur' not in p and '_soft' not in p:
        im = im.filter(ImageFilter.UnsharpMask(radius=2.2, percent=90, threshold=2))
    im.save(p)
"""
subprocess.run(["/usr/bin/env", "python3", "-c", UPSCALE] + sorted(set(TEX.values()) | set(TEX_HEAD.values())), check=True)

# ════════ 4. 依輪廓充氣成立體 ════════
def side_depth(z):
    """高度 z 處頭／身體的前後範圍（世界座標 y，前方為負）。有帽子的列，回傳帽子底下的頭顱。"""
    r = min(Hs - 1, max(0, int(round(Hs - z / ss))))
    xs = np.where(side_m[r])[0]
    if not len(xs):
        return -0.05, 0.05
    xf, xb = float(xs[-1]), float(xs[0])
    tf = tb = 0.0
    if cap_s[r].any():
        nc = np.where(side_nocap[r])[0]
        if len(nc) >= 8 and r > r_under:  # 帽簷底面以下才是露出來的臉；以上一律用帽冠前緣，額頭才不會一階一階的
            xf = float(nc[-1])  # 帽簷下方露出的瀏海／臉
        else:
            xf, tf = float(crown_fx(r)), T_CAP
        if cap_s[r, int(xb):int(xb) + 4].any():
            tb = T_CAP
    return -(xf - ax_s) * ss + tf, -(xb - ax_s) * ss - tb


EAR_SPANS = [(int(p[:, 0].min()), int(p[:, 0].max())) for p in ears.values()]
N = 40
EXP = 2.4
comps = {}
crown_rows = []
STEP = 2
z_captop = (Hf - np.where(front_body.sum(axis=1) > 3)[0][0]) * sf
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
            if r < neck_row and (cap_f[r, x0:x0 + 5].any() or cap_f[r, x1 - 5:x1].any()):
                rx -= T_CAP  # 帽子底下的頭顱
            if r < neck_row and z >= z_br - 0.03:
                crown_rows.append((z, xc, rx + T_CAP, yc, ry + T_CAP))
            if z > z_captop - T_CAP * 1.5:
                continue  # 頭頂留給帽冠
            comps.setdefault("body", []).append((z, xc, rx, yc, ry))
        elif central:
            name = "armL" if xc < 0 else "armR"
            comps.setdefault(name, []).append((z, xc, rx, 0.0, rx * 0.72))
        else:
            name = "legL" if xc < 0 else "legR"
            d = ry if z < 0.13 else min(ry, rx * 1.25)
            comps.setdefault(name, []).append((z, xc, rx, yc, d))
    # 頭部的突出物（髮梢）；帽頂釦另外做，耳朵在下面做
    if r < neck_row:
        for (x0, x1) in runs_of(front_bits[r], min_w=2):
            xc = ((x0 + x1) / 2 - ax_f) * sf
            rx = (x1 - x0) / 2 * sf
            is_ear = any(r_e0 <= r <= r_e1 for (r_e0, r_e1) in EAR_SPANS)
            if is_ear or cap_f[r, (x0 + x1) // 2]:
                continue
            name = "bit" + ("L" if xc < 0 else "R")
            comps.setdefault(name, []).append((z, xc, rx, yc, min(ry, max(0.012, rx * 1.3))))

# 耳朵：依正面輪廓逐列做實體，往頭裡面多埋一段，前後位置用側面圖量到的
EAR_IN = 0.04
for side_name, pts in ears.items():
    rows_e = sorted(set(int(v) for v in pts[:, 0]))
    zc_e = (Hf - (rows_e[0] + rows_e[-1]) / 2) * sf
    hz_e = max(0.01, (rows_e[-1] - rows_e[0]) / 2 * sf)
    for r in rows_e[::STEP]:
        xs = pts[pts[:, 0] == r][:, 1]
        xa, xb_ = (xs.min() - ax_f) * sf, (xs.max() + 1 - ax_f) * sf
        if side_name == "L":
            xb_ += EAR_IN
        else:
            xa -= EAR_IN
        z = (Hf - r) * sf
        prof = math.sqrt(max(0.2, 1 - ((z - zc_e) / hz_e) ** 2))
        comps.setdefault("ear" + side_name, []).append((z, (xa + xb_) / 2, (xb_ - xa) / 2, Y_EAR, EAR_RY * prof))

def build_rings(name, comp_dict):
    """把各部位的橢圓截面連成封閉的立體。"""
    bm = bmesh.new()

    def ring(z, xc, rx, yc, ry):
        vs = []
        # 臉的截面比正橢圓方一點（正面較平，五官不會被彎到側面去）；往帽頂漸漸變回正橢圓
        if z > HEIGHT * NECK:
            e = 2.0 + 0.6 * min(1.0, max(0.0, (z_bt + 0.1 - z) / 0.1))
        else:
            e = EXP
        for i in range(N):
            t = 2 * math.pi * i / N
            c, s_ = math.cos(t), math.sin(t)
            x = xc + rx * math.copysign(abs(c) ** (2 / e), c)
            y = yc + ry * math.copysign(abs(s_) ** (2 / e), s_)
            vs.append(bm.verts.new((x, y, z)))
        return vs

    for cname, rows in comp_dict.items():
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
        print(f"{cname}: {len(rows)} 列, {built} 段")
    return bm


def to_object(name, bm, voxel=None, smooth=0):
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    ob = bpy.data.objects.new(name, me)
    COL.objects.link(ob)
    if voxel:
        rm = ob.modifiers.new("remesh", "REMESH")
        rm.mode = "VOXEL"
        rm.voxel_size = voxel
        rm.use_smooth_shade = True
    if smooth:
        sm = ob.modifiers.new("smooth", "SMOOTH")
        sm.factor = 0.6
        sm.iterations = smooth
    return ob


def smooth_profile(rows, win=5):
    """把頭部各列的中心與半徑沿高度方向做移動平均。"""
    rows = sorted(rows, key=lambda t: -t[0])
    arr = np.array(rows)
    out = arr.copy()
    idx = [i for i in range(len(arr)) if arr[i, 0] > HEIGHT * NECK + 0.02]
    for i in idx:
        a, b = max(idx[0], i - win), min(idx[-1], i + win) + 1
        out[i, 1:] = arr[a:b, 1:].mean(axis=0)
    return [tuple(r) for r in out]


comps["body"] = smooth_profile(comps["body"])
crown_rows = smooth_profile(crown_rows)
obj = to_object("player", build_rings("player", comps), voxel=0.0065, smooth=12)

# ── 帽冠：頭顱往外一層布料厚度，下擺用前高後低的斜面切掉 ──
bm = build_rings("crown", {"crown": list(crown_rows)})
p_co = Vector((0, y_fr, z_fr))
d = Vector((0, y_br - y_fr, z_br - z_fr)).normalized()
p_no = Vector((0, d.z, -d.y))  # 朝下
if p_no.z > 0:
    p_no = -p_no
res = bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=p_co, plane_no=p_no, clear_outer=True)
cut_edges = [e for e in res["geom_cut"] if isinstance(e, bmesh.types.BMEdge)]
bmesh.ops.edgeloop_fill(bm, edges=cut_edges)
crown = to_object("cap_crown", bm, voxel=0.006, smooth=8)

# ── 帽簷：沿帽冠下擺前半圈伸出去的弧形薄板 ──
cz = np.array([t[0] for t in sorted(crown_rows)])
cp = np.array([t[1:] for t in sorted(crown_rows)])


def crown_at(z):
    return [float(np.interp(z, cz, cp[:, k])) for k in range(4)]  # xc, rx, yc, ry


def inner_pt(theta):
    """帽冠表面上、下擺斜面往上一點的位置。theta 由正前方算起。"""
    z = z_fr + TB
    for _ in range(5):
        xc, rx, yc, ry = crown_at(z)
        y = yc - ry * math.cos(theta)
        z = rim_z(y) + TB * 0.9
    pin = Vector((xc + rx * math.sin(theta), y, z))
    cen = Vector((xc, yc, z))
    return pin.lerp(cen, 0.05), cen  # 稍微往帽冠裡面收，接縫才不會露出來


TH_M = math.radians(86)
p0, _c = inner_pt(0.0)
L0 = p0.y - y_tip
DZ = (z_tip - TB * 0.3) - p0.z
print(f"帽簷：長 {L0:.3f} 尖端比接點低 {-DZ:.3f}")
bm = bmesh.new()
NU, VS = 37, [-0.22, 0.0, 0.18, 0.36, 0.54, 0.72, 0.88, 1.0]
grid = []
for i in range(NU):
    th = -TH_M + 2 * TH_M * i / (NU - 1)
    pin, cen = inner_pt(th)
    Lk = max(0.0, math.cos(math.pi / 2 * th / TH_M)) ** 0.45
    row = []
    for v in VS:
        if v < 0:
            p = pin.lerp(cen, -v * 0.7)  # 埋進帽冠裡
        else:
            sag = 0.018 * v * (math.sin(th) / math.sin(TH_M)) ** 2  # 兩側微微下垂
            p = pin + Vector((0, -L0 * Lk * v, DZ * Lk * v - sag))
        row.append(bm.verts.new(p))
    grid.append(row)
for a, b in zip(grid, grid[1:]):
    for j in range(len(VS) - 1):
        bm.faces.new([a[j], a[j + 1], b[j + 1], b[j]])
brim = to_object("cap_brim", bm)
so = brim.modifiers.new("solid", "SOLIDIFY")
so.thickness = TB
so.offset = 0
ss_mod = brim.modifiers.new("subsurf", "SUBSURF")
ss_mod.levels = ss_mod.render_levels = 2

# ── 帽頂釦 ──
bm = bmesh.new()
bmesh.ops.create_uvsphere(bm, u_segments=20, v_segments=10, radius=0.034)
_xc, _rx, top_yc, _ry = crown_at(cz.max())
for v in bm.verts:
    v.co = Vector((v.co.x, v.co.y + top_yc, v.co.z * 0.55 + cz.max() + 0.004))
button = to_object("cap_button", bm)

# ════════ 5. 投影貼圖 ════════
def lin(c):
    """sRGB 0–255 轉線性色。"""
    return tuple(((v / 255 + 0.055) / 1.055) ** 2.4 if v / 255 > 0.04045 else v / 255 / 12.92 for v in c) + (1.0,)


def finish(mat, color_out):
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    nt.links.new(color_out, bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.85
    for key in ("Emission Color", "Emission"):
        if key in bsdf.inputs:
            nt.links.new(color_out, bsdf.inputs[key])
            break
    bsdf.inputs["Emission Strength"].default_value = 0.55


def build_projected(name, T):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
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
        t.image = bpy.data.images.load(path, check_existing=False)
        t.interpolation = "Cubic"
        t.extension = "EXTEND"
        nt.links.new(vec, t.inputs["Vector"])
        return t.outputs["Color"]

    NECK_Z = HEIGHT * NECK
    HEAD_MASK = smooth_range(sep.outputs["Z"], NECK_Z, NECK_Z + 0.05)
    DOWN = smooth_range(mnode("MULTIPLY", nsep.outputs["Z"], -1.0), 0.66, 0.92)  # 只有真的朝下的面（下巴底、袖子底）

    def view_color(key, vec, facing):
        """某個視角的顏色：正對時用清晰貼圖，越斜越換成模糊的底色（只在頭部）。"""
        t = smooth_range(facing, 0.3, 0.62)
        t = mnode("SUBTRACT", 1.0, mnode("MULTIPLY", mnode("SUBTRACT", 1.0, t), HEAD_MASK))
        # 朝下的表面（下巴底、袖子底、褲襠）三個視角都看不到，一律用柔化的底色，避免拉成長條
        t = mnode("MULTIPLY", t, mnode("SUBTRACT", 1.0, DOWN))
        return mix_color(t, tex(T[key + "_soft"], vec), tex(T[key], vec))

    uv_f = uv("X", 1 / (sf * Wf), ax_f / Wf, 1 / (sf * Hf))
    uv_b = uv("X", -1 / (sb * Wb), ax_b / Wb, 1 / (sb * Hb))
    uv_s = uv("Y", -1 / (ss * Ws), ax_s / Ws, 1 / (ss * Hs))  # 側面圖的人物面向右
    # 只看水平方向的斜度（朝上或朝下的表面不算斜面）
    nx_raw, ny_raw = nsep.outputs["X"], nsep.outputs["Y"]
    hlen = mnode("SQRT", mnode("ADD", mnode("ADD", mnode("MULTIPLY", nx_raw, nx_raw), mnode("MULTIPLY", ny_raw, ny_raw)), 1e-6))
    ny = mnode("DIVIDE", ny_raw, hlen)
    abs_nx = mnode("ABSOLUTE", mnode("DIVIDE", nx_raw, hlen))
    col_f = view_color("front", uv_f, mnode("MULTIPLY", ny, -1.0))
    col_b = view_color("back", uv_b, ny)
    col_s = view_color("side", uv_s, abs_nx)
    fac_fb = smooth_range(ny, -0.12, 0.12)
    # 側面圖只用在頭部且接近正側面的地方
    side_w = mnode("MULTIPLY", smooth_range(abs_nx, 0.78, 0.88), HEAD_MASK)
    finish(mat, mix_color(side_w, mix_color(fac_fb, col_f, col_b), col_s))
    return mat


def build_shaded(name, rgb255):
    """帽簷／帽頂釦：單色，朝上的面亮、朝下的面暗（貼圖本身帶明暗）。"""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    geo = nt.nodes.new("ShaderNodeNewGeometry")
    nsep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(geo.outputs["Normal"], nsep.inputs[0])
    mr = nt.nodes.new("ShaderNodeMapRange")
    nt.links.new(nsep.outputs["Z"], mr.inputs["Value"])
    mr.inputs["From Min"].default_value = -1.0
    mr.inputs["From Max"].default_value = 1.0
    mr.inputs["To Min"].default_value = 0.42
    mr.inputs["To Max"].default_value = 1.06
    rgbn = nt.nodes.new("ShaderNodeRGB")
    rgbn.outputs[0].default_value = lin(rgb255)
    sc = nt.nodes.new("ShaderNodeVectorMath")
    sc.operation = "SCALE"
    nt.links.new(rgbn.outputs[0], sc.inputs[0])
    nt.links.new(mr.outputs["Result"], sc.inputs["Scale"])
    finish(mat, sc.outputs["Vector"])
    return mat


# 帽簷顏色：取正面圖帽簷中央那一帶
bsel = cap_f[r_arch - 24:r_arch - 6, int(ax_f) - 40:int(ax_f) + 40]
brim_rgb = np.median(front_c[r_arch - 24:r_arch - 6, int(ax_f) - 40:int(ax_f) + 40][bsel], axis=0)
tsel = cap_f[r_captop_f:r_captop_f + 10]
btn_rgb = np.median(front_c[r_captop_f:r_captop_f + 10][tsel], axis=0)
print("帽簷色", brim_rgb.round(), "帽頂釦色", btn_rgb.round())
obj.data.materials.append(build_projected("projected_head", TEX_HEAD))
crown.data.materials.append(build_projected("projected_cap", TEX))
brim.data.materials.append(build_shaded("cap_brim", brim_rgb / 0.95))
button.data.materials.append(build_shaded("cap_button", btn_rgb / 0.95))
CAP_PARTS = [crown, brim, button]

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


for ang in (0, 45, 90, 180):
    shoot(f"body_{ang:03d}.png", ang, res=(600, 800))
for ang in (0, 25, 45, 60, 90, 135):
    shoot(f"head_{ang:03d}.png", ang, res=(700, 700), aim=1.4, scale=0.82, elev=0.6)
ground.hide_render = True  # 仰視時地板會擋住鏡頭
shoot("head_low_000.png", 0, res=(700, 700), aim=1.35, scale=0.9, elev=-4.5)
shoot("head_low_045.png", 45, res=(700, 700), aim=1.35, scale=0.9, elev=-4.5)
shoot("body_low_020.png", 20, res=(700, 700), aim=0.95, scale=2.0, elev=-4.0)
ground.hide_render = False
shoot("head_high_025.png", 25, res=(700, 700), aim=1.4, scale=0.82, elev=3.0)
for o in CAP_PARTS:
    o.hide_render = True
shoot("nocap_025.png", 25, res=(700, 700), aim=1.4, scale=0.82, elev=0.6)
for o in CAP_PARTS:
    o.hide_render = False
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, "player_from_sheet.blend"))
print("完成")
