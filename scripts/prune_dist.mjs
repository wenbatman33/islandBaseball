// 建置後從 dist 拿掉不該部署的檔案：候選素材預覽圖（含第三方商品截圖）與烘焙用的中間貼圖。
// 只會動 dist 這個建置輸出資料夾，不會碰原始檔。
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
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
// 球員模型：只部署遊戲正在用的那一個（舊版模型留在本機的 public 裡，但不上線）
const PLAYER_MODEL = 'player_v7.glb';
if (existsSync(players)) for (const f of readdirSync(players)) if (f.endsWith('.glb') && f !== PLAYER_MODEL) drop(join(players, f));
// 轉播語音：只部署目前句庫用到的音檔（換過語音或改過句子後留下的舊音檔不帶上線）
const voice = join(DIST, 'audio', 'voice');
if (existsSync(join(voice, 'manifest.json'))) {
  const used = new Set(Object.values(JSON.parse(readFileSync(join(voice, 'manifest.json'), 'utf8'))));
  for (const f of readdirSync(voice)) if (f.endsWith('.m4a') && !used.has(f)) drop(join(voice, f));
}
// 試用模型（public/lab）：只部署遊戲會用到的（預設的四個角色、?model=meshy 的守備員、?model=real 的寫實球員），其餘是測試頁的中間檔
const lab = join(DIST, 'lab');
const LAB_KEEP = new Set(['tripo_batter.glb', 'tripo_fielder.glb', 'tripo_catcher.glb', 'tripo_umpire.glb', 'chibi_batter.glb', 'chibi_fielder.glb', 'chibi_catcher.glb', 'chibi_umpire.glb', 'batter_pro_game.glb']);
if (existsSync(lab)) for (const f of readdirSync(lab)) if (f.endsWith('.glb') && !LAB_KEEP.has(f)) drop(join(lab, f));
// 應援曲試聽用的音檔（cheer-test.html）不部署
drop(join(DIST, 'audio', 'cheer', 'samples'));
console.log(`已從 dist 移除 ${removed} 項不部署的檔案`);
