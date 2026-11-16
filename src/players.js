import * as THREE from 'three';

// 守備位置（場地座標 x, z）
export const FIELD_POS = {
  P: [0, -18.44],
  C: [0, 1.7],
  '1B': [17.5, -24],
  '2B': [9, -34],
  SS: [-9, -34],
  '3B': [-17.5, -24],
  LF: [-36, -76],
  CF: [0, -93],
  RF: [36, -76],
};

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (t) => Math.min(1, Math.max(0, t));
const ease = (t) => t * t * (3 - 2 * t);

// ── 共用的幾何與材質（所有球員共用，節省記憶體）──
const geoCache = {};
const geo = (key, make) => geoCache[key] || (geoCache[key] = make());
const matCache = {};
const mat = (color, rough = 0.75) => {
  const k = `${color}|${rough}`;
  return matCache[k] || (matCache[k] = new THREE.MeshStandardMaterial({ color, roughness: rough }));
};
const texCache = {};
function makeTexture(key, w, h, draw) {
  if (texCache[key]) return texCache[key];
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return (texCache[key] = t);
}
const texMat = (key, tex, opts = {}) =>
  matCache[key] || (matCache[key] = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.75, ...opts }));

// 身體尺寸（公尺）
const HIP_Y = 0.59; // 站直時髖部高度
const THIGH = 0.24;
const SHIN = 0.3; // 膝蓋到鞋底
const HEAD_R = 0.34;

// 球面貼圖座標：正面中心在 x = W/4，赤道在 y = H/2，1 公尺約 PXM 像素
const TW = 1024;
const TH = 512;
const FX = TW / 4;
const EQ = TH / 2;

// 臉：五官直接畫在頭的貼圖上
function faceTexture(skin, hair) {
  return makeTexture(`face|${skin}|${hair}`, TW, TH, (ctx) => {
    ctx.fillStyle = skin;
    ctx.fillRect(0, 0, TW, TH);
    const ell = (x, y, rx, ry, fill) => {
      ctx.beginPath();
      ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
    };
    for (const s of [-1, 1]) {
      const ex = FX + s * 56;
      const ey = EQ + 46;
      ell(FX + s * 78, EQ + 92, 30, 17, 'rgba(255,110,100,0.2)'); // 腮紅
      ell(ex, ey, 22, 30, '#2b1d17'); // 眼
      const g = ctx.createLinearGradient(0, ey - 20, 0, ey + 30);
      g.addColorStop(0, 'rgba(90,55,38,0)');
      g.addColorStop(1, 'rgba(120,74,48,0.9)');
      ell(ex, ey + 4, 17, 23, g);
      ell(ex - 7, ey - 12, 8.5, 9.5, '#ffffff'); // 高光
      ell(ex + 8, ey + 13, 3.6, 3.6, 'rgba(255,255,255,0.85)');
      // 眉
      ctx.strokeStyle = hair;
      ctx.lineWidth = 11;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(ex - s * 20, ey - 50);
      ctx.quadraticCurveTo(ex, ey - 60, ex + s * 22, ey - 51);
      ctx.stroke();
    }
    ell(FX, EQ + 80, 6, 4, 'rgba(150,80,55,0.38)'); // 鼻
    ctx.strokeStyle = '#8a4034';
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(FX, EQ + 88, 24, Math.PI * 0.2, Math.PI * 0.8);
    ctx.stroke();
  });
}

