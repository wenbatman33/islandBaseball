// 預錄轉播語音：把 src/commentary.js 列出的每個片段，用神經網路語音（台灣男聲）唸成音檔，再用 ffmpeg 做廣播後製。
// 需要先裝好 edge-tts：python3 -m venv .venv-tts && .venv-tts/bin/pip install edge-tts
// 執行：node scripts/gen_voice.mjs          （已存在的音檔會跳過；加 --force 全部重做）
// 產出：public/audio/voice/<雜湊>.m4a 與 manifest.json（片段文字 → 檔名）
// 一次只跑一個子程序，跑完就結束，不會留下背景程序。線上服務偶爾會回空檔，會自動重試。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GAME } from '../src/data.js';
import { allFragments, moodOf } from '../src/commentary.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'audio', 'voice');
const VOICE = process.env.VOICE || 'zh-TW-YunJheNeural';
const TTS = join(ROOT, '.venv-tts', 'bin', 'edge-tts');
if (!existsSync(TTS)) {
  console.error('找不到 .venv-tts/bin/edge-tts，請先依檔頭說明安裝');
  process.exit(1);
}
const FORCE = process.argv.includes('--force');
mkdirSync(OUT, { recursive: true });

// 語氣：[語速, 音高]。hr＝全壘打的吶喊，excite＝激動，calm＝開場的穩重口吻
const MOOD = { hr: ['+30%', '+24Hz'], excite: ['+24%', '+12Hz'], calm: ['+12%', '+2Hz'], '': ['+16%', '+3Hz'] };
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// 唸一句存成檔案；服務回空檔或出錯就等一下重試
function speak(text, mood, file) {
  const [rate, pitch] = MOOD[mood];
  for (let i = 0; i < 12; i++) {
    try {
      execFileSync(TTS, ['--voice', VOICE, `--rate=${rate}`, `--pitch=${pitch}`, '--text', text, '--write-media', file], { stdio: 'ignore', timeout: 60000 });
      if (existsSync(file) && statSync(file).size > 2000) return true;
    } catch (e) {
      /* 重試 */
    }
    sleep(1500 + i * 500);
  }
  return false;
}

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
const tmp = join(tmpdir(), `voice-${process.pid}.mp3`);
const failed = [];
try {
  for (const text of all) {
    const file = `${createHash('sha1').update(`${VOICE}|${text}`).digest('hex').slice(0, 12)}.m4a`;
    manifest[text] = file;
    const dst = join(OUT, file);
    if (existsSync(dst) && !FORCE) continue;
    if (!speak(text, moodOf(text, intro), tmp)) {
      failed.push(text);
      delete manifest[text]; // 沒錄到的句子不列入，遊戲會退回系統語音，下次重跑再補
      continue;
    }
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', tmp, '-af', FILTER, '-ar', '44100', '-ac', '1', '-c:a', 'aac', '-b:a', '72k', dst]);
    made++;
    if (made % 20 === 0) console.log(`已完成 ${made} 個`);
  }
} finally {
  if (existsSync(tmp)) rmSync(tmp);
}
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 0));
console.log(`片段 ${all.length} 個，新產生 ${made} 個，失敗 ${failed.length} 個，語音 ${VOICE}`);
if (failed.length) console.log('失敗的句子：\n' + failed.join('\n'));
