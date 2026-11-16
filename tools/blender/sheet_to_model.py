"""把角色設定圖（正面／側面／背面）轉成 3D 模型並算出預覽圖。第 5 版：頭和身體用脫帽設定圖做，帽子（量自戴帽設定圖）是獨立配件。

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
WEAR_CAP = "nocap" not in argv  # 加上 nocap 參數＝不戴帽，保留完整頭髮
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
        w = w_b + (w_a - w_b) * (1 - t) ** 2.5  # 頭髮下緣就很快收到臉的寬度，耳朵才會凸在臉外面
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
    # 輪廓內殘留的背景色（手指之間的縫隙）不算身體的顏色，用旁邊的顏色補
    filled &= ~dilate(np.sqrt(((c - bg) ** 2).sum(axis=2)) < 30, 1)
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


BLUR_R = 11  # 斜面用的模糊半徑；太大髮際線會暈成一片漸層
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
    "front_mild": save_tex(box_blur(front_h, 4), "texh_front_mild"),
    "back_mild": save_tex(box_blur(back_h, 4), "texh_back_mild"),
    "side_mild": save_tex(box_blur(side_h, 4), "texh_side_mild"),
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
    "front_mild": save_tex(box_blur(front_p, 4), "tex_front_mild"),
    "back_mild": save_tex(box_blur(back_p, 4), "tex_back_mild"),
    "side_mild": save_tex(box_blur(side_p, 4), "tex_side_mild"),
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
    if '_blur' not in p and '_soft' not in p and '_mild' not in p:
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
            e = 2.0 + 0.35 * min(1.0, max(0.0, (z_bt + 0.1 - z) / 0.1))
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
            if cname == "body":
                # 頭頂收圓：最上面幾列逐漸縮小，不要用一個平面封口（否則頭頂會像被削平）
                z0 = seg[0][0]
                h = min(0.09, 0.6 * min(seg[0][2], seg[0][4]))
                seg = [(z, xc, rx * f, yc, ry * f) for (z, xc, rx, yc, ry), f in
                       ((row, max(0.06, math.sqrt(max(0.0, 1 - (1 - min(1.0, (z0 - row[0]) / h)) ** 2)))) for row in seg)]
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


def to_object(name, bm, voxel=None, smooth=0, recalc=True):
    if recalc:  # 互相穿插的多個球（手）自動判斷內外會出錯，那種情況直接沿用建模時的方向
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


crown_rows = smooth_profile(crown_rows)

# ════════ 4b. 頭和身體改用「脫帽」設定圖來做 ════════
# 戴帽的圖只用來量帽子；頭（額頭、鬢角、耳朵、頭髮）全部取自脫帽圖，不用猜帽子底下長什麼樣子
SRC_BARE = os.path.normpath(os.path.join(HERE, "..", "..", "public", "models", "_候選預覽", "concept-player-sheet-脫帽.png"))


def split_views(path):
    """切出正面／側面／背面三個視角的（輪廓, 顏色）。"""
    rgb_ = load_rgb(path)
    H_, W_, _ = rgb_.shape
    cn = np.concatenate([rgb_[:24, :24].reshape(-1, 3), rgb_[:24, -24:].reshape(-1, 3)])
    mk = np.sqrt(((rgb_ - np.median(cn, axis=0)) ** 2).sum(axis=2)) > 26
    mk = dilate(erode(mk, 1), 1)
    mk = erode(dilate(mk, 2), 2)
    cols_ = mk.sum(axis=0) > 3
    fg, st = [], None
    for x in range(W_):
        if cols_[x] and st is None:
            st = x
        if (not cols_[x] or x == W_ - 1) and st is not None:
            if x - st > 60:
                fg.append((st, x))
            st = None
    out = []
    for x0, x1 in fg[:3]:
        sub = mk[:, x0:x1]
        rows = np.where(sub.sum(axis=1) > 2)[0]
        y0, y1 = rows[0], rows[-1] + 1
        m = sub[y0:y1].copy()
        c = rgb_[y0:y1, x0:x1].copy()
        lum = c.mean(axis=2)
        sat = c.max(axis=2) - c.min(axis=2)
        shadow = (sat < 18) & (lum > 112) & (lum < 215)
        shadow[: int(m.shape[0] * 0.9)] = False
        m &= ~shadow
        m = erode(dilate(m, 3), 3)
        m = dilate(erode(m, 2), 2)
        keep = np.where(m.sum(axis=1) > 6)[0]
        out.append((m[: keep[-1] + 1], c[: keep[-1] + 1]))
    return out


def torso_center(m, s):
    """腰到胸那一段中央輪廓的中心（兩張設定圖的身體相同，用來對齊左右位置）。"""
    H_ = m.shape[0]
    cs = []
    for r in range(int(H_ - HEIGHT * 0.58 / s), int(H_ - HEIGHT * 0.44 / s)):
        rr = runs_of(m[r])
        if rr:
            w = max(rr, key=lambda t: t[1] - t[0])
            cs.append((w[0] + w[1]) / 2)
    return float(np.median(cs))


(bf_m, bf_c), (bs_m, bs_c), (bb_m, bb_c) = split_views(SRC_BARE)
Hf2, Wf2 = bf_m.shape
Hs2, Ws2 = bs_m.shape
Hb2, Wb2 = bb_m.shape
ax_f2 = ax_f + torso_center(bf_m, sf) - torso_center(front_m, sf)
ax_b2 = ax_b + torso_center(bb_m, sb) - torso_center(back_m, sb)
ext2 = []
for r in range(int(Hs2 - HEIGHT * 0.58 / ss), int(Hs2 - HEIGHT * 0.44 / ss)):
    xs = np.where(bs_m[r])[0]
    if len(xs):
        ext2.append((xs[0] + xs[-1]) / 2)
ax_s2 = float(np.median(ext2))
neck_row2 = int(Hf2 - HEIGHT * NECK / sf)
print(f"脫帽圖：高 {Hf2 * sf:.3f} m（戴帽圖 {HEIGHT} m）｜中軸 正 {ax_f2:.1f} 側 {ax_s2:.1f} 背 {ax_b2:.1f}")

# 頭部：細小突出物（髮梢）分開；耳朵依外緣膚色找出範圍
opened2 = dilate(erode(bf_m, R_OPEN), R_OPEN) & bf_m
body2 = bf_m.copy()
body2[:neck_row2] = opened2[:neck_row2]


def bare_edge(r, sgn):
    rr = [t for t in runs_of(bf_m[r]) if t[0] <= ax_f2 <= t[1]]
    if not rr:
        return None
    return rr[0][0] if sgn < 0 else rr[0][1] - 1


def bare_skin(r, x):
    return float(np.sqrt(((bf_c[r, x] - skin_ref) ** 2).sum())) < 60


ears2, ear_range2 = {}, None
for sgn, key in ((-1, "L"), (1, "R")):
    def half_w(r):
        x = bare_edge(r, sgn)
        return None if x is None else abs(x - ax_f2)

    def edge_is_skin(r):
        x = bare_edge(r, sgn)
        return x is not None and sum(bare_skin(r, x - sgn * k) for k in range(3, 9)) >= 4

    top = next((r for r in range(int(Hf2 * 0.1), neck_row2 - 8) if all(edge_is_skin(r + k) for k in range(4))), None)
    if top is None:
        continue
    bot = next((r + 6 for r in range(top + 8, neck_row2 - 8) if half_w(r + 6) < half_w(r) - 14), top + int(0.085 / sf))
    r_a, r_b = top - 3, min(neck_row2 - 1, bot + 4)
    w_a, w_b = half_w(r_a), half_w(r_b)
    em = np.zeros_like(bf_m)
    for r in range(r_a, r_b + 1):
        t = (r - r_a) / (r_b - r_a)
        w = w_b + (w_a - w_b) * (1 - t) ** 2.5  # 頭髮下緣就很快收到臉的寬度，耳朵才會凸在臉外面
        xe = int(round(ax_f2 + sgn * w))
        if sgn < 0:
            em[r, :xe] = body2[r, :xe]
            body2[r, :xe] = False
        else:
            em[r, xe + 1:] = body2[r, xe + 1:]
            body2[r, xe + 1:] = False
    ears2[key] = np.argwhere(em)
    ear_range2 = ear_range2 or (top, bot)
    print(f"脫帽圖耳朵 {key}：列 {top}–{bot}，頭寬 {w_a:.0f}→{w_b:.0f} px，耳朵像素 {len(ears2[key])}")
bits2 = bf_m & ~body2
EAR_SPANS2 = [(int(p[:, 0].min()), int(p[:, 0].max())) for p in ears2.values()]

# 側面圖：膚色對齊、耳朵的前後位置
rs0, rs1 = int(Hs2 - HEIGHT * 0.86 / ss), int(Hs2 - HEIGHT * 0.63 / ss)
sk2 = (np.sqrt(((bs_c[rs0:rs1] - skin_ref) ** 2).sum(axis=2)) < 52) & bs_m[rs0:rs1]
fsk2 = (np.sqrt(((bf_c[:neck_row2] - skin_ref) ** 2).sum(axis=2)) < 52) & bf_m[:neck_row2]
bs_c = np.clip(bs_c * (np.median(bf_c[:neck_row2][fsk2], axis=0) / np.maximum(1, np.median(bs_c[rs0:rs1][sk2], axis=0))), 0, 255)
skin_full2 = (np.sqrt(((bs_c - skin_ref) ** 2).sum(axis=2)) < 52) & bs_m
e_c, e_w = [], []
if ear_range2:
    for r in range(ear_range2[0] + 4, ear_range2[1] - 4):
        rs = min(Hs2 - 1, int(round(Hs2 - (Hf2 - r) * sf / ss)))
        rr = runs_of(skin_full2[rs], min_w=5)
        if len(rr) >= 2:
            e_c.append((rr[0][0] + rr[0][1]) / 2)
            e_w.append((rr[0][1] - rr[0][0]) / 2)
Y_EAR2 = -(float(np.median(e_c)) - ax_s2) * ss if e_c else 0.03
EAR_RY2 = float(np.median(e_w)) * ss if e_w else 0.04
print(f"脫帽圖耳朵前後位置 y={Y_EAR2:.3f} 半徑={EAR_RY2:.3f}（側面有效列 {len(e_c)}）")


# 貼圖
def features_of(c, m, r_lo, r_hi, x_min=0):
    """臉上的五官＝頭部範圍內、沒有連到頭髮（最大的深色塊）的深色塊。"""
    lum = c.mean(axis=2)
    dark = (lum < 110) & m
    dark[:r_lo] = False
    dark[r_hi:] = False
    out = np.zeros_like(m)
    for area_px, cx, cy, pts in label(dark)[1:]:
        if cx > x_min:
            out[pts[:, 0], pts[:, 1]] = True
    return out


ear_all2 = np.zeros_like(bf_m)
for pts in ears2.values():
    ear_all2[pts[:, 0], pts[:, 1]] = True
strip2 = dilate(ear_all2, 12) & bf_m & ~ear_all2
front2 = pad_fill(bf_c, bf_m, strip2)
back2 = pad_fill(bb_c, bb_m)
feat_f2 = dilate(features_of(bf_c, bf_m, 0, neck_row2), 7)
f_lum2 = bf_c.mean(axis=2)
f_sat2 = bf_c.max(axis=2) - bf_c.min(axis=2)
white2 = (f_sat2 < 30) & (f_lum2 > 185) & bf_m
white2[neck_row2:] = False
front2_soft = pad_fill(front2, bf_m, feat_f2 | (dilate(white2, 3) & dilate(feat_f2, 25)))
face_cols = np.where(sk2.sum(axis=0) > 3)[0]
bx2 = int(face_cols.min() + (face_cols.max() - face_cols.min()) * 0.45)
feat_s2 = features_of(bs_c, bs_m, rs0, rs1, x_min=bx2)
s_lum2 = bs_c.mean(axis=2)
s_dist2 = np.sqrt(((bs_c - skin_ref) ** 2).sum(axis=2))
light2 = (s_dist2 > 34) & (s_lum2 >= 110) & bs_m
light2[:rs0] = False
light2[rs1:] = False
light2[:, :bx2] = False
erase_s2 = dilate(dilate(feat_s2, 6) | (light2 & dilate(feat_s2, 30)), 2)
# 頭髮上的白色反光（耳朵以上、又亮又不是膚色的像素）貼到頭頂會變成一塊白斑，抹掉
glint = (s_lum2 > 120) & (s_dist2 > 60) & bs_m
glint[rs0 + int(0.06 / ss):] = False
erase_s2 |= dilate(glint, 4)
for c_, m_ in ((bf_c, bf_m), (bb_c, bb_m)):
    pass
side2 = pad_fill(bs_c, bs_m, erase_s2)
TEX_BARE = {
    "front_mild": save_tex(box_blur(front2, 4), "texb_front_mild"),
    "back_mild": save_tex(box_blur(back2, 4), "texb_back_mild"),
    "side_mild": save_tex(box_blur(side2, 4), "texb_side_mild"),
    "front": save_tex(front2, "texb_front"),
    "back": save_tex(back2, "texb_back"),
    "side": save_tex(side2, "texb_side"),
    "front_blur": save_tex(box_blur(front2_soft, BLUR_R), "texb_front_blur"),
    "back_blur": save_tex(box_blur(back2, BLUR_R), "texb_back_blur"),
    "side_blur": save_tex(box_blur(side2, BLUR_R), "texb_side_blur"),
    "front_soft": save_tex(box_blur(front2_soft, BLUR_R + 8), "texb_front_soft"),
    "back_soft": save_tex(box_blur(back2, BLUR_R + 8), "texb_back_soft"),
    "side_soft": save_tex(box_blur(side2, BLUR_R), "texb_side_soft"),
}
subprocess.run(["/usr/bin/env", "python3", "-c", UPSCALE] + sorted(set(TEX_BARE.values())), check=True)
BARE_DIMS = dict(y_cut=-(bx2 - ax_s2) * ss, sf=sf, Wf=Wf2, ax_f=ax_f2, Hf=Hf2, sb=sb, Wb=Wb2, ax_b=ax_b2, Hb=Hb2, ss=ss, Ws=Ws2, ax_s=ax_s2, Hs=Hs2)

# 各列截面。戴帽時，帽冠蓋住的部分（下擺斜面以上）把頭髮收進帽子裡
_cz = np.array([t[0] for t in sorted(crown_rows)])
_cp = np.array([t[1:] for t in sorted(crown_rows)])
CAP_IN = 0.02  # 頭髮比帽冠內縮這麼多，才不會穿出來


# 鼻子：側面輪廓在臉下半部最突出的那一點。臉本身用「去掉鼻子」的輪廓，鼻子另外做成小凸塊，
# 否則不是被平滑抹掉（臉變成一面平牆），就是變成橫跨整張臉的一道稜線
prof2 = np.array([(np.where(bs_m[r])[0][-1] if bs_m[r].any() else 0) for r in range(Hs2)], dtype=float)
n_lo, n_hi = int(Hs2 - HEIGHT * 0.75 / ss), int(Hs2 - HEIGHT * 0.65 / ss)
r_nose = n_lo + int(np.argmax(prof2[n_lo:n_hi]))
base_n = float(np.median(np.concatenate([prof2[r_nose - 24:r_nose - 13], prof2[r_nose + 13:r_nose + 24]])))
nose_p = prof2[r_nose] - base_n  # 鼻子比臉突出的像素數
nose_rows = [r for r in range(r_nose - 20, r_nose + 21) if prof2[r] > base_n + nose_p * 0.25]
NOSE = None
if nose_p >= 3 and len(nose_rows) >= 3:
    NOSE = (nose_rows[0], nose_rows[-1])
    print(f"鼻子：列 {NOSE[0]}–{NOSE[1]}，突出 {nose_p * ss * 100:.1f} 公分")
else:
    print("鼻子：側面圖上找不到明顯的突出")


def bare_depth(z):
    r = min(Hs2 - 1, max(0, int(round(Hs2 - z / ss))))
    xs = np.where(bs_m[r])[0]
    if not len(xs):
        return -0.05, 0.05
    xf = float(xs[-1])
    if NOSE and NOSE[0] - 3 <= r <= NOSE[1] + 3:
        xf = min(xf, base_n + 1)  # 這幾列的臉不含鼻子
    return -(xf - ax_s2) * ss, -(xs[0] - ax_s2) * ss


comps = {}
head_half2 = max((x1 - x0) / 2 for r in range(0, neck_row2) for (x0, x1) in runs_of(body2[r])) * sf
for r in range(0, Hf2, STEP):
    z = (Hf2 - r) * sf
    yf, yb = bare_depth(z)
    rr = runs_of(body2[r])
    central = [t for t in rr if t[0] <= ax_f2 <= t[1]]
    for (x0, x1) in rr:
        xc = ((x0 + x1) / 2 - ax_f2) * sf
        rx = (x1 - x0) / 2 * sf
        if central and (x0, x1) == central[0]:
            f_, b_ = yf, yb
            if WEAR_CAP and r < neck_row2:
                if z > _cz.max() - CAP_IN * 3:
                    continue  # 帽頂以上不留頭髮
                if z > _cz.min():
                    cxc, crx, cyc, cry = [float(np.interp(z, _cz, _cp[:, k])) for k in range(4)]
                    if z > rim_z(b_):
                        b_ = min(b_, cyc + cry - CAP_IN)
                    if z > rim_z(f_):
                        f_ = max(f_, cyc - cry + CAP_IN)
                    if z > rim_z((f_ + b_) / 2):
                        rx = min(rx, crx - CAP_IN - abs(xc - cxc))
            comps.setdefault("body", []).append((z, xc, max(0.02, rx), (f_ + b_) / 2, max(0.012, (b_ - f_) / 2)))
        elif central:
            name = "armL" if xc < 0 else "armR"
            comps.setdefault(name, []).append((z, xc, rx, 0.0, rx * 0.72))
        else:
            yc, ry = (yf + yb) / 2, max(0.012, (yb - yf) / 2)
            name = "legL" if xc < 0 else "legR"
            d_ = ry if z < 0.13 else min(ry, rx * 1.25)
            comps.setdefault(name, []).append((z, xc, rx, yc, d_))
    if r < neck_row2 and not (WEAR_CAP and z > rim_z((yf + yb) / 2)):
        yc, ry = (yf + yb) / 2, max(0.012, (yb - yf) / 2)
        for (x0, x1) in runs_of(bits2[r], min_w=2):
            if any(a <= r <= b for (a, b) in EAR_SPANS2):
                continue
            xc = ((x0 + x1) / 2 - ax_f2) * sf
            rx = (x1 - x0) / 2 * sf
            comps.setdefault("bit" + ("L" if xc < 0 else "R"), []).append((z, xc, rx, yc, min(ry, max(0.012, rx * 1.3))))
for side_name, pts in ears2.items():
    rows_e = sorted(set(int(v) for v in pts[:, 0]))
    zc_e = (Hf2 - (rows_e[0] + rows_e[-1]) / 2) * sf
    hz_e = max(0.01, (rows_e[-1] - rows_e[0]) / 2 * sf)
    for r in rows_e[::STEP]:
        xs = pts[pts[:, 0] == r][:, 1]
        xa, xb_ = (xs.min() - ax_f2) * sf, (xs.max() + 1 - ax_f2) * sf
        if side_name == "L":
            xb_ += EAR_IN
        else:
            xa -= EAR_IN
        z = (Hf2 - r) * sf
        prof = math.sqrt(max(0.2, 1 - ((z - zc_e) / hz_e) ** 2))
        comps.setdefault("ear" + side_name, []).append((z, (xa + xb_) / 2, (xb_ - xa) / 2, Y_EAR2, EAR_RY2 * prof))
if NOSE:
    zc_n = (Hs2 - (NOSE[0] + NOSE[1]) / 2) * ss
    hz_n = max(0.012, (NOSE[1] - NOSE[0]) / 2 * ss)
    y_tip_n = -(prof2[r_nose] - ax_s2) * ss
    ry_n = (nose_p * ss + 0.035) / 2  # 後半埋進臉裡
    k = 0
    while zc_n - hz_n + k * sf * STEP <= zc_n + hz_n:
        z = zc_n - hz_n + k * sf * STEP
        f = math.sqrt(max(0.05, 1 - ((z - zc_n) / hz_n) ** 2))
        comps.setdefault("nose", []).append((z, 0.0, hz_n * 1.15 * f, y_tip_n + ry_n, ry_n * f))
        k += 1

# 手：輪廓充氣做不出分開的手指。從手腕（袖口到膚色的交界）把原本的手切掉，之後換上另外建模的手
HANDS = {}
for nm in ("armL", "armR"):
    rows = sorted([t for t in comps.get(nm, []) if t[0] < HEIGHT * NECK], key=lambda t: -t[0])  # 脖子以上的是髮梢，不是手臂

    def skin_row(t):
        px, r = int(round(ax_f2 + t[1] / sf)), int(round(Hf2 - t[0] / sf))
        patch = bf_c[max(0, r - 1):r + 2, max(0, px - 2):px + 3].reshape(-1, 3)
        return float(np.sqrt(((np.median(patch, axis=0) - skin_ref) ** 2).sum())) < 60

    iw = next((i for i in range(int(len(rows) * 0.3), len(rows) - 3) if all(skin_row(rows[i + k]) for k in range(3))), None)
    if iw is None:
        continue
    zw, xw, rw = rows[iw][0], rows[iw][1], rows[iw][2]
    up = [t for t in rows if zw + 0.015 < t[0] < zw + 0.09]
    slope = float(np.polyfit([t[0] for t in up], [t[1] for t in up], 1)[0])  # 手臂往下時 x 的變化
    d_ = Vector((-slope, 0, -1)).normalized()
    L_ = max(((t[1] - xw) * d_.x + (t[0] - zw) * d_.z) + t[2] for t in rows[iw:])
    top = rows[0]
    comps[nm] = [t for t in rows if t[0] >= zw + 0.004]
    HANDS[nm] = dict(p=(xw, 0.0, zw), d=tuple(d_), L=float(L_), r=float(rw), shoulder=(float(top[1]), float(top[0])))
    print(f"手 {nm}：手腕 x={xw:.3f} z={zw:.3f} 半徑 {rw:.3f}｜手長 {L_:.3f}｜肩 x={top[1]:.3f} z={top[0]:.3f}")
_legs = sorted(comps["legL"], key=lambda t: -t[0])
RIG = dict(
    hands=HANDS,
    crotch_z=float(_legs[0][0]),
    leg_x=float(abs(np.median([t[1] for t in _legs if 0.2 < t[0] < _legs[0][0] - 0.05]))),
    neck_z=float(HEIGHT * NECK),
    y_torso=float(sum(bare_depth(HEIGHT * 0.5)) / 2),
    y_head=float(sum(bare_depth(HEIGHT * 0.78)) / 2),
    y_foot=float(sum(bare_depth(0.05)) / 2),
)
import json
with open(os.path.join(OUT, "rig.json"), "w") as fh:
    json.dump(RIG, fh, indent=1)
comps["body"] = smooth_profile(comps["body"])
obj = to_object("player", build_rings("player", comps), voxel=0.0065, smooth=12)


def add_ellipsoid(bm, center, axes, radii):
    """axes[2] 是長軸方向。"""
    if axes[0].cross(axes[1]).dot(axes[2]) < 0:
        axes = (-axes[0], axes[1], axes[2])  # 保持右手座標，否則球會被鏡射、表面朝內（明暗會反過來變成一塊深色）
    geom = bmesh.ops.create_uvsphere(bm, u_segments=14, v_segments=9, radius=1.0)
    for v in geom["verts"]:
        c = v.co.copy()
        v.co = center + axes[0] * (c.x * radii[0]) + axes[1] * (c.y * radii[1]) + axes[2] * (c.z * radii[2])


def frame_of(direction, hint):
    a1 = (hint - direction * hint.dot(direction)).normalized()
    return a1, direction.cross(a1).normalized(), direction


bm = bmesh.new()
for nm, h in HANDS.items():
    P, u, L_ = Vector(h["p"]), Vector(h["d"]), h["L"] * 0.86
    w = Vector((0, -1, 0))  # 拇指朝前
    n = u.cross(w).normalized()
    if n.x * P.x > 0:
        n = -n  # 掌心朝向身體
    add_ellipsoid(bm, P + u * 0.22 * L_, (w, n, u), (0.31 * L_, 0.29 * L_, 0.5 * L_))  # 手掌（後半段埋進袖口，蓋住手臂的切口）
    for i in range(4):  # 食指到小指
        dirf = (u + w * (0.15 - 0.10 * i) + n * 0.12).normalized()
        lf = (0.40, 0.44, 0.41, 0.33)[i] * L_
        base = P + u * 0.5 * L_ + w * (0.255 - 0.17 * i) * L_
        a1, a2, a3 = frame_of(dirf, w)
        add_ellipsoid(bm, base + dirf * lf * 0.5, (a1, a2, a3), (0.088 * L_, 0.085 * L_, lf * 0.5 + 0.04 * L_))
    dirt = (u * 0.72 + w * 0.68 + n * 0.1).normalized()  # 拇指
    a1, a2, a3 = frame_of(dirt, n)
    add_ellipsoid(bm, P + u * 0.12 * L_ + w * 0.27 * L_ + dirt * 0.17 * L_, (a1, a2, a3), (0.105 * L_, 0.1 * L_, 0.25 * L_))
hands = to_object("hands", bm, recalc=False)

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


def build_projected(name, T, D=None):
    D = D or dict(sf=sf, Wf=Wf, ax_f=ax_f, Hf=Hf, sb=sb, Wb=Wb, ax_b=ax_b, Hb=Hb, ss=ss, Ws=Ws, ax_s=ax_s, Hs=Hs)
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
    UP = mnode("MULTIPLY", smooth_range(nsep.outputs["Z"], 0.86, 0.97), HEAD_MASK)
    # 試過「臉的前半段不用模糊底色」：太陽穴會出現鋸齒狀的直線，比暈開更糟，所以維持全頭都用
    BACK_HALF = mnode("ADD", 1.0, 0.0)
    DOWN = smooth_range(mnode("MULTIPLY", nsep.outputs["Z"], -1.0), 0.66, 0.92)  # 只有真的朝下的面（下巴底、袖子底）

    def view_color(key, vec, facing):
        """某個視角的顏色：正對時用清晰貼圖，越斜越換成模糊的底色（只在頭部）。"""
        t = smooth_range(facing, 0.3, 0.62)
        # 斜面換成模糊底色只用在頭的後半；臉的前半段維持清晰的正面圖，髮際線才不會暈開
        t = mnode("SUBTRACT", 1.0, mnode("MULTIPLY", mnode("SUBTRACT", 1.0, t), mnode("MULTIPLY", HEAD_MASK, BACK_HALF)))
        # 朝下的表面（下巴底、袖子底、褲襠）三個視角都看不到，一律用柔化的底色，避免拉成長條
        t = mnode("MULTIPLY", t, mnode("SUBTRACT", 1.0, DOWN))
        t = mnode("MULTIPLY", t, mnode("SUBTRACT", 1.0, UP))  # 正上方的面（頭頂）同樣三個視角都看不到
        fallback = mix_color(HEAD_MASK, tex(T[key + "_mild"], vec), tex(T[key + "_soft"], vec))
        return mix_color(t, fallback, tex(T[key], vec))

    uv_f = uv("X", 1 / (D["sf"] * D["Wf"]), D["ax_f"] / D["Wf"], 1 / (D["sf"] * D["Hf"]))
    uv_b = uv("X", -1 / (D["sb"] * D["Wb"]), D["ax_b"] / D["Wb"], 1 / (D["sb"] * D["Hb"]))
    uv_s = uv("Y", -1 / (D["ss"] * D["Ws"]), D["ax_s"] / D["Ws"], 1 / (D["ss"] * D["Hs"]))  # 側面圖的人物面向右
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
    if D.get("y_cut") is not None:
        # 臉的前半段（眉毛、眼睛所在的深度）完全交給正面圖，側面圖上的眉毛才不會在太陽穴再出現一次
        side_w = mnode("MULTIPLY", side_w, smooth_range(sep.outputs["Y"], D["y_cut"] - 0.03, D["y_cut"] + 0.01))
    finish(mat, mix_color(side_w, mix_color(fac_fb, col_f, col_b), col_s))
    return mat


def build_shaded(name, rgb255, lo=0.42, hi=1.06):
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
    mr.inputs["To Min"].default_value = lo
    mr.inputs["To Max"].default_value = hi
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
obj.data.materials.append(build_projected("projected_head", TEX_BARE, BARE_DIMS))
hand_rgb = np.median(bf_c[:neck_row2][fsk2], axis=0)
hm = bpy.data.materials.new("hand_skin")
hm.use_nodes = True
_nt = hm.node_tree
_geo = _nt.nodes.new("ShaderNodeNewGeometry")
_sep = _nt.nodes.new("ShaderNodeSeparateXYZ")
_nt.links.new(_geo.outputs["Normal"], _sep.inputs[0])


def _m(op, a, b):
    n_ = _nt.nodes.new("ShaderNodeMath")
    n_.operation = op
    for i_, v_ in enumerate((a, b)):
        if isinstance(v_, (int, float)):
            n_.inputs[i_].default_value = v_
        else:
            _nt.links.new(v_, n_.inputs[i_])
    return n_.outputs[0]


# 環境遮蔽：手指之間、手指根部會自然變暗，手才不會像一片剪紙
_ao = _nt.nodes.new("ShaderNodeAmbientOcclusion")
_ao.inputs["Distance"].default_value = 0.035
_ao.samples = 16
_aof = _nt.nodes.new("ShaderNodeMapRange")
_nt.links.new(_ao.outputs["AO"], _aof.inputs["Value"])
_aof.inputs["From Min"].default_value = 0.35
_aof.inputs["From Max"].default_value = 1.0
_aof.inputs["To Min"].default_value = 0.6
_aof.inputs["To Max"].default_value = 1.0
_shade = _m("MULTIPLY", _aof.outputs["Result"], _m("ADD", _m("ADD", _m("MULTIPLY", _sep.outputs["Z"], 0.22), _m("MULTIPLY", _sep.outputs["Y"], -0.14)), 0.86))
_rgb = _nt.nodes.new("ShaderNodeRGB")
_rgb.outputs[0].default_value = lin(hand_rgb)
_sc = _nt.nodes.new("ShaderNodeVectorMath")
_sc.operation = "SCALE"
_nt.links.new(_rgb.outputs[0], _sc.inputs[0])
_nt.links.new(_shade, _sc.inputs["Scale"])
finish(hm, _sc.outputs["Vector"])
hands.data.materials.append(hm)
crown.data.materials.append(build_projected("projected_cap", TEX))
brim.data.materials.append(build_shaded("cap_brim", brim_rgb / 0.95))
button.data.materials.append(build_shaded("cap_button", btn_rgb / 0.95))
CAP_PARTS = [crown, brim, button]
if not WEAR_CAP:
    for o in CAP_PARTS:
        bpy.data.objects.remove(o, do_unlink=True)
    CAP_PARTS = []

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