// 頭髮：貼在略大於頭的球殼上，下緣用透明度切出瀏海與髮尾
function hairTexture(color, style) {
  return makeTexture(`hair|${color}|${style}`, TW, TH, (ctx) => {
    const edge = (x) => {
      let d = Math.abs(x - FX);
      if (d > TW / 2) d = TW - d;
      const tri = (v, period, amp) => Math.abs(((v / period) % 1) - 0.5) * 2 * amp;
      if (d < 150) {
        if (style === 2) return EQ - 104;
        const amp = style === 1 ? 24 : 36;
        return EQ - 58 + tri(x + (style === 1 ? 20 : 0), style === 1 ? 74 : 56, amp);
      }
      if (d < 232) return EQ - 58 + ((d - 150) / 82) * 104 + tri(x, 30, 10);
      return EQ + 52 + ((d - 232) / 280) * 46 + tri(x, 40, 16);
    };
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(TW, 0);
    for (let x = TW; x >= 0; x -= 2) ctx.lineTo(x, edge(x));
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    // 髮絲紋理
    ctx.globalCompositeOperation = 'source-atop';
    for (let i = 0; i < 90; i++) {
      const x = (i / 90) * TW + ((i * 37) % 11);
      ctx.strokeStyle = i % 2 ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.16)';
      ctx.lineWidth = 3 + (i % 3);
      ctx.beginPath();
      ctx.moveTo(x, 60);
      ctx.lineTo(x + ((i % 5) - 2) * 6, TH);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  });
}

// 帽子：縫線與隊徽畫在貼圖上（貼圖涵蓋整個帽冠，正面中心在 x = W/4）
function capTexture(color, icon, iconColor) {
  return makeTexture(`cap|${color}|${icon}|${iconColor}`, TW, TH, (ctx) => {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, TW, TH);
    ctx.strokeStyle = 'rgba(0,0,0,0.22)';
    ctx.lineWidth = 4;
    for (let k = 0; k < 6; k++) {
      const x = FX + 85 + (k * TW) / 6;
      ctx.beginPath();
      ctx.moveTo(x % TW, 0);
      ctx.lineTo(x % TW, TH);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.fillRect(0, TH - 16, TW, 16);
    if (!icon) return;
    // 隊徽：在帽冠正面，寬約 0.2 公尺
    ctx.save();
    ctx.translate(FX, TH * 0.6);
    ctx.scale(0.86, 1.5);
    ctx.fillStyle = iconColor;
    const poly = (pts) => {
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x - 64, y - 64) : ctx.moveTo(x - 64, y - 64)));
      ctx.closePath();
      ctx.fill();
    };
    if (icon === 'hawk') {
      poly([[6, 40], [48, 54], [64, 40], [80, 54], [122, 40], [88, 80], [64, 110], [40, 80]]);
    } else {
      poly([[30, 52], [20, 12], [54, 36], [74, 36], [108, 12], [98, 52], [116, 80], [64, 118], [12, 80]]);
      ctx.fillStyle = color;
      poly([[36, 66], [56, 72], [40, 80]]);
      poly([[92, 66], [72, 72], [88, 80]]);
      poly([[58, 92], [70, 92], [64, 100]]);
    }
    ctx.restore();
  });
}

// 球衣：前襟線、領口與背號畫在貼圖上（正面接縫在 x = 0，背面中心在 x = W/2）
function jerseyTexture(jersey, accent, no) {
  return makeTexture(`jersey|${jersey}|${accent}|${no}`, TW, TH, (ctx) => {
    ctx.fillStyle = jersey;
    ctx.fillRect(0, 0, TW, TH);
    ctx.fillStyle = accent;
    for (const x of [14, TW - 20]) ctx.fillRect(x, 70, 6, TH - 110); // 前襟兩條線
    ctx.fillRect(0, 0, TW, 54); // 領口內搭
    ctx.fillStyle = jersey;
    ctx.fillRect(0, 54, TW, 5);
    ctx.fillStyle = accent;
    ctx.fillRect(0, 59, TW, 9); // 領口滾邊
    if (no != null) {
      ctx.font = '700 190px "Barlow Condensed", "Arial Narrow", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.save();
      ctx.translate(TW / 2, 250);
      ctx.scale(1, 0.92);
      ctx.fillText(String(no), 0, 0);
      ctx.restore();
    }
  });
}

