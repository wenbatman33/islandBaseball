// 球隊與球員資料（全部為虛構）
const SKINS = ['#f1c7a3', '#e5b18a', '#c98f66', '#f6d6bb', '#a8744f', '#eabf98'];
const HAIRS = ['#1d1a18', '#2b211b', '#4a3324', '#15171a', '#7a5230', '#3a2a22'];

// 每位球員的外觀：用姓名算出固定的亂數，所以同一個人每次都長一樣。
// h 身高、w 體格寬度（長打型比較壯）、head 頭的大小、hx/hy 臉的寬與長、face 臉部特徵、glasses 眼鏡、band 護腕
const FACES = ['none', 'eyeblack', 'stubble', 'brows', 'none', 'goatee', 'freckle', 'mustache', 'none'];
function lookOf(name, pos, hr = 0, slot = 0) {
  let h = 2166136261;
  for (const ch of name) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0;
  const rnd = () => ((h = (Math.imul(h, 1664525) + 1013904223) >>> 0) / 4294967296);
  const power = Math.min(1, hr / 12);
  const look = {
    h: 0.95 + rnd() * 0.11,
    w: 0.95 + rnd() * 0.06 + power * 0.09,
    head: 0.96 + rnd() * 0.07,
    hx: 0.96 + rnd() * 0.08,
    hy: 0.96 + rnd() * 0.08,
    face: FACES[slot % FACES.length], // 同隊九個人輪流分到不同的臉部特徵，不會撞在一起
    glasses: null,
    band: [null, 'accent', 'white', null][Math.floor(rnd() * 4)],
  };
  const g = rnd();
  if (pos !== 'C' && g < 0.2) look.glasses = g < 0.09 ? 'sun' : 'clear';
  return look;
}

function roster(list, seed) {
  return list.map(([no, name, pos, bats, ovr, avg, hr, rbi], i) => ({
    no, name, pos, bats, ovr, avg, hr, rbi,
    skin: SKINS[(i * 5 + seed) % SKINS.length],
    hair: HAIRS[(i * 3 + seed) % HAIRS.length],
    hairStyle: (i + seed) % 3,
    look: lookOf(name, pos, hr, i * 5 + seed * 2),
  }));
}

export const GAME = {
  title: '例行賽',
  no: 22,
  time: '18:35',
  venue: {
    where: 'Lanshan Township · 嵐山鄉',
    name: '嵐山棒球場',
    en: 'LANSHAN BALLPARK',
    stats: [
      ['容量', '12,400', ''],
      ['海拔', '1,180', 'M'],
      ['中外野', '122', 'M'],
      ['啟用', '2026', ''],
    ],
  },
  away: {
    side: 'AWAY',
    sideTc: '客隊',
    name: '北濱鯨浪',
    short: '鯨浪',
    glyph: '鯨',
    icon: 'hawk',
    record: '12 勝 9 敗',
    ovr: 71,
    teamAvg: '.268',
    c1: '#3b4a63',
    c2: '#d9634a',
    kit: { jersey: '#3b4a63', accent: '#d9634a', pants: '#d9d5cc' },
    lineup: roster(
      [
        [7, '高承澔', 'CF', '左', 74, '.312', 4, 15],
        [6, '葉書瑋', 'SS', '右', 70, '.287', 2, 11],
        [25, '莊博鈞', '1B', '左', 78, '.301', 9, 27],
        [55, '簡廷恩', '3B', '右', 81, '.294', 11, 31],
        [44, '洪睿哲', 'DH', '右', 73, '.266', 8, 22],
        [9, '游子堯', 'LF', '左', 68, '.258', 3, 14],
        [27, '方柏叡', 'C', '右', 66, '.241', 2, 12],
        [31, '余定謙', 'RF', '右', 67, '.249', 4, 13],
        [4, '石宥辰', '2B', '左', 64, '.233', 0, 7],
      ],
      1,
    ),
    sp: {
      no: 18, name: '藍允翔', pos: 'SP', hand: '左投', ovr: 75, skin: SKINS[1], hair: HAIRS[0], hairStyle: 1, look: lookOf('藍允翔', 'P'),
      wl: '2-2', era: '3.41', so: 27, whip: '1.24',
      stamina: 68, control: 71, stuff: 66, maxKmh: 146,
      pitches: [['四縫線', 'B'], ['滑球', 'B'], ['變速球', 'A'], ['曲球', 'C']],
    },
  },
  home: {
    side: 'HOME',
    sideTc: '主隊',
    name: '嵐山雲豹',
    short: '雲豹',
    glyph: '豹',
    icon: 'cat',
    record: '14 勝 7 敗',
    ovr: 74,
    teamAvg: '.274',
    c1: '#1f5a4c',
    c2: '#e9dfc6',
    kit: { jersey: '#f3ecdc', accent: '#1f5a4c', pants: '#f3ecdc' },
    lineup: roster(
      [
        [1, '溫紹齊', '2B', '左', 72, '.298', 1, 9],
        [8, '紀亦凡', 'CF', '右', 76, '.305', 5, 16],
        [2, '柯廷翰', 'SS', '右', 79, '.291', 7, 24],
        [33, '古力揚', '1B', '左', 83, '.318', 12, 34],
        [24, '魏靖淳', 'RF', '右', 75, '.277', 9, 26],
        [5, '白宸', '3B', '右', 70, '.262', 4, 17],
        [52, '鍾秉叡', 'DH', '左', 69, '.254', 6, 18],
        [11, '田祐嘉', 'LF', '左', 66, '.247', 2, 10],
        [22, '孫牧恩', 'C', '右', 68, '.239', 3, 13],
      ],
      3,
    ),
    sp: {
      no: 17, name: '駱以辰', pos: 'SP', hand: '右投', ovr: 80, skin: SKINS[3], hair: HAIRS[2], hairStyle: 0, look: lookOf('駱以辰', 'P'),
      wl: '3-1', era: '2.84', so: 31, whip: '1.12',
      stamina: 72, control: 64, stuff: 78, maxKmh: 151,
      pitches: [['四縫線', 'A'], ['滑球', 'B'], ['指叉球', 'B'], ['曲球', 'C']],
    },
  },
};

// 球種：speed 為相對球速，bx 為往手套側的橫向位移，by 為垂直位移（公尺）
export const PITCHES = {
  四縫線: { speed: 1.0, bx: 0.02, by: 0.1 },
  滑球: { speed: 0.88, bx: 0.34, by: -0.1 },
  曲球: { speed: 0.77, bx: 0.14, by: -0.5 },
  變速球: { speed: 0.83, bx: -0.14, by: -0.28 },
  指叉球: { speed: 0.87, bx: 0.0, by: -0.46 },
};
export const GRADE_MUL = { A: 1.15, B: 1.0, C: 0.85, D: 0.7 };

export const grade = (v) => (v >= 80 ? 'A' : v >= 70 ? 'B' : v >= 60 ? 'C' : v >= 50 ? 'D' : 'E');
