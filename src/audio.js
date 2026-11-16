// 合成音效（不需要音檔）。第一次點擊或按鍵後才會啟動。
// 按鍵：M 全部靜音、B 應援團開關、V 轉播語音開關
let ctx = null;
let master = null;
let noiseBuf = null;
let crowdBus = null; // 觀眾聲（底噪、歡呼、應援）都走這裡，播報時整個壓低
let voiceBus = null; // 轉播語音
let muted = false;

function init() {
  if (ctx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = 0.5;
  master.connect(ctx.destination);
  crowdBus = ctx.createGain();
  crowdBus.connect(master);
  // 語音再過一道壓縮，音量才會穩穩蓋在現場聲上面
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -20;
  comp.ratio.value = 3;
  comp.attack.value = 0.004;
  comp.release.value = 0.12;
  voiceBus = ctx.createGain();
  voiceBus.gain.value = 1.5;
  voiceBus.connect(comp).connect(master);
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  // 場內人聲底噪
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = 650;
  f.Q.value = 0.5;
  const g = ctx.createGain();
  g.gain.value = 0.035;
  src.connect(f).connect(g).connect(crowdBus);
  src.start();
}

function noise({ dur, type = 'bandpass', freq, freqEnd, q = 1, gain, attack = 0.004, dest = null }) {
  if (!ctx || muted) return;
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, t);
  if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(dest || master);
  src.start(t, Math.random());
  src.stop(t + dur + 0.05);
}

function tone({ dur, freq, freqEnd, gain, type = 'triangle' }) {
  if (!ctx || muted) return;
  const t = ctx.currentTime;
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.02);
}

export const sfx = {
  // 擊球聲（原創合成）：q 越高越紮實。三層疊起來：
  //   1. 極短的高頻爆音＝球棒碰到球的那一下
  //   2. 幾個不成整數倍的高音＝金屬般清脆的「鏘」，打得越紮實越亮、餘音越長
  //   3. 低頻的一下「咚」＝力道感
  // 擦棒或打不紮實（q 低）時，高音少、聲音短而悶
  hit(q = 0.7) {
    if (!ctx || muted) return;
    const t = ctx.currentTime;
    noise({ dur: 0.035 + q * 0.02, type: 'highpass', freq: 2600 + q * 2600, gain: 0.55 + q * 0.6, attack: 0.001 });
    noise({ dur: 0.09, type: 'bandpass', freq: 1500 + q * 900, q: 1.2, gain: 0.25 + q * 0.2, attack: 0.002 });
    const ring = 0.1 + q * q * 0.42; // 餘音長度
    const base = 1650 + q * 520;
    [[1, 0.5], [1.52, 0.34], [2.31, 0.24], [3.42, 0.14], [4.63, 0.08]].forEach(([mul, amp], i) => {
      if (i > 1 + q * 4) return; // 打不紮實就沒有上面那幾個泛音
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(base * mul * (1 + (Math.random() - 0.5) * 0.012), t);
      o.frequency.exponentialRampToValueAtTime(base * mul * 0.985, t + ring);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(amp * (0.25 + q * 0.5), t + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, t + ring / (1 + i * 0.35));
      o.connect(g).connect(master);
      o.start(t);
      o.stop(t + ring + 0.05);
    });
    tone({ dur: 0.07, freq: 240 + q * 60, freqEnd: 110, gain: 0.3 + q * 0.35, type: 'sine' });
  },
  pop() {
    noise({ dur: 0.08, type: 'lowpass', freq: 900, gain: 0.5 });
  },
  swing() {
    noise({ dur: 0.16, freq: 380, freqEnd: 1300, q: 1.6, gain: 0.22, attack: 0.03 });
  },
  call(strike) {
    tone({ dur: 0.13, freq: strike ? 560 : 380, freqEnd: strike ? 700 : 330, gain: 0.1, type: 'square' });
  },
  cheer(level = 0.6) {
    noise({ dur: 1.4 + level * 1.8, freq: 900, freqEnd: 1300, q: 0.5, gain: 0.1 + level * 0.3, attack: 0.25, dest: crowdBus });
  },
};

// ── 應援：鼓、拍手、照「安打、安打、全壘打」節奏的群眾呼聲（全部合成，沒有真的字） ──
let bandOn = true;
let bandGain = null;
let bandTimer = null;
let bandNext = 0;
let bandStep = 0;
const BPM = 132;
const BEAT = 60 / BPM;

