// 用 codex exec 內建的 image_gen 畫 App 圖示（PWA、加到主畫面用），再縮成各種尺寸。
// 執行：node scripts/gen_icon.mjs　　產出：public/icons/icon-512.png、icon-192.png、apple-touch-icon.png、favicon-32.png，原圖留在 art/ui_master/icon.png
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, mkdirSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const prompt = '請用內建 image_gen 工具產一張正方形（寬高比 1:1）的圖，只要生圖、不需要處理檔案。主題：一款熱血卡通棒球遊戲的 App 圖示，日本運動遊戲等級的專業遊戲美術，亮面立體、厚塗質感。畫面：滿版的深藍色背景帶金黃色的放射狀光芒（背景要鋪滿整張正方形，四個角落也是深藍色，不要留白、不要圓角、不要邊框），正中央是一顆帶紅色縫線的白色棒球，拖著紅橘色的火焰從左下衝向右上，棒球周圍有金色星芒與火花，棒球下方有兩支交叉的金色球棒。主體集中在畫面中央的七成範圍內（四周留空間，圖示會被裁成圓形或圓角）。配色只用深藍、金黃、紅、橘、白。不要任何文字、字母或數字。生成後回報 OK 即可。';
const run = spawnSync('codex', ['exec', '--skip-git-repo-check', prompt], { encoding: 'utf8', timeout: 300000 });
const id = (/session id:\s*([0-9a-f-]+)/.exec(`${run.stdout || ''}${run.stderr || ''}`) || [])[1];
const dir = id && join(homedir(), '.codex', 'generated_images', id);
const png = dir && existsSync(dir) && readdirSync(dir).find((f) => f.endsWith('.png'));
if (!png) {
  console.log('失敗：找不到生成的圖');
  process.exit(1);
}
mkdirSync(join(ROOT, 'art', 'ui_master'), { recursive: true });
mkdirSync(join(ROOT, 'public', 'icons'), { recursive: true });
const master = join(ROOT, 'art', 'ui_master', 'icon.png');
copyFileSync(join(dir, png), master);
for (const [name, size] of [['icon-512', 512], ['icon-192', 192], ['apple-touch-icon', 180], ['favicon-32', 32]]) {
  execFileSync('sips', ['-z', String(size), String(size), master, '--out', join(ROOT, 'public', 'icons', `${name}.png`)], { stdio: 'ignore' });
}
console.log('完成', master);
