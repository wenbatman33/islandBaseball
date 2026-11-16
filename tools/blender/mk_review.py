"""把審查圖拼成四張 2x2 的總覽。用法：python3 mk_review.py <審查資料夾>"""
import sys
from PIL import Image
d = sys.argv[1]
sets = {'r1': ['f_000', 'f_025', 'f_045', 'f_055'], 'r2': ['f_075', 'f_090', 'f_135', 'f_180'],
        'r3': ['f_low_010', 'f_low_045', 'f_high_025', 'f_m045'], 'r4': ['b_025', 'b_low_015', 'b_180', 'b_high_045']}
for nm, names in sets.items():
    ims = [Image.open(f'{d}/{n}.png').convert('RGB') for n in names]
    w, h = ims[0].size
    sheet = Image.new('RGB', (w * 2, h * 2))
    for i, im in enumerate(ims):
        sheet.paste(im, ((i % 2) * w, (i // 2) * h))
    sheet.save(f'{d}/{nm}.jpg', quality=90)
