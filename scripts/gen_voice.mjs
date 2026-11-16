// 預錄轉播語音：把 src/commentary.js 列出的每個片段，用 macOS 內建語音唸成音檔，再用 ffmpeg 做廣播後製。
// 執行：node scripts/gen_voice.mjs          （已存在的音檔會跳過；加 --force 全部重做）
// 產出：public/audio/voice/<雜湊>.m4a 與 manifest.json（片段文字 → 檔名）
// 一次只跑一個子程序，跑完就結束，不會留下背景程序。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GAME } from '../src/data.js';
import { allFragments, moodOf } from '../src/commentary.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'audio', 'voice');
const VOICE = process.env.VOICE || 'Meijia';
const FORCE = process.argv.includes('--force');
mkdirSync(OUT, { recursive: true });

// 語氣：用語音指令調整音高（pbas）與語速（rate）
const MOOD = { excite: '[[pbas +5]][[rate 228]]', calm: '[[rate 186]]', '': '[[rate 204]]' };

// 廣播後製：切掉頭尾空白 → 濾掉低頻轟聲與過高頻 → 壓低悶的中低頻、提亮人聲與齒音 → 壓縮讓音量穩定 → 限幅
const FILTER = [
  'silenceremove=start_periods=1:start_threshold=-48dB',
  'areverse', 'silenceremove=start_periods=1:start_threshold=-48dB', 'areverse',
  'highpass=f=110', 'lowpass=f=9500',
  'equalizer=f=240:t=q:w=1:g=-3', 'equalizer=f=3200:t=q:w=1.2:g=5', 'equalizer=f=6500:t=q:w=1.5:g=2',
  'acompressor=threshold=-22dB:ratio=5:attack=4:release=90:makeup=5',
  'alimiter=limit=0.9',
  'afade=t=in:d=0.006',
].join(',');

const { all, intro } = allFragments(GAME);
const manifest = {};
let made = 0;
const tmp = join(tmpdir(), `voice-${process.pid}.aiff`);
try {
  for (const text of all) {
    const file = `${createHash('sha1').update(`${VOICE}|${text}`).digest('hex').slice(0, 12)}.m4a`;
    manifest[text] = file;
    const dst = join(OUT, file);
    if (existsSync(dst) && !FORCE) continue;
    execFileSync('say', ['-v', VOICE, '-o', tmp, `${MOOD[moodOf(text, intro)]}${text}`]);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', tmp, '-af', FILTER, '-ar', '44100', '-ac', '1', '-c:a', 'aac', '-b:a', '72k', dst]);
    made++;
  }
} finally {
  if (existsSync(tmp)) rmSync(tmp);
}
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 0));
console.log(`片段 ${all.length} 個，新產生 ${made} 個，語音 ${VOICE}`);