const G = {
  torso: () =>
    geo('torso', () => {
      const pts = [
        [0, -0.02], [0.2, -0.02], [0.232, 0.04], [0.242, 0.18], [0.226, 0.3], [0.19, 0.38], [0.125, 0.44], [0.07, 0.465], [0, 0.47],
      ].map(([x, y]) => new THREE.Vector2(x, y));
      return new THREE.LatheGeometry(new THREE.SplineCurve(pts).getPoints(28), 40);
    }),
  hip: () => geo('hip', () => new THREE.SphereGeometry(0.236, 32, 20)),
  belt: () => geo('belt', () => new THREE.CylinderGeometry(0.229, 0.229, 0.05, 36)),
  buckle: () => geo('buckle', () => new THREE.BoxGeometry(0.07, 0.045, 0.02)),
  thigh: () => geo('thigh', () => new THREE.CapsuleGeometry(0.122, 0.08, 8, 24)),
  cuff: () => geo('cuff', () => new THREE.SphereGeometry(0.127, 24, 16)),
  sock: () => geo('sock', () => new THREE.CylinderGeometry(0.075, 0.068, 0.18, 20)),
  shoe: () => geo('shoe', () => new THREE.SphereGeometry(0.092, 20, 14)),
  shoulder: () => geo('shoulder', () => new THREE.SphereGeometry(0.1, 20, 14)),
  sleeve: () => geo('sleeve', () => new THREE.CylinderGeometry(0.088, 0.108, 0.14, 24, 1, true)),
  upper: () => geo('upper', () => new THREE.CapsuleGeometry(0.063, 0.11, 6, 16)),
  fore: () => geo('fore', () => new THREE.CapsuleGeometry(0.06, 0.09, 6, 16)),
  hand: () => geo('hand', () => new THREE.SphereGeometry(0.078, 20, 14)),
  thumb: () => geo('thumb', () => new THREE.SphereGeometry(0.032, 10, 8)),
  mitt: () => geo('mitt', () => new THREE.SphereGeometry(0.118, 22, 16)),
  head: () => geo('head', () => new THREE.SphereGeometry(HEAD_R, 48, 32)),
  hair: () => geo('hair', () => new THREE.SphereGeometry(HEAD_R + 0.016, 48, 32)),
  ear: () => geo('ear', () => new THREE.SphereGeometry(0.07, 16, 12)),
  cap: () => geo('cap', () => new THREE.SphereGeometry(HEAD_R + 0.045, 48, 20, 0, Math.PI * 2, 0, (76 * Math.PI) / 180)),
  brim: () => geo('brim', () => new THREE.CylinderGeometry(0.26, 0.26, 0.026, 28, 1, false, -Math.PI / 2, Math.PI)),
  button: () => geo('button', () => new THREE.SphereGeometry(0.03, 12, 8)),
  helmet: () => geo('helmet', () => new THREE.SphereGeometry(HEAD_R + 0.055, 48, 24, 0, Math.PI * 2, 0, Math.PI * 0.56)),
  flap: () => geo('flap', () => new THREE.SphereGeometry(0.15, 20, 14)),
  bar: () => geo('bar', () => new THREE.BoxGeometry(1, 0.024, 0.024)),
  guard: () => geo('guard', () => new THREE.BoxGeometry(0.15, 0.2, 0.06)),
  chest: () => geo('chest', () => new THREE.SphereGeometry(0.25, 24, 16)),
  bat: () => geo('bat', () => new THREE.CylinderGeometry(0.05, 0.024, 0.92, 16)),
  knob: () => geo('knob', () => new THREE.SphereGeometry(0.036, 10, 8)),
};

/**
 * 有關節的 Q 版球員（造型依 public/models/_候選預覽/concept-player-sheet.png）。
 * 五官、頭髮、帽徽、球衣線條與背號都畫在貼圖上。
 * opts: jersey / accent / pants / skin / hair 顏色；no 背號；icon 帽徽（'cat' | 'hawk'）；
 *       hairStyle 0~2；bat 是否拿球棒；helmet 打擊頭盔（+1/-1 為護耳側）；
 *       glove 手套所在手（-1 左、+1 右）；gear 'catcher' | 'ump'
 */
