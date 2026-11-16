"""把姿勢預覽圖拼成一張：每一欄是一格，每一列是一個視角。
用法：python3 mk_poses.py <資料夾> <動作> <每格邊長> <視角字母> <輸出名> [格號,格號,...]
視角 a/b/c 會裁掉周圍空白（人只佔畫面中央），d 是上半身特寫不裁。"""
import glob, sys
from PIL import Image
d, name, size, views, outn = sys.argv[1], sys.argv[2], int(sys.argv[3]), list(sys.argv[4]), sys.argv[5]
fa = sorted(glob.glob(f'{d}/{name}_*_a.png'))
if len(sys.argv) > 6:
    want = {int(v) for v in sys.argv[6].split(',')}
    fa = [p for p in fa if int(p.split('_')[-2]) in want]
sheet = Image.new('RGB', (size * len(fa), size * len(views)))
for r, v in enumerate(views):
    for i, p in enumerate(fa):
        im = Image.open(p.replace('_a.png', f'_{v}.png')).convert('RGB')
        if v != 'd':
            w, h = im.size
            im = im.crop((int(w * 0.22), int(h * 0.12), int(w * 0.78), int(h * 0.68)))
        sheet.paste(im.resize((size, size)), (i * size, r * size))
sheet.save(f'{d}/{outn}.jpg', quality=88)
