// 用 codex exec 內建的 image_gen 畫賽後畫面的插畫（每隊贏球、輸球各一張，加一張平手）。一次一張，已存在的會跳過。
// 執行：node scripts/gen_result.mjs [id…]　　產出：public/teams/result/<id>.jpg（寬 1280）
// 圖從這次 Codex 工作階段自己的資料夾取回（~/.codex/generated_images/<session id>/），不會拿錯別的圖。
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { style, items } = JSON.parse(readFileSync(join(ROOT, 'scripts', 'result_manifest.json'), 'utf8'));
const OUT = join(ROOT, 'public', 'teams', 'result');
mkdirSync(OUT, { recursive: true });
const only = process.argv.slice(2);
for (const it of items) {
  if (only.length && !only.some((o) => it.id === o || it.id.startsWith(o))) continue;
  const out = join(OUT, `${it.id}.jpg`);
  if (existsSync(out)) continue;
  const prompt = `請用內建 image_gen 工具產一張橫式（寬高比 16:9）的插畫，只要生圖、不需要處理檔案。主題：${style}${it.prompt}生成後回報 OK 即可。`;
  const run = spawnSync('codex', ['exec', '--skip-git-repo-check', prompt], { encoding: 'utf8', timeout: 300000 });
  const id = (/session id:\s*([0-9a-f-]+)/.exec(`${run.stdout || ''}${run.stderr || ''}`) || [])[1];
  const dir = id && join(homedir(), '.codex', 'generated_images', id);
  const png = dir && existsSync(dir) && readdirSync(dir).find((f) => f.endsWith('.png'));
  if (png) execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '84', '-Z', '1280', join(dir, png), '--out', out], { stdio: 'ignore' });
  console.log(it.id, existsSync(out) ? '完成' : '失敗');
}