export function makePlayer(opts) {
  const { jersey, accent, pants, skin, hair = '#1d1a18', no, icon, hairStyle = 0, bat = false, helmet = 0, glove = 0, gear = null } = opts;
  const g = new THREE.Group();
  const add = (parent, geometry, material, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(geometry, material);
    m.position.set(x, y, z);
    m.castShadow = true;
    parent.add(m);
    return m;
  };
  const pivot = (parent, x, y, z) => {
    const p = new THREE.Group();
    p.position.set(x, y, z);
    parent.add(p);
    return p;
  };
  const mJersey = mat(jersey);
  const mAccent = mat(accent);
  const mPants = mat(pants);
  const mSkin = mat(skin, 0.62);
  const mDark = mat('#20242a');
  const mShoe = mat('#3a3d42', 0.6);

  const hips = pivot(g, 0, HIP_Y, 0);
  add(hips, G.hip(), mPants, 0, -0.035, 0).scale.set(1, 0.62, 0.9);

  // 腿：寬鬆的七分褲 → 膝 → 長襪與釘鞋
  const legs = [-1, 1].map((s) => {
    const hip = pivot(hips, s * 0.115, -0.03, 0);
    add(hip, G.thigh(), mPants, 0, -0.1, 0);
    const knee = pivot(hip, 0, -THIGH, 0);
    add(knee, G.cuff(), mPants, 0, 0.012, 0).scale.set(1, 0.6, 1);
    add(knee, G.sock(), mAccent, 0, -0.11, 0);
    add(knee, G.shoe(), mShoe, 0, -0.238, 0.045).scale.set(1, 0.68, 1.55);
    if (gear === 'catcher') add(knee, G.guard(), mDark, 0, -0.1, 0.08);
    return { hip, knee };
  });

  // 上半身
  const torso = pivot(hips, 0, 0, 0);
  add(torso, G.torso(), texMat(`jersey|${jersey}|${accent}|${no}`, jerseyTexture(jersey, accent, no))).scale.set(1, 1, 0.88);
  add(torso, G.belt(), mDark, 0, 0.004, 0).scale.set(1, 1, 0.88);
  add(torso, G.buckle(), mat('#8f9498', 0.35), 0, 0.004, 0.204);
  if (gear === 'catcher') add(torso, G.chest(), mDark, 0, 0.22, 0.08).scale.set(0.95, 1.0, 0.72);

  // 手臂：短袖 → 肘 → 內搭長袖與手
  const arms = [-1, 1].map((s) => {
    const shoulder = pivot(torso, s * 0.255, 0.365, 0);
    add(shoulder, G.shoulder(), mJersey);
    add(shoulder, G.sleeve(), mat(jersey, 0.75), 0, -0.075, 0);
    add(shoulder, G.upper(), mAccent, 0, -0.095, 0);
    const elbow = pivot(shoulder, 0, -0.17, 0);
    add(elbow, G.fore(), mAccent, 0, -0.08, 0);
    add(elbow, G.hand(), mSkin, 0, -0.195, 0).scale.set(1, 1.15, 0.85);
    add(elbow, G.thumb(), mSkin, -s * 0.055, -0.175, 0.03);
    if (glove === s) add(elbow, G.mitt(), mat('#7a4a2a', 0.85), 0, -0.225, 0.03).scale.set(1, 1.15, 0.6);
    return { shoulder, elbow };
  });

  // 頭：臉與頭髮都是貼圖
  const head = pivot(torso, 0, 0.78, 0);
  const hs = [1, 0.94, 0.96];
  add(head, G.head(), texMat(`face|${skin}|${hair}`, faceTexture(skin, hair), { roughness: 0.62 })).scale.set(...hs);
  for (const s of [-1, 1]) add(head, G.ear(), mSkin, s * 0.322, -0.09, 0).scale.set(0.55, 1, 0.85);
  add(
    head,
    G.hair(),
    texMat(`hair|${hair}|${hairStyle}`, hairTexture(hair, hairStyle), { alphaTest: 0.5, roughness: 0.85 }),
  ).scale.set(...hs);

  if (helmet) {
    const mShell = mat(accent, 0.28);
    add(head, G.helmet(), mShell, 0, 0.0, 0).scale.set(0.96, 1, 0.98);
    add(head, G.flap(), mShell, helmet * 0.33, -0.1, 0.02).scale.set(0.5, 1, 1);
    const b = add(head, G.brim(), mShell, 0, 0.0, 0.25);
    b.scale.set(0.9, 1, 0.62);
    b.rotation.x = 0.2;
  } else {
    const capColor = gear ? '#20242a' : accent;
    const capIcon = gear ? null : icon;
    const mCap = texMat(`cap|${capColor}|${capIcon}`, capTexture(capColor, capIcon, '#f1e7cf'), { roughness: 0.8 });
    add(head, G.cap(), mCap, 0, 0.03, 0).scale.set(0.95, 1, 0.97);
    add(head, G.button(), mat(capColor), 0, 0.412, 0);
    const b = add(head, G.brim(), mat(capColor), 0, 0.118, 0.25);
    b.scale.set(0.95, 1, 0.8);
    b.rotation.x = 0.2;
  }
  if (gear) {
    // 面罩：橫三直三的護條
    const mask = pivot(head, 0, -0.08, 0.37);
    for (const y of [-0.11, 0, 0.11]) add(mask, G.bar(), mDark, 0, y, 0).scale.set(0.42, 1, 1);
    for (const x of [-0.2, 0, 0.2]) {
      const v = add(mask, G.bar(), mDark, x, 0, 0);
      v.scale.set(0.26, 1, 1);
      v.rotation.z = Math.PI / 2;
    }
  }

  // 球棒：握把在軸心，往 +Y 伸出
  const batPivot = pivot(torso, 0, 0.33, 0.3);
  add(batPivot, G.bat(), mat('#c9a36a', 0.5), 0, 0.44, 0);
  add(batPivot, G.knob(), mat('#c9a36a', 0.5), 0, -0.02, 0);
  batPivot.visible = bat;

  g.userData.rig = {
    hips, torso, head, bat: batPivot,
    legL: legs[0].hip, kneeL: legs[0].knee, legR: legs[1].hip, kneeR: legs[1].knee,
    armL: arms[0].shoulder, elbowL: arms[0].elbow, armR: arms[1].shoulder, elbowR: arms[1].elbow,
  };
  return g;
}

