"""把球隊故事插畫（art/story/<id>.png）排成「球隊故事」圖卡：上面是插畫，下面是隊徽、隊名、台詞、故事與重點資料。
執行：python3 scripts/make_story_card.py [隊伍 id…]　　產出：design/team-story/<id>.jpg（1080×1440）
文字來自 scripts/story_manifest.json，隊名、隊色、戰績、台詞來自 src/data.js。"""
import json
import os
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
W, H = 1080, 1440
PANEL_Y = 830  # 文字面板從這裡開始（插畫的重點都在這之上）
NAVY, GOLD, RED, INK = (18, 35, 90), (255, 217, 46), (232, 55, 44), (5, 10, 32)

# 系統的蘋方（繁體）；找不到就退回黑體
PINGFANG = '/System/Library/AssetsV2/com_apple_MobileAsset_Font8/86ba2c91f017a3749571a82f2c6d890ac7ffb2fb.asset/AssetData/PingFang.ttc'
HEITI = '/System/Library/Fonts/STHeiti Medium.ttc'


def font(size, weight='Semibold'):
    if os.path.exists(PINGFANG):
        for i in range(40):
            try:
                f = ImageFont.truetype(PINGFANG, size, index=i)
            except OSError:
                break
            if f.getname() == ('PingFang TC', weight):
                return f
    return ImageFont.truetype(HEITI, size, index=0)


def hexrgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def wrap(draw, text, f, width):
    """中文逐字斷行；標點不放在行首。"""
    lines, cur = [], ''
    for ch in text:
        if draw.textlength(cur + ch, font=f) > width and cur:
            if ch in '，。、；：！？」）':
                cur += ch  # 標點擠在上一行尾巴
                continue
            if ch == '—' and cur.endswith('—'):
                lines.append(cur[:-1])  # 破折號兩個一組：整組移到下一行開頭
                cur = '——'
                continue
            if ch == '—':
                lines.append(cur)  # 破折號整組移到下一行開頭
                cur = ch
                continue
            lines.append(cur)
            cur = ch
        else:
            cur += ch
    if cur:
        lines.append(cur)
    return lines


def teams():
    js = "import('./src/data.js').then(({TEAMS})=>console.log(JSON.stringify(TEAMS.map(t=>({id:t.id,name:t.name,line:t.line,record:t.record,ovr:t.ovr,c1:t.c1,c2:t.c2})))))"
    out = subprocess.run(['node', '-e', js], cwd=ROOT, capture_output=True, text=True, check=True).stdout
    return {t['id']: t for t in json.loads(out)}


def make(it, t):
    src = os.path.join(ROOT, 'art', 'story', f"{it['id']}.png")
    if not os.path.exists(src):
        print(it['id'], '還沒有插畫，略過')
        return
    c1, c2 = hexrgb(t['c1']), hexrgb(t['c2'])
    card = Image.new('RGB', (W, H), INK)
    art = Image.open(src).convert('RGB').resize((W, W), Image.LANCZOS)
    card.paste(art, (0, 0))

    # 面板：插畫往下漸漸沉進深藍，再接一塊帶隊色的深色底
    fade = Image.new('L', (1, H), 0)
    for y in range(H):
        k = min(1, max(0, (y - (PANEL_Y - 110)) / 140))
        fade.putpixel((0, y), int(255 * k ** 1.3))
    base = Image.new('RGB', (W, H), tuple(int(INK[i] * 0.55 + c1[i] * 0.2 + NAVY[i] * 0.25) for i in range(3)))
    card.paste(base, (0, 0), fade.resize((W, H)))
    d = ImageDraw.Draw(card)

    # 隊色斜條（面板上緣）
    d.polygon([(0, PANEL_Y + 6), (W, PANEL_Y - 34), (W, PANEL_Y - 22), (0, PANEL_Y + 18)], fill=GOLD)
    d.polygon([(0, PANEL_Y + 18), (W, PANEL_Y - 22), (W, PANEL_Y - 14), (0, PANEL_Y + 26)], fill=c2)

    # 隊徽
    x0 = 60
    emb_path = os.path.join(ROOT, 'public', 'teams', f"{it['id']}.webp")
    if os.path.exists(emb_path):
        emb = Image.open(emb_path).convert('RGBA').resize((170, 170), Image.LANCZOS)
        # 隊徽原圖是白色方底：切成圓形，外面套一圈金邊
        mask = Image.new('L', (680, 680), 0)
        ImageDraw.Draw(mask).ellipse((14, 14, 666, 666), fill=255)
        emb.putalpha(mask.resize((170, 170), Image.LANCZOS))
        sh = Image.new('RGBA', (emb.width + 40, emb.height + 40), (0, 0, 0, 0))
        sh.paste((0, 0, 0, 150), (20, 26), emb.split()[3])
        card.paste(sh.filter(ImageFilter.GaussianBlur(9)), (x0 - 20, PANEL_Y + 34 - 20), sh.filter(ImageFilter.GaussianBlur(9)))
        card.paste(emb, (x0, PANEL_Y + 34), emb)
        d.ellipse((x0 + 1, PANEL_Y + 35, x0 + 169, PANEL_Y + 203), outline=GOLD, width=5)
    tx = x0 + 200

    # 小標、隊名、台詞
    d.text((tx, PANEL_Y + 44), 'TEAM STORY　球隊故事', font=font(24), fill=GOLD)
    d.text((tx, PANEL_Y + 78), t['name'], font=font(78), fill=(255, 255, 255), stroke_width=5, stroke_fill=INK)
    d.text((tx + 4, PANEL_Y + 178), f"「{t['line']}」", font=font(27, 'Medium'), fill=(201, 214, 255))

    # 故事
    fs = font(30, 'Medium')
    y = PANEL_Y + 232
    for ln in wrap(d, it['story'], fs, W - 120):
        d.text((60, y), ln, font=fs, fill=(244, 246, 255))
        y += 46

    # 重點資料：四格
    cells = [('所在地', it['place']), ('球風', it['style_tag']), ('招牌球員', it['star']), ('王牌投手', it['ace'])]
    fy = H - 126
    d.line([(60, fy - 18), (W - 60, fy - 18)], fill=(111, 134, 214), width=2)
    fl, fv = font(21), font(26)
    widths = [max(d.textlength(a, font=fl), d.textlength(b, font=fv)) for a, b in cells]
    gap = (W - 120 - sum(widths)) / (len(cells) - 1)
    x = 60
    for (a, b), w in zip(cells, widths):
        d.text((x, fy), a, font=fl, fill=GOLD)
        d.text((x, fy + 32), b, font=fv, fill=(255, 255, 255))
        x += w + gap
    # 頁尾
    d.text((60, H - 44), f"島嶼職棒　ISLAND LEAGUE BASEBALL　・　本季 {t['record']}", font=font(20, 'Medium'), fill=(150, 168, 220))

    out_dir = os.path.join(ROOT, 'design', 'team-story')
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, f"{it['id']}.jpg")
    card.save(out, quality=90, optimize=True)
    print(it['id'], '完成', out, '故事行數', len(wrap(d, it['story'], fs, W - 120)), '故事底', y, '資料列頂', fy - 18)


if __name__ == '__main__':
    man = json.load(open(os.path.join(ROOT, 'scripts', 'story_manifest.json'), encoding='utf-8'))
    T = teams()
    only = sys.argv[1:]
    for it in man['items']:
        if only and it['id'] not in only:
            continue
        make(it, T[it['id']])
