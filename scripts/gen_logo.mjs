// 用 codex exec 內建的 image_gen 畫遊戲標誌，再把純綠色背景去掉存成透明 PNG。
// 執行：node scripts/gen_logo.mjs [輸出檔名=logo]　　產出：public/<檔名>.png
// 圖是從這次 Codex 工作階段自己的資料夾取回（~/.codex/generated_images/<session id>/），不會拿錯別的圖。
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const name = process.argv[2] || 'logo';
const prompt = `請用內建 image_gen 工具產一張橫式（寬高比 3:2）的圖，只要生圖、不需要處理檔案。主題：一款熱血卡通棒球遊戲的標題標誌（game title logo），日本運動遊戲標題等級的專業設計。標誌的主體是四個繁體中文大字「島嶼職棒」，四個字必須完全正確、清楚、由左到右排成一行：第一個字「島」、第二個字「嶼」（山字旁加與）、第三個字「職」、第四個字「棒」。字體是粗壯有力、向右上傾斜的立體美術字，白色到金黃色的漸層字面，深藍色的粗外框，再一層紅色的立體厚度與陰影，字的邊緣有速度感的切角。字的後方有一顆帶紅色縫線、拖著火焰與速度線的棒球從左下衝向右上，下方有一條紅色緞帶，緞帶上是英文小字「ISLAND LEAGUE BASEBALL」。整體配色只用白、金黃、紅、橘、深藍，不要使用任何綠色。標誌置中、四周留一點空間，背景是完全均勻的純綠色 #00FF00（去背用），背景不要有任何漸層、陰影或其他圖案。生成後回報 OK 即可。`;
// 工作階段編號印在錯誤輸出，所以兩個輸出都要收
const run = spawnSync('codex', ['exec', '--skip-git-repo-check', prompt], { encoding: 'utf8', timeout: 300000 });
const log = `${run.stdout || ''}${run.stderr || ''}`;
const id = (/session id:\s*([0-9a-f-]+)/.exec(log) || [])[1];
const dir = id && join(homedir(), '.codex', 'generated_images', id);
const png = dir && existsSync(dir) && readdirSync(dir).find((f) => f.endsWith('.png'));
if (!png) {
  console.log('失敗：找不到生成的圖');
  process.exit(1);
}
// 去掉綠色背景（含邊緣的綠色溢色），裁掉四周空白
execFileSync('python3', ['-c', `
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGB')
out = []
for r, g, b in im.getdata():
    key = g - max(r, b)                       # 綠色比紅藍多出多少
    if key <= 40:
        a = 255
    elif key >= 110:
        a = 0
    else:
        a = int(255 * (1 - (key - 40) / 70))
    if key > 0:
        g = max(r, b) + (0 if key > 40 else int(key * (1 - key / 40)))  # 邊緣的綠色溢色壓回去
    out.append((r, g, b, a))
img = Image.new('RGBA', im.size)
img.putdata(out)
box = img.getchannel('A').point(lambda v: 255 if v > 24 else 0).getbbox()
img = img.crop(box)
img.thumbnail((1400, 1400), Image.LANCZOS)
img.save(sys.argv[2])
print(img.size)
`, join(dir, png), join(ROOT, 'public', `${name}.png`)], { stdio: 'inherit' });
console.log('完成', join(dir, png));
