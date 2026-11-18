// 用 codex exec 內建的 image_gen 畫各隊的故事主視覺（選隊對決畫面用）。一次一張，已存在的會跳過。
// Codex 的沙箱可能是唯讀：只請它生圖，圖存在 ~/.codex/generated_images/，這裡再取回來轉成 JPEG。
// 執行：node scripts/gen_art.mjs [隊伍 id…]　　產出：public/teams/art/<id>.jpg（1024×1024）
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { style, items } = JSON.parse(readFileSync(join(ROOT, 'scripts', 'art_manifest.json'), 'utf8'));
const OUT = join(ROOT, 'public', 'teams', 'art');
mkdirSync(OUT, { recursive: true });
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
const only = process.argv.slice(2);
for (const it of items) {
  if (only.length && !only.includes(it.id)) continue;
  const out = join(OUT, `${it.id}.jpg`);
  if (existsSync(out)) continue;
  const since = Date.now() - 1000;
  const prompt = `請用內建 image_gen 工具產一張正方形（寬高比 1:1）的插畫，只要生圖、不需要處理檔案。主題：${style}${it.prompt}生成後回報 OK 即可。`;
  try {
    execFileSync('codex', ['exec', '--skip-git-repo-check', prompt], { stdio: 'ignore', timeout: 300000 });
  } catch (e) {
    /* 逾時或失敗：下面找不到新圖就記成失敗，重跑時再補 */
  }
  const src = newestSince(since);
  if (src) execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '86', '-Z', '1024', src, '--out', out], { stdio: 'ignore' });
  console.log(it.id, existsSync(out) ? '完成' : '失敗');
}