function resetRig(r) {
  r.hips.position.y = HIP_Y;
  r.hips.rotation.set(0, 0, 0);
  r.torso.rotation.set(0, 0, 0);
  r.head.rotation.set(0, 0, 0);
  r.legL.rotation.set(0, 0, 0);
  r.legR.rotation.set(0, 0, 0);
  r.kneeL.rotation.set(0, 0, 0);
  r.kneeR.rotation.set(0, 0, 0);
  r.armL.rotation.set(0, 0, -0.3);
  r.armR.rotation.set(0, 0, 0.3);
  r.elbowL.rotation.set(-0.25, 0, 0);
  r.elbowR.rotation.set(-0.25, 0, 0);
  r.bat.rotation.set(0, 0, 0);
  r.bat.position.set(0, 0.33, 0.3);
}

// 雙腿彎曲：大腿前抬 a、膝蓋後彎 b，並依此把髖部降到腳剛好著地
function squat(r, a, b, spread = 0) {
  r.legL.rotation.set(-a, 0, -spread);
  r.legR.rotation.set(-a, 0, spread);
  r.kneeL.rotation.x = b;
  r.kneeR.rotation.x = b;
  r.hips.position.y = 0.05 + THIGH * Math.cos(a) * Math.cos(spread) + SHIN * Math.cos(b - a);
}