function drum(t, strong) {
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(strong ? 120 : 150, t);
  o.frequency.exponentialRampToValueAtTime(48, t + 0.16);
  const g = ctx.createGain();
  g.gain.setValueAtTime(strong ? 0.9 : 0.55, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
  o.connect(g).connect(bandGain);
  o.start(t);
  o.stop(t + 0.25);
}

// 群眾的一聲呼喊：只用噪音塑形、不帶音高（帶音高的振盪器聽起來像機器）。
// 兩個共振峰讓它有一點「喔」「嘿」的感覺，每次的頻率和長度都略有不同
function shout(t, dur, level = 1) {
  const n = ctx.createBufferSource();
  n.buffer = noiseBuf;
  n.loop = true;
  const out = ctx.createGain();
  out.gain.setValueAtTime(0.0001, t);
  out.gain.exponentialRampToValueAtTime(0.55 * level, t + 0.05);
  out.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  for (const [f, q, amp] of [[620 + Math.random() * 120, 2.2, 1], [1250 + Math.random() * 250, 2.6, 0.5]]) {
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(f, t);
    bp.frequency.linearRampToValueAtTime(f * 0.86, t + dur);
    bp.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = amp;
    n.connect(bp).connect(g).connect(out);
  }
  out.connect(bandGain);
  n.start(t, Math.random() * 1.5);
  n.stop(t + dur + 0.05);
}

// 拍手：很短的高頻噪音，三下疊在一起、時間略為錯開，聽起來像一群人
function clap(t, level = 1) {
  for (let i = 0; i < 3; i++) {
    const tt = t + i * 0.011 + Math.random() * 0.006;
    const n = ctx.createBufferSource();
    n.buffer = noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1500 + Math.random() * 900;
    bp.Q.value = 0.9;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, tt);
    g.gain.exponentialRampToValueAtTime(0.5 * level, tt + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, tt + 0.07);
    n.connect(bp).connect(g).connect(bandGain);
    n.start(tt, Math.random() * 1.5);
    n.stop(tt + 0.1);
  }
}

// 16 拍一個循環：前 8 拍鼓加拍手（咚、咚、咚咚咚），後 8 拍照「安打、安打、全壘打」的節奏呼喊兩次
function bandBar(step, t) {
  const b = step % 16;
  const h = BEAT / 2;
  if (b < 8) {
    const c = b % 4;
    drum(t, c === 0);
    if (c < 2) clap(t, 0.8);
    else if (c === 2) {
      clap(t, 0.9);
      clap(t + h, 0.9);
      drum(t + h, false);
    } else clap(t, 1);
  } else {
    const c = (b - 8) % 4;
    drum(t, c === 0);
    if (c === 0 || c === 1) {
      shout(t, h * 0.9); // 安
      shout(t + h, h * 0.9); // 打
    } else if (c === 2) {
      shout(t, h * 0.9); // 全
      shout(t + h, h * 0.9); // 壘
    } else {
      shout(t, BEAT * 1.0, 1.25); // 打——
    }
  }
}

function bandTick() {
  if (!ctx || !bandGain) return;
  while (bandNext < ctx.currentTime + 0.25) {
    if (bandOn && !muted && bandGain.gain.value > 0.001) bandBar(bandStep, bandNext);
    bandStep++;
    bandNext += BEAT;
  }
}

// 遊戲進入比賽時呼叫 band(true)；回到開場或暫停時 band(false)
export function band(on) {
  if (!ctx) {
    band.pending = on;
    return;
  }
  if (!bandGain) {
    bandGain = ctx.createGain();
    bandGain.gain.value = 0;
    bandGain.connect(crowdBus);
    bandNext = ctx.currentTime + 0.3;
    bandTimer = setInterval(bandTick, 80);
  }
  bandGain.gain.setTargetAtTime(on && bandOn ? 0.1 : 0, ctx.currentTime, 0.4);
  band.want = on;
}

// ── 轉播語音：用瀏覽器內建的語音合成唸中文（音質取決於電腦安裝的語音） ──
let voiceOn = true;
let voice = null;
let voiceUntil = 0; // 重要播報唸完之前，不讓好球壞球這種短句插進來
function pickVoice() {
  const vs = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
  // 優先用高品質語音（要在系統設定裡另外下載），其次是一般的台灣中文語音；
  // 避開聲音比較怪的趣味語音（Eddy、Flo、Grandma 這類）
  const tw = vs.filter((v) => /zh[-_]TW/i.test(v.lang));
  const novelty = /Eddy|Flo|Grandma|Grandpa|Reed|Rocko|Sandy|Shelley/i;
  voice =
    tw.find((v) => /premium|enhanced|高品質|優化|siri/i.test(v.name)) ||
    tw.find((v) => !novelty.test(v.name)) ||
    tw[0] ||
    vs.find((v) => /^zh/i.test(v.lang)) ||
    null;
}
if (window.speechSynthesis) {
  pickVoice();
  window.speechSynthesis.addEventListener('voiceschanged', pickVoice);
}

/** 從幾種說法裡隨機挑一種，同樣的事件不會每次都講一模一樣的話 */
export const pick = (list) => list[Math.floor(Math.random() * list.length)];

/**
 * 唸一句播報。important：重要的句子會打斷正在唸的，並在唸完前擋掉不重要的短句。
 * mood：'calm' 平穩的介紹、'excite' 安打或三振時拉高拉快、預設是一般的播報語氣
 */
