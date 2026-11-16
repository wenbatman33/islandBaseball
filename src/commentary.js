// 轉播句庫：每一句播報由幾個「片段」組成，每個片段對應一個預錄音檔。
// 遊戲（播放）和 scripts/gen_voice.mjs（預錄）共用這一份，兩邊才會一致。
// 這個檔不可以用到瀏覽器專屬的東西，因為預錄腳本是在 Node 裡載入它。

export const POS_NAME = {
  P: '投手', C: '捕手', '1B': '一壘手', '2B': '二壘手', '3B': '三壘手', SS: '游擊手',
  LF: '左外野手', CF: '中外野手', RF: '右外野手', DH: '指定打擊',
};
const NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
const pick = (list) => list[Math.floor(Math.random() * list.length)];

const BALL = ['壞球', '這球偏了，壞球', '沒有進來，壞球'];
const SWING = ['揮棒落空', '揮空！', '出棒，沒有碰到'];
const STRIKE = ['好球', '好球進壘', '站著看，好球'];
const FOUL = ['界外球', '打成界外', '碰到了，界外'];
const OUTS = ['', '一出局', '兩出局', '三出局'];
const K_HEAD = ['三振！', '三振出局！', '投手拿下三振！'];
const HIT_PRE = ['打出去了！', '這球打得很紮實！', '咬中了！'];
const RESULTS = ['全壘打', '場地規則二壘安打', '雙殺打', '滾地球出局', '內野安打', '一壘安打', '二壘安打', '三壘安打',
  '平飛球接殺', '內野飛球接殺', '飛球接殺', '高飛犧牲打'];
const ORDER = (n) => `第${NUM[n]}棒`;
const INNING = (n, half) => `${NUM[n]}局${half ? '下' : '上'}半`;
const RBI = (n) => `${NUM[Math.min(4, n)]}分打點`;
const WALK_RUN = (n) => `擠回${NUM[Math.min(4, n)]}分`;

// ── 每一種播報（回傳片段陣列）──
export const line = {
  ball: () => [pick(BALL)],
  swing: () => [pick(SWING)],
  strike: () => [pick(STRIKE)],
  foul: () => [pick(FOUL)],
  strikeout(name, outs) {
    const k = Math.floor(Math.random() * 3);
    if (k === 0) return ['三振！', name, '被三振出局', OUTS[outs]];
    return [K_HEAD[k], OUTS[outs]];
  },
  walk: (runs) => (runs ? ['四壞球保送', WALK_RUN(runs)] : ['四壞球保送']),
  change: (inning, half, team) => ['三出局，攻守交替', INNING(inning, half), '輪到', team, '進攻'],
  result(name, text, good, runs, outsAdded, outs) {
    const parts = [];
    if (good) parts.push(pick(HIT_PRE), name);
    parts.push(`${text}！`);
    if (runs) parts.push(RBI(runs));
    if (outsAdded) parts.push(OUTS[Math.min(3, outs)]);
    return parts;
  },
  batter(order, pos, name) {
    const p = POS_NAME[pos];
    const k = Math.floor(Math.random() * 3);
    if (k === 0 || !p) return [ORDER(order), ...(p ? [p] : []), name];
    if (k === 1) return ['接下來上場的是', ORDER(order), name];
    return ['打擊區是', p, name];
  },
  gameOver: (winner) => (winner ? ['比賽結束', winner, '獲勝'] : ['比賽結束，雙方平手']),
};

// ── 開場介紹（每段一整句）──
export function introLines(GAME) {
  const A = GAME.away;
  const H = GAME.home;
  const wl = (v) => String(v).replace(/(\d+)-(\d+)/, '$1 勝 $2 敗');
  return {
    venue: `各位觀眾晚安，歡迎收看島嶼職棒。今天是${GAME.title}第 ${GAME.no} 戰，我們來到${GAME.venue.name}。`,
    matchup: `${A.name}作客${H.name}。${A.name}${A.record}，${H.name}${H.record}。`,
    lineup: `客隊${A.name}的先發打序。第一棒${A.lineup[0].name}，第四棒${A.lineup[3].name}。`,
    defense: `主隊${H.name}的守備陣容。`,
    pitcher: `主隊先發投手，${H.sp.name}，本季${wl(H.sp.wl)}，防禦率 ${H.sp.era}。`,
  };
}

// 語氣：預錄時用。excite＝音調拉高、語速加快；calm＝放慢放穩
const EXCITE = new Set([...HIT_PRE, ...K_HEAD, '揮空！', '全壘打！', '一壘安打！', '二壘安打！', '三壘安打！', '內野安打！', '場地規則二壘安打！', '高飛犧牲打！']);
export function moodOf(text, introSet) {
  if (EXCITE.has(text)) return 'excite';
  if (introSet && introSet.has(text)) return 'calm';
  return '';
}

/** 列出所有可能用到的片段（預錄腳本用） */
export function allFragments(GAME) {
  const out = new Set();
  const add = (...xs) => xs.flat().forEach((x) => x && out.add(x));
  add(BALL, SWING, STRIKE, FOUL, OUTS, K_HEAD, HIT_PRE, RESULTS.map((r) => `${r}！`));
  add('被三振出局', '四壞球保送', '三出局，攻守交替', '輪到', '進攻', '接下來上場的是', '打擊區是', '比賽結束', '獲勝', '比賽結束，雙方平手');
  add(Object.values(POS_NAME));
  for (let n = 1; n <= 9; n++) add(ORDER(n), INNING(n, 0), INNING(n, 1));
  for (let n = 1; n <= 4; n++) add(RBI(n), WALK_RUN(n));
  for (const t of [GAME.away, GAME.home]) add(t.name, t.lineup.map((p) => p.name), t.sp.name);
  const intro = Object.values(introLines(GAME));
  add(intro);
  return { all: [...out], intro: new Set(intro) };
}
