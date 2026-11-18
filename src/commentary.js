// 只播大場面：三振、安打、全壘打、得分、比賽結束。
// 開場介紹、打者上場介紹、換局、好球壞球界外、出局數、一般出局都不出聲（畫面字卡與音效照舊）。
// 轉播句庫：每一句播報由一到幾個「片段」組成，每個片段對應一個預錄音檔。
// 片段盡量是完整的一句（打者介紹、三振、換局都是一句到底），聽起來才像主播在講，不是一個詞一個詞拼的。
// 遊戲（播放）和 scripts/gen_voice.mjs（預錄）共用這一份，兩邊才會一致。
// 這個檔不可以用到瀏覽器專屬的東西，因為預錄腳本是在 Node 裡載入它。

import { TEAMS } from './data.js';

export const POS_NAME = {
  P: '投手', C: '捕手', '1B': '一壘手', '2B': '二壘手', '3B': '三壘手', SS: '游擊手',
  LF: '左外野手', CF: '中外野手', RF: '右外野手', DH: '指定打擊',
};
const NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];
const pick = (list) => list[Math.floor(Math.random() * list.length)];

const SWING = ['揮棒落空！', '出棒，沒有碰到！', '揮空！被這顆球騙到了。'];
const STRIKE = ['好球！', '好球進壘。', '站著看，好球！', '漂亮的一球，好球。'];
const K_GENERIC = ['三振出局！', '投手拿下這次三振！'];
const HIT_PRE = ['打出去了！', '這球打得很紮實！', '咬中了！'];
const HR_CALL = ['這球很高、很遠！', '出去啦！全壘打！'];
const GOOD_RESULTS = new Set(['場地規則二壘安打', '內野安打', '一壘安打', '二壘安打', '三壘安打', '高飛犧牲打']);
const RBI = (n) => `${NUM[Math.min(4, n)]}分打點！`;
const WALK_RUN = (n) => `擠回${NUM[Math.min(4, n)]}分！`;

const WIN = (team) => `比賽結束！${team}，拿下今天的勝利！`;
const TIE = '比賽結束，雙方握手言和，以平手收場。';

// ── 每一種播報（回傳片段陣列；空陣列＝不出聲）──
export const line = {
  ball: () => [],
  swing: () => [],
  strike: () => [],
  foul: () => [],
  strikeout: () => [pick(K_GENERIC)],
  walk: (runs) => (runs ? [WALK_RUN(runs)] : []), // 保送本身不播，擠回分數才播
  change: () => [],
  result(name, text, good, runs) {
    const parts = [];
    // 不唸球員姓名：八隊八十位球員，句子越短越乾淨
    if (text === '全壘打') parts.push(HR_CALL[0], HR_CALL[1]);
    else if (good) parts.push(pick(HIT_PRE), `${text}${GOOD_RESULTS.has(text) ? '！' : '。'}`);
    if (runs) parts.push(RBI(runs));
    return parts;
  },
  batter: () => [],
  gameOver: (winner) => [winner ? WIN(winner) : TIE],
};

// ── 開場介紹（每段一整句）──
// 已停用：回傳空物件，開場鏡頭照常跑，只是沒有旁白
export function introLines() {
  return {};
}

// 語氣：預錄時用。hr＝全壘打的吶喊；excite＝激動（音調拉高、語速加快）；calm＝開場的穩重口吻
const HR_SET = new Set(HR_CALL);
const FLAT = new Set([...STRIKE, ...SWING]); // 好球、揮空雖然有驚嘆號，但只是一般的判決，不用喊
export function moodOf(text, introSet) {
  if (HR_SET.has(text)) return 'hr';
  if (introSet && introSet.has(text)) return 'calm';
  if (text.startsWith('三出局，攻守交替')) return '';
  if (text.endsWith('！') && !FLAT.has(text)) return 'excite';
  return '';
}

/** 列出所有可能用到的片段（預錄腳本用） */
export function allFragments() {
  const out = new Set();
  const add = (...xs) => xs.flat().forEach((x) => x && out.add(x));
  add(K_GENERIC, HIT_PRE, HR_CALL, TIE);
  add([...GOOD_RESULTS].map((r) => `${r}！`));
  for (let n = 1; n <= 4; n++) add(RBI(n), WALK_RUN(n));
  for (const t of TEAMS) add(WIN(t.name));
  return { all: [...out], intro: new Set() };
}