// 各種姿勢。t 為持續時間（循環用），u 為單次動作進度 0~1
const POSES = {
  idle(r, a) {
    r.hips.position.y = HIP_Y + Math.sin(a.t * 2 + a.seed) * 0.006;
    r.torso.rotation.x = Math.sin(a.t * 2 + a.seed) * 0.015;
  },
  ready(r, a) {
    squat(r, 0.55, 1.0, 0.16);
    r.hips.position.y += Math.sin(a.t * 2.4 + a.seed) * 0.008;
    r.torso.rotation.x = 0.42;
    r.head.rotation.x = -0.3;
    r.armL.rotation.set(-0.75, 0, -0.1);
    r.armR.rotation.set(-0.75, 0, 0.1);
    r.elbowL.rotation.x = -0.7;
    r.elbowR.rotation.x = -0.7;
  },
  run(r, a) {
    const ph = a.t * 13;
    const s = Math.sin(ph);
    r.legL.rotation.x = s * 0.95;
    r.legR.rotation.x = -s * 0.95;
    r.kneeL.rotation.x = 0.35 + 0.75 * Math.max(0, Math.sin(ph - 0.9));
    r.kneeR.rotation.x = 0.35 + 0.75 * Math.max(0, Math.sin(ph - 0.9 + Math.PI));
    r.armL.rotation.set(-s * 0.9, 0, -0.12);
    r.armR.rotation.set(s * 0.9, 0, 0.12);
    r.elbowL.rotation.x = -1.35;
    r.elbowR.rotation.x = -1.35;
    r.torso.rotation.x = 0.24;
    r.head.rotation.x = -0.15;
    r.hips.position.y = HIP_Y - 0.03 + Math.abs(s) * 0.05;
  },
  crouch(r) {
    squat(r, 1.5, 2.45, 0.5);
    r.torso.rotation.x = 0.28;
    r.head.rotation.x = -0.2;
    r.armL.rotation.set(-1.25, 0, 0.1);
    r.elbowL.rotation.x = -0.35;
    r.armR.rotation.set(-0.2, 0, 0.5);
    r.elbowR.rotation.x = -1.6;
  },
  catchUp(r) {
    r.armL.rotation.set(-2.75, 0, -0.1);
    r.elbowL.rotation.x = -0.1;
    r.armR.rotation.set(-0.3, 0, 0.25);
    r.head.rotation.x = -0.35;
  },
  stance(r, a) {
    const s = a.side;
    squat(r, 0.3, 0.6, 0.24);
    r.torso.rotation.set(0.12, s * -0.45, 0);
    r.head.rotation.y = s * 1.3;
    r.armL.rotation.set(-1.05, 0, 0.3);
    r.armR.rotation.set(-1.05, 0, -0.3);
    r.elbowL.rotation.x = -1.45;
    r.elbowR.rotation.x = -1.45;
    r.bat.position.set(0, 0.42, 0.2);
    r.bat.rotation.set(-0.5, 0, s * -0.6 + Math.sin(a.t * 3) * 0.05);
  },
  swing(r, a) {
    const s = a.side;
    const e = ease(clamp01(a.u / 0.55));
    const b = ease(clamp01(a.u / 0.32));
    squat(r, 0.35, 0.7, 0.3);
    r.hips.rotation.y = s * lerp(0, 0.75, e);
    r.torso.rotation.set(0.12, s * lerp(-0.45, 1.55, e), 0);
    r.head.rotation.y = s * lerp(1.3, -0.35, e);
    r.armL.rotation.set(lerp(-1.05, -1.5, b), 0, 0.3);
    r.armR.rotation.set(lerp(-1.05, -1.5, b), 0, -0.3);
    r.elbowL.rotation.x = lerp(-1.45, -0.25, b);
    r.elbowR.rotation.x = lerp(-1.45, -0.25, b);
    r.bat.position.set(0, lerp(0.42, 0.38, b), lerp(0.2, 0.34, b));
    r.bat.rotation.set(lerp(-0.5, 1.62, b), 0, s * lerp(-0.6, 0, e));
  },
  pitch(r, a) {
    const h = a.hand; // +1 右投、-1 左投
    const lead = h > 0 ? 'L' : 'R';
    const trail = h > 0 ? 'R' : 'L';
    const arm = h > 0 ? 'R' : 'L';
    const glove = h > 0 ? 'L' : 'R';
    const u = a.u;
    const leg = (side, hipX, kneeX) => {
      r[`leg${side}`].rotation.x = hipX;
      r[`knee${side}`].rotation.x = kneeX;
    };
    const armSet = (side, shX, elX) => {
      r[`arm${side}`].rotation.x = shX;
      r[`elbow${side}`].rotation.x = elX;
    };
    if (u < 0.35) {
      const k = ease(u / 0.35);
      leg(lead, -1.45 * k, 1.5 * k);
      r.torso.rotation.y = -h * 0.9 * k;
      armSet(arm, -0.9 * k, -1.5 * k - 0.25);
      armSet(glove, -0.9 * k, -1.5 * k - 0.25);
    } else if (u < 0.62) {
      const k = ease((u - 0.35) / 0.27);
      leg(lead, lerp(-1.45, -0.75, k), lerp(1.5, 0.5, k));
      leg(trail, lerp(0, 0.35, k), lerp(0, 0.4, k));
      r.hips.position.y = lerp(HIP_Y, HIP_Y - 0.11, k);
      r.torso.rotation.y = lerp(-h * 0.9, h * 0.15, k);
      armSet(arm, lerp(-0.9, 2.9, k), lerp(-1.75, -1.5, k));
      armSet(glove, lerp(-0.9, -1.5, k), lerp(-1.75, -0.4, k));
    } else if (u < 0.74) {
      const k = (u - 0.62) / 0.12;
      leg(lead, -0.75, 0.5);
      leg(trail, 0.35, 0.4);
      r.hips.position.y = HIP_Y - 0.11;
      r.torso.rotation.set(0.55 * k, lerp(h * 0.15, h * 0.6, k), 0);
      armSet(arm, lerp(2.9, 5.3, k), lerp(-1.5, -0.1, k));
      armSet(glove, -0.7, -1.6);
    } else {
      const k = ease((u - 0.74) / 0.26);
      leg(lead, lerp(-0.75, -0.25, k), lerp(0.5, 0.35, k));
      leg(trail, lerp(0.35, 0.9, Math.sin(k * Math.PI)), lerp(0.4, 1.2, Math.sin(k * Math.PI)));
      r.hips.position.y = lerp(HIP_Y - 0.11, HIP_Y - 0.03, k);
      r.torso.rotation.set(lerp(0.55, 0.2, k), h * lerp(0.6, 0.15, k), 0);
      armSet(arm, lerp(5.3, 6.0, k), lerp(-0.1, -0.5, k));
      armSet(glove, -0.5, -1.4);
    }
  },
  throw(r, a) {
    const side = a.hand > 0 ? 'R' : 'L';
    const k = ease(clamp01(a.u));
    r[`arm${side}`].rotation.x = lerp(2.7, 5.4, k);
    r[`elbow${side}`].rotation.x = lerp(-1.5, -0.1, k);
    r.torso.rotation.set(0.35 * k, a.hand * lerp(-0.4, 0.4, k), 0);
    r.legL.rotation.x = -0.3;
    r.legR.rotation.x = 0.25;
  },
};

// 把模型包成可播放姿勢的角色
export function makeActor(opts) {
  const group = makePlayer(opts);
  const a = {
    group,
    rig: group.userData.rig,
    pose: 'idle',
    t: 0,
    u: 0,
    dur: 0,
    after: null,
    side: 1,
    hand: 1,
    seed: Math.random() * 6,
    // 循環姿勢
    set(name) {
      if (a.pose === name && !a.dur) return;
      a.pose = name;
      a.dur = 0;
      a.u = 0;
    },
    // 單次動作，播完切到 after
    play(name, dur, after = 'idle') {
      a.pose = name;
      a.dur = dur;
      a.u = 0;
      a.after = after;
    },
    update(dt) {
      a.t += dt;
      if (a.dur) {
        a.u += dt / a.dur;
        if (a.u >= 1) {
          a.u = 1;
          resetRig(a.rig);
          POSES[a.pose](a.rig, a);
          a.pose = a.after;
          a.dur = 0;
          return;
        }
      }
      resetRig(a.rig);
      POSES[a.pose](a.rig, a);
    },
    face(x, z) {
      group.rotation.y = Math.atan2(x - group.position.x, z - group.position.z);
    },
  };
  return a;
}