export function say(text, important = false, mood = '') {
  if (!voiceOn || muted || !window.speechSynthesis || !text) return;
  const now = performance.now();
  if (!important && now < voiceUntil) return;
  if (important) window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  if (voice) u.voice = voice;
  u.lang = voice ? voice.lang : 'zh-TW';
  u.rate = mood === 'excite' ? 1.32 : mood === 'calm' ? 1.08 : important ? 1.18 : 1.3;
  u.pitch = mood === 'excite' ? 1.28 : mood === 'calm' ? 0.98 : 1.05;
  u.volume = 0.95;
  if (important) voiceUntil = now + 500 + text.length * 190;
  window.speechSynthesis.speak(u);
}

// ── 預錄的轉播語音（scripts/gen_voice.mjs 產生）。每句播報由幾個片段的音檔接起來 ──
const clips = new Map(); // 片段文字 → AudioBuffer
let voiceLoading = false;
let voiceReady = false; // 音檔全部載入完（或確定載入失敗）
let voiceEnd = 0; // 目前這句播到什麼時候（AudioContext 的時間）
let voiceSources = [];
export const voiceStatus = { total: 0, loaded: 0, played: 0, fallback: 0 }; // 檢查用

async function loadVoice() {
  if (voiceLoading || !ctx) return;
  voiceLoading = true;
  try {
    const manifest = await (await fetch('audio/voice/manifest.json')).json();
    const entries = Object.entries(manifest);
    voiceStatus.total = entries.length;
    let i = 0;
    const worker = async () => {
      while (i < entries.length) {
        const [text, file] = entries[i++];
        try {
          const buf = await (await fetch(`audio/voice/${file}`)).arrayBuffer();
          clips.set(text, await ctx.decodeAudioData(buf));
          voiceStatus.loaded++;
        } catch (e) {
          /* 單一音檔載入失敗：那一句會退回用系統語音唸 */
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  } catch (e) {
    /* 沒有預錄音檔時全部退回系統語音 */
  }
  voiceReady = true;
}

/**
 * 播一句轉播。parts：片段陣列（見 src/commentary.js）。
 * important：重要的句子會打斷正在播的；不重要的短句（好球、壞球）遇到正在播報就略過。
 * 片段都有預錄音檔時播音檔，並在播報期間把觀眾聲壓低；缺任何一個就退回系統語音。
 */
export function sayParts(parts, important = false, mood = '', tries = 0) {
  parts = parts.filter(Boolean);
  if (!voiceOn || muted || !parts.length) return;
  // 音檔還在載入：重要的句子等一下再播（最多等 4 秒），不要急著退回系統語音；不重要的短句直接略過
  if (ctx && voiceLoading && !voiceReady) {
    if (important && tries < 16) setTimeout(() => sayParts(parts, important, mood, tries + 1), 250);
    return;
  }
  if (!ctx || !parts.every((p) => clips.has(p))) {
    voiceStatus.fallback++;
    say(parts.join('，'), important, mood);
    return;
  }
  const now = ctx.currentTime;
  if (!important && now < voiceEnd) return;
  voiceSources.forEach((src) => {
    try {
      src.stop();
    } catch (e) {
      /* 已經播完 */
    }
  });
  voiceSources = [];
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  let t = now + 0.03;
  const t0 = t;
  for (const p of parts) {
    const buf = clips.get(p);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(voiceBus);
    src.start(t);
    voiceSources.push(src);
    t += buf.duration + (/[！。？，]$/.test(p) ? 0.11 : 0.035); // 句尾有標點就多停一下
  }
  voiceEnd = t;
  voiceStatus.played++;
  // 播報時把觀眾聲壓低，講完再慢慢放回來
  crowdBus.gain.cancelScheduledValues(now);
  crowdBus.gain.setTargetAtTime(0.3, t0, 0.06);
  crowdBus.gain.setTargetAtTime(1, t + 0.1, 0.4);
}

export function initAudio() {
  // 頁面一打開就先建立音訊並載入、解碼預錄語音（瀏覽器要等使用者點擊才會真的出聲，
  // 但載入和解碼可以先做），這樣第一句播報就是預錄的
  init();
  loadVoice();
  const kick = () => {
    init();
    if (ctx && ctx.state === 'suspended') ctx.resume();
    loadVoice();
    if (ctx && band.pending !== undefined) {
      const want = band.pending;
      band.pending = undefined;
      band(want);
    }
  };
  window.addEventListener('pointerdown', kick);
  window.addEventListener('keydown', (e) => {
    kick();
    if (e.key === 'm' || e.key === 'M') {
      muted = !muted;
      if (master) master.gain.value = muted ? 0 : 0.5;
      if (muted && window.speechSynthesis) window.speechSynthesis.cancel();
    }
    if (e.key === 'b' || e.key === 'B') {
      bandOn = !bandOn;
      band(!!band.want);
    }
    if (e.key === 'v' || e.key === 'V') {
      voiceOn = !voiceOn;
      if (!voiceOn) {
        if (window.speechSynthesis) window.speechSynthesis.cancel();
        voiceSources.forEach((src) => {
          try {
            src.stop();
          } catch (err) {
            /* 已經播完 */
          }
        });
      }
    }
  });
}
