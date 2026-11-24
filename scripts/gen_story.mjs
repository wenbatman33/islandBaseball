// 用 codex exec 內建的 image_gen 畫各隊的「球隊故事」插畫（交代球隊由來與地方風土的一幕）。一次一張，已存在的會跳過。
// 執行：node scripts/gen_story.mjs [隊伍 id…]　　產出：art/story/<id>.png（原圖），再用 scripts/make_story_card.py 排成故事圖卡
// 圖從這次 Codex 工作階段自己的資料夾取回（~/.codex/generated_images/<session id>/），不會拿錯別的圖。
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { style, items } = JSON.parse(readFileSync(join(ROOT, 'scripts', 'story_manifest.json'), 'utf8'));
const OUT = join(ROOT, 'art', 'story');
mkdirSync(OUT, { recursive: true });
const only = process.argv.slice(2);
for (const it of items) {
  if (only.length && !only.includes(it.id)) continue;
  const out = join(OUT, `${it.id}.png`);
  if (existsSync(out)) continue;
  const prompt = `請用內建 image_gen 工具產一張正方形（寬高比 1:1）的插畫，只要生圖、不需要處理檔案。主題：${style}${it.prompt}生成後回報 OK 即可。`;
  const run = spawnSync('codex', ['exec', '--skip-git-repo-check', prompt], { encoding: 'utf8', timeout: 300000 });
  const id = (/session id:\s*([0-9a-f-]+)/.exec(`${run.stdout || ''}${run.stderr || ''}`) || [])[1];
  const dir = id && join(homedir(), '.codex', 'generated_images', id);
  const png = dir && existsSync(dir) && readdirSync(dir).find((f) => f.endsWith('.png'));
  if (png) copyFileSync(join(dir, png), out);
  console.log(it.id, existsSync(out) ? '完成' : '失敗');
}
