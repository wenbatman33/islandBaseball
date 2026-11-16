// 建置後從 dist 拿掉不該部署的檔案：候選素材預覽圖（含第三方商品截圖）與烘焙用的中間貼圖。
// 只會動 dist 這個建置輸出資料夾，不會碰原始檔。
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DIST = resolve('dist');
let removed = 0;
function drop(path) {
  const full = resolve(path);
  if (!full.startsWith(DIST + '/') || !existsSync(full)) return; // 保險：只允許刪 dist 底下的東西
  rmSync(full, { recursive: statSync(full).isDirectory() });
  removed++;
}
drop(join(DIST, 'models', '_候選預覽'));
const players = join(DIST, 'models', 'player');
if (existsSync(players)) for (const f of readdirSync(players)) if (f.endsWith('_tex.png')) drop(join(players, f));
console.log(`已從 dist 移除 ${removed} 項不部署的檔案`);
