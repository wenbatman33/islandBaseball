// 轉播句庫：每一句播報由一到幾個「片段」組成，每個片段對應一個預錄音檔。
// 片段盡量是完整的一句（打者介紹、三振、換局都是一句到底），聽起來才像主播在講，不是一個詞一個詞拼的。
// 遊戲（播放）和 scripts/gen_voice.mjs（預錄）共用這一份，兩邊才會一致。
// 這個檔不可以用到瀏覽器專屬的東西，因為預錄腳本是在 Node 裡載入它。

export const POS_NAME = {
  P: '投手', C: '捕手', '1B': '一壘手', '2B': '二壘手', '3B': '三壘手', SS: '游擊手',
  LF: '左外野手', CF: '中外野手', RF: '右外野手', DH: '指定打擊',
};
const NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];
const pick = (list) => list[Math.floor(Math.random() * list.length)];

const BALL = ['壞球。', '這球偏掉了，壞球。', '沒有進來，壞球。', '太低了，壞球。'];
const SWING = ['揮棒落空！', '出棒，沒有碰到！', '揮空！被這顆球騙到了。'];
const STRIKE = ['好球！', '好球進壘。', '站著看，好球！', '漂亮的一球，好球。'];
const FOUL = ['界外球。', '打成界外。', '碰到了，界外球。'];
const OUTS = ['', '一出局。', '兩出局。', '三出局！'];
const K_GENERIC = ['三振出局！', '投手拿下這次三振！'];
const HIT_PRE = ['打出去了！', '這球打得很紮實！', '咬中了！'];
const HR_CALL = ['這球很高、很遠！', '出去啦！全壘打！'];
const RESULTS = ['場地規則二壘安打', '雙殺打', '滾地球出局', '內野安打', '一壘安打', '二壘安打', '三壘安打',
  '平飛球接殺', '內野飛球接殺', '飛球接殺', '高飛犧牲打'];
const GOOD_RESULTS = new Set(['場地規則二壘安打', '內野安打', '一壘安打', '二壘安打', '三壘安打', '高飛犧牲打']);
const INNING = (n, half) => `${NUM[n]}局${half ? '下' : '上'}半`;
const RBI = (n) => `${NUM[Math.min(4, n)]}分打點！`;
const WALK = ['四壞球保送。', '保送，打者上到一壘。'];
const WALK_RUN = (n) => `擠回${NUM[Math.min(4, n)]}分！`;

const BATTER = [
  (o, p, name) => `第${NUM[o]}棒，${p}，${name}！`,
  (o, p, name) => `接下來上場的是，第${NUM[o]}棒，${name}。`,
];
const K_NAMED = (name) => `三振！${name}，被三振出局！`;
const CHANGE = (inning, half, team) => `三出局，攻守交替。比賽來到${INNING(inning, half)}，輪到${team}進攻。`;
const EXTRA = (inning, team) => `三出局！雙方戰成平手，比賽進入延長賽！${INNING(inning, 0)}，輪到${team}進攻。`;
const WIN = (team) => `比賽結束！${team}，拿下今天的勝利！`;
const TIE = '比賽結束，雙方握手言和，以平手收場。';

// ── 每一種播報（回傳片段陣列）──
export const line = {
  ball: () => [pick(BALL)],
  swing: () => [pick(SWING)],
  strike: () => [pick(STRIKE)],
  foul: () => [pick(FOUL)],
  strikeout: (name, outs) => [Math.random() < 0.6 ? K_NAMED(name) : pick(K_GENERIC), OUTS[outs]],
  walk: (runs) => (runs ? [WALK[0], WALK_RUN(runs)] : [pick(WALK)]),
  change: (inning, half, team, extraStart) => [extraStart ? EXTRA(inning, team) : CHANGE(inning, half, team)],
  result(name, text, good, runs, outsAdded, outs) {
    const parts = [];
    if (text === '全壘打') parts.push(HR_CALL[0], HR_CALL[1], `${name}！`);
    else {
      if (good) parts.push(pick(HIT_PRE), `${name}！`);
      parts.push(`${text}${GOOD_RESULTS.has(text) ? '！' : '。'}`);
    }
    if (runs) parts.push(RBI(runs));
    if (outsAdded) parts.push(OUTS[Math.min(3, outs)]);
    return parts;
  },
  batter(order, pos, name) {
    const p = POS_NAME[pos];
    return [p && Math.random() < 0.6 ? BATTER[0](order, p, name) : BATTER[1](order, p, name)];
  },
  gameOver: (winner) => [winner ? WIN(winner) : TIE],
};

// ── 開場介紹（每段一整句）──
export function introLines(GAME) {
  const A = GAME.away;
  const H = GAME.home;
  const wl = (v) => String(v).replace(/(\d+)-(\d+)/, '$1 勝 $2 敗');
  return {
    venue: `各位觀眾晚安，歡迎收看島嶼職棒！今天是${GAME.title}第 ${GAME.no} 戰，我們來到${GAME.venue.name}，為您帶來這場精彩的比賽。`,
    matchup: `今晚由${A.name}，作客${H.name}。${A.name}目前${A.record}，${H.name}${H.record}，兩隊實力相當接近。`,
    lineup: `先來看客隊${A.name}的先發打序。開路先鋒是${A.lineup[0].name}，第四棒，交給${A.lineup[3].name}。`,
    defense: `再來是主隊${H.name}的守備陣容，九位先發球員已經站上各自的位置。`,
    pitcher: `主隊先發投手，${H.sp.name}！本季${wl(H.sp.wl)}，防禦率 ${H.sp.era}，是球隊最信賴的王牌。`,
  };
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
export function allFragments(GAME) {
  const out = new Set();
  const add = (...xs) => xs.flat().forEach((x) => x && out.add(x));
  add(BALL, SWING, STRIKE, FOUL, OUTS, K_GENERIC, HIT_PRE, HR_CALL, WALK, TIE);
  add(RESULTS.map((r) => `${r}${GOOD_RESULTS.has(r) ? '！' : '。'}`));
  for (let n = 1; n <= 4; n++) add(RBI(n), WALK_RUN(n));
  const teams = [GAME.away, GAME.home];
  teams.forEach((t, half) => {
    add(WIN(t.name));
    for (let n = 1; n <= 12; n++) add(CHANGE(n, half, t.name));
    t.lineup.forEach((p, i) => {
      add(`${p.name}！`, K_NAMED(p.name), BATTER[1](i + 1, null, p.name));
      if (POS_NAME[p.pos]) add(BATTER[0](i + 1, POS_NAME[p.pos], p.name));
    });
  });
  for (let n = 2; n <= 10; n++) add(EXTRA(n, GAME.away.name));
  const intro = Object.values(introLines(GAME));
  add(intro);
  return { all: [...out], intro: new Set(intro) };
}
