// 用 codex exec 內建的 image_gen 產生各隊隊徽。一次只跑一張，已存在的會跳過（可中斷續跑）。
// 執行：node scripts/gen_emblems.mjs　　產出：public/teams/<id>.png（512×512）
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { style, items } = JSON.parse(readFileSync(join(ROOT, 'scripts', 'emblem_manifest.json'), 'utf8'));
// Codex 的沙箱可能是唯讀，沒辦法自己把圖放到專案裡：只請它生圖，圖會存在 ~/.codex/generated_images/<工作階段>/，
// 這裡再把這次新產生的那張複製過來並縮成 512×512
const GEN = join(homedir(), '.codex', 'generated_images');
function newestSince(since) {
  let best = null;
  if (!existsSync(GEN)) return null;
  for (const dir of readdirSync(GEN)) {
    const d = join(GEN, dir);
    if (!statSync(d).isDirectory()) continue;
    for (const f of readdirSync(d)) {
      if (!f.endsWith('.png')) continue;
      const m = statSync(join(d, f)).mtimeMs;
      if (m >= since && (!best || m > best.m)) best = { m, path: join(d, f) };
    }
  }
  return best && best.path;
}
for (const it of items) {
  const out = join(ROOT, 'public', 'teams', `${it.id}.png`);
  if (existsSync(out)) continue;
  const since = Date.now() - 1000;
  const prompt = `請用內建 image_gen 工具產一張 1024x1024 的正方形 PNG，只要生圖、不需要複製或處理檔案。主題：${style}${it.prompt}生成後回報 OK 即可。`;
  try {
    execFileSync('codex', ['exec', '--skip-git-repo-check', prompt], { stdio: 'ignore', timeout: 300000 });
  } catch (e) {
    /* 逾時或失敗：下面找不到新圖就會記成失敗，重跑時再補 */
  }
  const src = newestSince(since);
  if (src) {
    copyFileSync(src, out);
    execFileSync('sips', ['-z', '512', '512', out], { stdio: 'ignore' });
  }
  console.log(it.id, existsSync(out) ? '完成' : '失敗');
}
