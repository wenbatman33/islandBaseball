"""畫球員用的貼花貼圖：臉、帽徽、背號、前襟線。用系統的 Python + Pillow 執行。"""
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tex")
SS = 2  # 超取樣倍率，畫完縮小以取得平滑邊緣


def canvas(w, h):
    return Image.new("RGBA", (w * SS, h * SS), (0, 0, 0, 0))


def finish(im, name):
    im = im.resize((im.width // SS, im.height // SS), Image.LANCZOS)
    im.save(os.path.join(OUT, name))


def ell(d, cx, cy, rx, ry, fill):
    d.ellipse([(cx - rx) * SS, (cy - ry) * SS, (cx + rx) * SS, (cy + ry) * SS], fill=fill)


def face():
    # 貼圖涵蓋經度 ±60°、緯度 -65°~+55°，每度約 8.53 像素；中心 (512, 469) 為臉的正前方赤道
    W = H = 1024
    cx, eq = 512, 469
    im = canvas(W, H)
    # 腮紅（先畫在另一層再模糊）
    blush = canvas(W, H)
    bd = ImageDraw.Draw(blush)
    for s in (-1, 1):
        ell(bd, cx + s * 262, eq + 196, 62, 36, (255, 120, 110, 120))
    blush = blush.filter(ImageFilter.GaussianBlur(22 * SS))
    im.alpha_composite(blush)
    d = ImageDraw.Draw(im)
    for s in (-1, 1):
        ex, ey = cx + s * 166, eq + 70
        ell(d, ex, ey, 70, 96, (30, 20, 16, 255))  # 眼
        # 下半部的棕色漸層
        g = canvas(W, H)
        gd = ImageDraw.Draw(g)
        ell(gd, ex, ey + 26, 54, 64, (112, 68, 44, 235))
        g = g.filter(ImageFilter.GaussianBlur(12 * SS))
        mask = canvas(W, H)
        ell(ImageDraw.Draw(mask), ex, ey, 66, 92, (255, 255, 255, 255))
        im.paste(g, (0, 0), Image.composite(g, canvas(W, H), mask).split()[3])
        d = ImageDraw.Draw(im)
        ell(d, ex - 24, ey - 40, 27, 31, (255, 255, 255, 255))  # 大高光
        ell(d, ex + 26, ey + 44, 12, 12, (255, 255, 255, 230))  # 小高光
        # 眉毛
        pts = []
        for i in range(21):
            t = i / 20
            x = ex - s * 56 + s * 116 * t
            y = ey - 168 - 22 * (1 - (2 * t - 1) ** 2) + 10 * t
            pts.append((x * SS, y * SS))
        d.line(pts, fill=(26, 22, 20, 255), width=24 * SS, joint="curve")
        for p in (pts[0], pts[-1]):
            d.ellipse([p[0] - 12 * SS, p[1] - 12 * SS, p[0] + 12 * SS, p[1] + 12 * SS], fill=(26, 22, 20, 255))
    # 鼻
    ell(d, cx, eq + 176, 15, 10, (196, 128, 96, 150))
    # 微笑
    box = [(cx - 62) * SS, (eq + 168) * SS, (cx + 62) * SS, (eq + 292) * SS]
    d.arc(box, 28, 152, fill=(138, 64, 52, 255), width=13 * SS)
    finish(im, "face.png")


def logo():
    W = H = 512
    im = canvas(W, H)
    d = ImageDraw.Draw(im)
    cream = (241, 231, 207, 255)

    def poly(pts, fill):
        d.polygon([(x * 4 * SS, y * 4 * SS) for x, y in pts], fill=fill)

    poly([(30, 52), (20, 12), (54, 36), (74, 36), (108, 12), (98, 52), (116, 80), (64, 118), (12, 80)], cream)
    poly([(36, 66), (56, 72), (40, 80)], (0, 0, 0, 0))
    poly([(92, 66), (72, 72), (88, 80)], (0, 0, 0, 0))
    poly([(58, 92), (70, 92), (64, 100)], (0, 0, 0, 0))
    finish(im, "logo_cat.png")


def number(text="17", color=(31, 74, 54, 255)):
    W, H = 768, 512
    im = canvas(W, H)
    d = ImageDraw.Draw(im)
    font = None
    for p in ("/System/Library/Fonts/Supplemental/Impact.ttf", "/System/Library/Fonts/Supplemental/Arial Black.ttf",
              "/System/Library/Fonts/Supplemental/DIN Condensed Bold.ttf", "/System/Library/Fonts/Helvetica.ttc"):
        if os.path.exists(p):
            font = ImageFont.truetype(p, 400 * SS)
            print("背號字型:", p)
            break
    d.text((W * SS / 2, H * SS / 2), text, font=font, fill=color, anchor="mm")
    finish(im, f"number_{text}.png")


def placket(color=(31, 74, 54, 255)):
    W, H = 256, 1024
    im = canvas(W, H)
    d = ImageDraw.Draw(im)
    for x in (84, 152):
        d.rounded_rectangle([x * SS, 10 * SS, (x + 20) * SS, (H - 10) * SS], radius=8 * SS, fill=color)
    finish(im, "placket.png")


if __name__ == "__main__":
    face(); logo(); number(); placket()
    print("貼圖完成:", sorted(os.listdir(OUT)))
