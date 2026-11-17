// 大聯盟球員分析頁：獨立頁面，不改動遊戲。
// 分兩個分頁：球員模型（身體比例對照與比例優化預覽）、打擊人員（打擊階段逐格分析、數據、預備姿勢類型）
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';
import { GAME } from './data.js';
import { loadPlayerModel, makeActor } from './player3d.js';
import { BATPOSE, BATPOSE_DEFAULT } from './batpose.js';

const $ = (s) => document.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

// ── 場景 ──
const canvas = $('#view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.shadowMap.enabled = true;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#9aa3ad');
scene.add(new THREE.HemisphereLight('#ffffff', '#7d6c5a', 1.5));
const sun = new THREE.DirectionalLight('#fff1dc', 2.4);
sun.position.set(3, 6, 5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -4, right: 4, top: 4, bottom: -2 });
scene.add(sun);
const rim = new THREE.DirectionalLight('#dfe8ff', 1.3);
rim.position.set(-4, 4, -5);
scene.add(rim);
const ground = new THREE.Mesh(new THREE.CircleGeometry(9, 64), new THREE.MeshStandardMaterial({ color: '#a2865f', roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 100);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;

function resize() {
  const r = canvas.parentElement.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / Math.max(1, r.height);
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);

// 文字標籤（尺規刻度用）
function label(text, color = '#ffffff', size = 0.07) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d');
  g.font = '600 40px "Barlow Condensed", sans-serif';
  g.fillStyle = color;
  g.textBaseline = 'middle';
  g.fillText(text, 6, 32);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, transparent: true }));
  s.scale.set(size * 4, size, 1);
  s.center.set(0, 0.5);
  return s;
}

// ════════ 量測：直接取蒙皮後的頂點與骨頭位置 ════════
const P = 'mixamorig';
function bonesOf(inner) {
  const B = {};
  inner.traverse((o) => {
    if (o.isBone && o.name.startsWith(P)) B[o.name.slice(P.length)] = o;
  });
  return B;
}
const wpos = (o) => o.getWorldPosition(new THREE.Vector3());

// 每個頂點權重最大的骨頭（只算一次）
function dominantBone(mesh) {
  if (mesh.userData.dom) return mesh.userData.dom;
  const si = mesh.geometry.attributes.skinIndex;
  const sw = mesh.geometry.attributes.skinWeight;
  const dom = new Int16Array(si.count);
  for (let i = 0; i < si.count; i++) {
    let best = 0;
    let bw = -1;
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(i, k);
      if (w > bw) {
        bw = w;
        best = si.getComponent(i, k);
      }
    }
    dom[i] = best;
  }
  mesh.userData.dom = dom;
  return dom;
}

function measureBody(actor) {
  const inner = actor.group.userData.inner;
  inner.updateMatrixWorld(true);
  const B = bonesOf(inner);
  let top = -1e9;
  let bottom = 1e9;
  let chin = 1e9;
  let hx0 = 1e9;
  let hx1 = -1e9;
  const v = new THREE.Vector3();
  inner.traverse((o) => {
    if (!o.isSkinnedMesh || o.name === 'bat_mesh' || !o.visible) return;
    const pos = o.geometry.attributes.position;
    const headIdx = o.skeleton.bones.indexOf(B.Head);
    const dom = o.name === 'cap' ? null : dominantBone(o);
    for (let i = 0; i < pos.count; i += 2) {
      o.getVertexPosition(i, v);
      o.localToWorld(v);
      top = Math.max(top, v.y);
      bottom = Math.min(bottom, v.y);
      if (dom && dom[i] === headIdx) {
        chin = Math.min(chin, v.y);
        hx0 = Math.min(hx0, v.x);
        hx1 = Math.max(hx1, v.x);
      }
    }
  });
  const H = top - bottom;
  // 下巴：頭骨往下約 4 公分（頭骨縮放時跟著縮）。直接用「屬於頭骨的頂點最低點」會把頸部上段也算進去，頭量太高
  const hs = B.Head.getWorldScale(new THREE.Vector3()).y;
  chin = Math.max(chin, wpos(B.Head).y - 0.04 * hs);
  const head = top - chin;
  const seg = (a, b) => wpos(B[a]).distanceTo(wpos(B[b]));
  const arm = seg('RightArm', 'RightForeArm') + seg('RightForeArm', 'RightHand');
  const leg = wpos(B.RightUpLeg).y - bottom;
  const shoulders = wpos(B.LeftArm).distanceTo(wpos(B.RightArm)) + 0.1; // 兩肩關節距離＋兩側三角肌
  return { H, head, heads: H / head, headW: hx1 - hx0, shoulders, headRatio: (hx1 - hx0) / shoulders, arm: arm / H, leg: leg / H };
}

// ════════ 球員模型分頁：比例優化預覽（用骨頭縮放近似） ════════
const PROP_DEFAULT = { head: 1, arms: 1, legs: 1, shoulders: 1, bulk: 1 };
const PROP_MLB = { head: 0.86, arms: 1.22, legs: 1.14, shoulders: 1.12, bulk: 1.08 };
const prop = { ...PROP_DEFAULT }; // 球員模型分頁
const batProp = { ...PROP_DEFAULT }; // 打擊人員分頁

function applyProportions(actor, p) {
  const B = bonesOf(actor.group.userData.inner);
  if (!B.Head) return;
  const build = actor.group.userData.build;
  B.Head.scale.set(p.head / build.w, p.head / build.h, p.head / build.w);
  for (const s of ['Left', 'Right']) {
    // 上臂沿骨頭方向拉長，前臂跟著一起變長（手臂下垂時兩段方向接近），手掌縮回原長
    B[s + 'Arm'].scale.set(p.bulk, p.arms, p.bulk);
    B[s + 'Hand'].scale.set(1 / p.bulk, 1 / p.arms, 1 / p.bulk);
    B[s + 'UpLeg'].scale.set(1, p.legs, 1);
    B[s + 'Foot'].scale.set(1, 1 / p.legs, 1);
    // 肩寬：把手臂往外移（不用縮放，避免手臂跟著變形）
    const arm = B[s + 'Arm'];
    if (!arm.userData.p0) arm.userData.p0 = arm.position.clone();
    arm.position.copy(arm.userData.p0).multiplyScalar(p.shoulders);
  }
  B.Spine2.scale.set(p.bulk, 1, p.bulk);
  B.Neck.scale.set(1 / p.bulk, 1, 1 / p.bulk);
  // 腿變長時把整個人往上抬，腳才不會陷進地面（大腿＋小腿約 0.76 公尺）
  actor.group.position.y = (p.legs - 1) * 0.76 * build.h;
  actor.group.updateMatrixWorld(true);
}

// ════════ 打擊人員分頁：揮棒逐格分析 ════════
const SWING_DUR = 0.34; // 遊戲裡一次揮棒的秒數
const SWING_MAP = [[0, 0.45], [0.42, 0.67], [1, 1.13]]; // 遊戲進度 → 動作檔時間（真人動作捕捉的實際秒數）
const CONTACT_U = 0.42;
const CLIP_END = 1.13; // 揮棒動作檔全長（秒，真人原速）
const GAME_T0 = 0.45; // 遊戲裡的揮棒從動作檔這個時間點才開始（之前的載重、跨步被跳過）
const CONTACT_F = 0.67 / CLIP_END; // 時間軸上擊球瞬間的位置
const GAME_F = GAME_T0 / CLIP_END;
// 動作檔時間 → 遊戲進度（遊戲開始之前＝0）
const gameU = (t) => {
  if (t <= SWING_MAP[0][1]) return 0;
  for (let i = 1; i < SWING_MAP.length; i++) {
    const [u0, t0] = SWING_MAP[i - 1];
    const [u1, t1] = SWING_MAP[i];
    if (t <= t1) return u0 + ((t - t0) / (t1 - t0)) * (u1 - u0);
  }
  return 1;
};

function batTip(actor) {
  const inner = actor.group.userData.inner;
  let mesh = null;
  inner.traverse((o) => {
    if (o.name === 'bat_mesh') mesh = o;
  });
  const B = bonesOf(inner);
  const bat = inner.getObjectByName('bat');
  const knob = wpos(bat);
  const v = new THREE.Vector3();
  let best = null;
  let bd = -1;
  const pos = mesh.geometry.attributes.position;
  for (let i = 0; i < pos.count; i += 3) {
    mesh.getVertexPosition(i, v);
    mesh.localToWorld(v);
    const d = v.distanceTo(knob);
    if (d > bd) {
      bd = d;
      best = v.clone();
    }
  }
  return { tip: best, knob, B };
}

// f：時間軸位置 0～1，對應整段真人揮棒動作（含遊戲跳過的載重、跨步）
function swingPose(actor, f) {
  const t = clamp(f, 0, 1) * CLIP_END;
  if (actor.pose !== 'swing') actor.play('swing', 1e6, 'stance');
  actor.dur = 1e6;
  actor.u = clamp(gameU(t), 0, 0.999);
  actor.aimY = 0.78;
  actor.update(0);
  // 直接把動作檔時間設到 t（遊戲開始之前的部分也看得到），再套一次姿勢微調
  actor.group.userData.actions.swing.time = Math.min(t, CLIP_END - 1e-3);
  actor.group.userData.mixer.update(0);
  actor._tweak();
  actor.group.updateMatrixWorld(true);
}

function frameMetrics(actor) {
  const { tip, knob, B } = batTip(actor);
  const lh = wpos(B.LeftHand);
  const rh = wpos(B.RightHand);
  const hands = lh.clone().add(rh).multiplyScalar(0.5);
  const d = tip.clone().sub(knob);
  const flat = (a, b) => Math.atan2(b.z - a.z, b.x - a.x);
  let sep = (flat(wpos(B.LeftUpLeg), wpos(B.RightUpLeg)) - flat(wpos(B.LeftArm), wpos(B.RightArm))) * (180 / Math.PI);
  sep = ((sep + 540) % 360) - 180;
  const inner = actor.group.userData.inner;
  const plate = new THREE.Vector3(-1, 0, 0).transformDirection(inner.matrixWorld);
  const root = actor.group.position;
  return {
    tip,
    reach: (tip.clone().sub(root).dot(plate)) * 100,
    handsY: hands.y,
    batAngle: Math.asin(clamp(d.y / d.length(), -1, 1)) * (180 / Math.PI),
    foot: wpos(B.LeftFoot),
    head: wpos(B.Head),
    sep: Math.abs(sep),
  };
}

// 先把整段揮棒取樣，算出速度曲線與各階段的時間點
function analyzeSwing(actor) {
  const N = 120;
  const S = [];
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    swingPose(actor, u);
    S.push({ u, ...frameMetrics(actor) });
  }
  const f0 = S[0].foot;
  const h0 = S[0].head;
  for (let i = 0; i <= N; i++) {
    const s = S[i];
    s.stride = Math.hypot(s.foot.x - f0.x, s.foot.z - f0.z) * 100;
    s.footUp = (s.foot.y - f0.y) * 100;
    s.headMove = Math.hypot(s.head.x - h0.x, s.head.z - h0.z) * 100;
    s.handsCm = s.handsY * 100;
    const a = S[Math.max(0, i - 1)];
    const b = S[Math.min(N, i + 1)];
    const dist = a.tip.distanceTo(b.tip);
    const du = gameU(b.u * CLIP_END) - gameU(a.u * CLIP_END);
    s.speedGame = du > 1e-6 ? (dist / (du * SWING_DUR)) * 3.6 : 0;
    s.speedReal = (dist / (((b.u - a.u) * CLIP_END) || 1e-6)) * 3.6;
  }
  const vmax = Math.max(...S.map((s) => s.speedReal));
  const peak = S.reduce((m, s) => (s.u < CONTACT_F && s.footUp > m.footUp ? s : m), S[0]);
  const land = S.find((s) => s.u > peak.u && s.footUp < 1.5) || peak;
  const launch = S.find((s) => s.u > land.u && s.speedReal > vmax * 0.3) || land;
  const slow = S.find((s) => s.u > CONTACT_F + 0.05 && s.speedReal < vmax * 0.3) || S[N];
  const phases = [
    { name: '載重', a: 0, b: Math.max(0.04, peak.u), c: '#7fb2ff' },
    { name: '跨步', a: Math.max(0.04, peak.u), b: Math.max(peak.u + 0.04, land.u), c: '#a0e4ff' },
    { name: '啟動', a: Math.max(peak.u + 0.04, land.u), b: CONTACT_F - 0.01, c: '#ffd36b' },
    { name: '擊球', a: CONTACT_F - 0.01, b: CONTACT_F + 0.02, c: '#ff7a4d' },
    { name: '延伸', a: CONTACT_F + 0.02, b: Math.max(CONTACT_F + 0.06, slow.u), c: '#c9ff7a' },
    { name: '收棒', a: Math.max(CONTACT_F + 0.06, slow.u), b: 1, c: '#b8c4cf' },
  ];
  const at = (u) => S[Math.round(clamp(u, 0, 1) * N)];
  const reachMax = Math.max(...S.filter((s) => Math.abs(s.u - CONTACT_F) < 0.08).map((s) => s.reach));
  return { S, phases, at, land, peak, contact: at(CONTACT_F), vmax, reachMax };
}

// ════════ 介面 ════════
const panel = $('#panel');
let tab = 'body';
let bodyActor;
let batActor;
let swing = null;
let playing = false;
let speed = 0.25;
let scrubU = 0;
let inStance = true;
const rulerGroup = new THREE.Group();
scene.add(rulerGroup);
const plateGroup = new THREE.Group();
scene.add(plateGroup);

const SOURCES = `
  <p class="src">公開資料來源：
  <a href="https://www.mlbplayers.com/post/behind-the-scenes-sony-mlb-the-show-19-player-scans" target="_blank">MLBPA：MLB The Show 19 球員掃描幕後</a>、
  <a href="https://www.foxsports.com/stories/other/braves-players-get-face-to-face-with-video-game-design" target="_blank">Fox Sports：勇士隊球員臉部 3D 掃描</a>、
  <a href="https://gameinformer.com/b/features/archive/2017/02/13/the-sports-desk-48-mlb-the-show-17-details-gameplay-graphics-diamond-dynasty-and-more" target="_blank">Game Informer：MLB The Show 17 體型與捏人</a>、
  <a href="https://blog.playstation.com/?p=377481" target="_blank">PlayStation Blog：MLB The Show 23 新增 5,000+ 動作</a>、
  <a href="https://www.pushsquare.com/guides/mlb-the-show-25-how-to-use-face-scan-when-creating-your-ballplayer" target="_blank">Push Square：MLB The Show 25 臉部掃描</a>。
  只整理公開說明與業界常見做法，不使用、不拷貝任何遊戲的模型或美術。</p>`;

function metricRow(name, us, mlb, lo, hi, fmt, note) {
  const pct = (x) => `${(clamp((x - lo) / (hi - lo), 0, 1) * 100).toFixed(1)}%`;
  return `<div class="metric"><span class="name">${name}</span><span class="val">${fmt(us)} <small style="color:var(--dim)">／目標 ${fmt(mlb)}</small></span>
    <div class="bar"><i class="mlb" style="left:${pct(mlb)}"></i><i class="us" style="left:${pct(us)}"></i></div>${note ? `<span class="ref">${note}</span>` : ''}</div>`;
}

const bodyTag = (ok) => (ok === 2 ? '<span class="tag ok">已接近</span>' : ok === 1 ? '<span class="tag mid">有差距</span>' : '<span class="tag no">差很多</span>');
const grade = (v, t, tol) => (Math.abs(v - t) <= tol ? 2 : Math.abs(v - t) <= tol * 2.5 ? 1 : 0);
function bodyMetricsHTML(m) {
  const tag = bodyTag;
  return `
    ${metricRow('頭身比', m.heads, 7.5, 5, 8.5, (x) => `${x.toFixed(1)} 頭身`, `${tag(grade(m.heads, 7.5, 0.3))} 寫實成年男性約 7.5 頭身，大聯盟遊戲用寫實比例`)}
    ${metricRow('頭寬 ÷ 肩寬', m.headRatio, 0.33, 0.2, 0.8, (x) => x.toFixed(2), `${tag(grade(m.headRatio, 0.33, 0.04))} 越大代表頭越大、肩越窄`)}
    ${metricRow('手臂長（肩到手腕）÷ 身高', m.arm, 0.32, 0.2, 0.38, (x) => `${(x * 100).toFixed(0)}%`, `${tag(grade(m.arm, 0.32, 0.015))} 手臂太短，打擊時球棒就搆不到本壘板外側`)}
    ${metricRow('腿長（髖關節到地）÷ 身高', m.leg, 0.5, 0.38, 0.56, (x) => `${(x * 100).toFixed(0)}%`, `${tag(grade(m.leg, 0.5, 0.015))} 腿短看起來矮胖、跑壘步幅小`)}
    <p style="font-size:12px;color:var(--dim);margin:6px 0 0">身高 ${m.H.toFixed(2)} 公尺（含帽）、頭高 ${(m.head * 100).toFixed(0)} 公分、頭寬 ${(m.headW * 100).toFixed(0)} 公分、肩寬約 ${(m.shoulders * 100).toFixed(0)} 公分</p>`;
}

function compareBlock(src, title) {
  return `<h2>${title}</h2>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
    <figure style="margin:0"><img class="concept" src="${src}" style="aspect-ratio:2/3;object-fit:cover" /><figcaption style="font-size:12px;color:var(--good);text-align:center;margin-top:4px">大聯盟寫實目標（AI 概念圖，原創）</figcaption></figure>
    <figure style="margin:0"><img class="concept" id="snap" style="aspect-ratio:2/3;object-fit:cover;background:#9aa3ad" /><figcaption style="font-size:12px;color:var(--warn);text-align:center;margin-top:4px">我們目前（同角度即時截圖）</figcaption></figure>
  </div>`;
}

// 用主畫面的渲染器拍一張固定角度的截圖（直式 2:3）
function snapshot(kind) {
  const img = $('#snap');
  if (!img) return;
  const cam = new THREE.PerspectiveCamera(kind === 'bat' ? 30 : 26, 2 / 3, 0.05, 100);
  if (kind === 'bat') {
    const inner = batActor.group.userData.inner;
    inner.updateMatrixWorld(true);
    const dir = (x, y, z) => new THREE.Vector3(x, y, z).transformDirection(inner.matrixWorld);
    const plate = dir(-1, 0, 0);
    const catcher = dir(0, 0, -1);
    const at = (p, q, u) => plate.clone().multiplyScalar(p).add(catcher.clone().multiplyScalar(q)).add(new THREE.Vector3(0, u, 0));
    cam.position.copy(at(-2.4, 2.6, 1.55));
    cam.lookAt(at(0.25, -0.1, 0.95));
  } else {
    cam.position.set(0.15, 1.0, 5.6);
    cam.lookAt(0, 0.98, 0);
  }
  const size = renderer.getSize(new THREE.Vector2());
  const rulerVis = rulerGroup.visible;
  rulerGroup.visible = false;
  renderer.setSize(400, 600, false);
  renderer.render(scene, cam);
  img.src = canvas.toDataURL('image/jpeg', 0.85);
  renderer.setSize(size.x, size.y, false);
  rulerGroup.visible = rulerVis;
  resize();
}

function renderBodyPanel(m) {
  const tag = bodyTag;
  panel.innerHTML = `
  ${compareBlock('/lab/concept_fielder.jpg', '對照：大聯盟寫實目標 vs 我們目前')}
  <h2>球員模型：我們的版本 vs 大聯盟寫實比例</h2>
  <div class="legend"><span><b style="background:var(--warn)"></b>我們目前（即時量測）</span><span><b style="background:var(--good)"></b>寫實職業球員目標</span></div>
  <div class="card" id="bodyMetrics">${bodyMetricsHTML(m)}</div>

  <h2>比例優化預覽（拖滑桿即時看）</h2>
  <div class="row">
    <button class="chip ${isProp(PROP_DEFAULT) ? 'on' : ''}" data-preset="orig">目前遊戲比例</button>
    <button class="chip ${isProp(PROP_MLB) ? 'on' : ''}" data-preset="mlb">大聯盟比例建議</button>
  </div>
  ${slider('head', '頭部大小', 0.6, 1.1, 0.01)}
  ${slider('arms', '手臂長度', 0.9, 1.35, 0.01)}
  ${slider('legs', '腿長', 0.9, 1.3, 0.01)}
  ${slider('shoulders', '肩寬', 0.9, 1.25, 0.01)}
  ${slider('bulk', '體格（胸背、手臂粗細）', 0.9, 1.2, 0.01)}
  <p style="font-size:12px;color:var(--dim)">這是用骨頭縮放「近似」改比例，站姿、預備姿勢看得最準；手肘大幅彎曲時前臂會有些變形。真正的寫實模型要重做模型本體（見下方「優化路線」）。</p>

  <p style="font-size:12px;color:var(--dim)">概念圖為原創設計（隊名 ISLAND 為虛構），不仿任何真實球隊、球員或遊戲。</p>

  <h2>大聯盟遊戲球員模型的做法（公開資料整理）</h2>
  <ul>
    <li><b>臉：</b>真實球員做 3D 臉部掃描；近年開放照片掃臉，再調髮型、鬍子、膚色。</li>
    <li><b>體型：</b>多種體型（含壯碩型），捏人可調臀部、肩寬、脊椎長度等。</li>
    <li><b>動作：</b>大量動作捕捉，MLB The Show 23 一次新增 5,000 個以上比賽動作；打者有各自的預備姿勢與揮棒。</li>
  </ul>
  <h2>對照：寫實 3D 運動遊戲角色的常見做法 vs 我們</h2>
  <div class="card">
    <p>${tag(m.heads > 7 ? 2 : 0)}<b>寫實 7～7.5 頭身比例</b>：我們是卡通大頭比例（約 ${m.heads.toFixed(1)} 頭身）。</p>
    <p>${tag(0)}<b>手臂扭轉骨（twist bone）</b>：前臂轉動時分段扭轉，不會像糖果紙扭成一團；我們的骨架沒有。</p>
    <p>${tag(0)}<b>五指分開的手</b>：握棒、接球需要；我們的手指是黏在一起雕的，靠打擊手套遮住。</p>
    <p>${tag(1)}<b>布料：</b>寬鬆球衣、褲子皺褶用法線貼圖與材質表現；我們只保留顏色貼圖（減面後原法線貼圖對不上）。</p>
    <p>${tag(2)}<b>裝備分件：</b>頭盔、打擊手套、護腕、守備手套、捕手護具都是獨立配件（已做）。</p>
    <p>${tag(1)}<b>多種體型與臉：</b>我們全隊共用一個臉與髮型，只有身高胖瘦與頭型縮放。</p>
    <p>${tag(2)}<b>真人動作捕捉打擊：</b>已改用真人揮棒動作（CMU 開放資料），並可微調預備姿勢。</p>
  </div>
  <h2>優化路線（建議順序）</h2>
  <ol style="font-size:13px;line-height:1.7;padding-left:18px">
    <li>用上面的寫實概念圖重新生成 3D 模型（Meshy 圖片轉 3D，會用到點數，做之前先問你）。</li>
    <li>重新綁骨架時加入前臂扭轉骨、五指骨架，並重算權重。</li>
    <li>保留布料法線貼圖（改用重新拓樸後再烘焙，減面後才對得上）。</li>
    <li>多做 3～4 種體型與臉，讓每位球員看得出差別。</li>
  </ol>
  ${SOURCES}`;
  bindPanel();
  requestAnimationFrame(() => snapshot('body'));
}

function isProp(p) {
  return Object.keys(p).every((k) => Math.abs(prop[k] - p[k]) < 1e-3);
}
function slider(key, name, min, max, step) {
  return `<div class="slider"><span>${name}</span><input type="range" data-prop="${key}" min="${min}" max="${max}" step="${step}" value="${prop[key]}" /><output>${prop[key].toFixed(2)}×</output></div>`;
}

let measureTimer = 0;
function refreshBody(delay = 0, full = false) {
  clearTimeout(measureTimer);
  measureTimer = setTimeout(() => {
    bodyActor.update(0);
    const m = measureBody(bodyActor);
    drawRuler(m);
    const box = $('#bodyMetrics');
    if (!box || full) return renderBodyPanel(m);
    // 拖滑桿時只更新數據卡，不重畫整個面板（正在拖的滑桿才不會被換掉）
    box.innerHTML = bodyMetricsHTML(m);
    snapshot('body');
    panel.querySelectorAll('[data-preset]').forEach((b) => b.classList.toggle('on', isProp(b.dataset.preset === 'mlb' ? PROP_MLB : PROP_DEFAULT)));
  }, delay);
}

function drawRuler(m) {
  rulerGroup.clear();
  if (tab !== 'body') return;
  const x = -0.75;
  const mat = new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.85 });
  const top = m.H;
  const n = Math.ceil(m.heads);
  for (let i = 0; i <= n; i++) {
    const y = top - i * m.head;
    if (y < -0.01) break;
    const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(x - 0.08, y, 0), new THREE.Vector3(x + 0.08, y, 0)]);
    rulerGroup.add(new THREE.Line(g, mat));
    if (i > 0) {
      const l = label(String(i), '#ffffff', 0.06);
      l.position.set(x + 0.1, y + m.head / 2, 0);
      rulerGroup.add(l);
    }
  }
  const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(x, 0, 0), new THREE.Vector3(x, top, 0)]);
  rulerGroup.add(new THREE.Line(g, mat));
  const t = label(`${m.heads.toFixed(1)} 頭身`, '#d8ff3e', 0.08);
  t.position.set(x - 0.05, top + 0.12, 0);
  rulerGroup.add(t);
}

// ── 打擊面板 ──
const BAT_ORIG = { ...BATPOSE_DEFAULT }; // 一律用寫進程式的遊戲預設值（你鎖定的那組），不讀瀏覽器裡暫存的版本
const STANCES = {
  game: { name: '遊戲目前（你調的）', v: {} },
  high: { name: '高手位', v: { gripUp: -12, tiltBack: -15 } },
  low: { name: '低手位、球棒平放', v: { gripUp: -40, tiltBack: -55 } },
  crouch: { name: '蹲低重心', v: { crouch: 14, spread: 10, lean: 8 } },
  upright: { name: '直立窄站', v: { crouch: 0, spread: -14, lean: 0 } },
};
let stanceKey = 'game';
function applyStance(key) {
  stanceKey = key;
  Object.assign(BATPOSE, BAT_ORIG, STANCES[key].v, { freeze: false }); // 只改這一頁的記憶體，不存回遊戲
  swing = analyzeSwing(batActor);
  if (inStance) batActor.set('stance');
  renderBatPanel();
  drawPhases();
}

function sparkline(key, color, unit) {
  const S = swing.S;
  const vals = S.map((s) => s[key]);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const pts = S.map((s, i) => `${(i / (S.length - 1)) * 300},${48 - ((s[key] - lo) / (hi - lo || 1)) * 44}`).join(' ');
  return `<svg viewBox="0 0 300 52" style="width:100%;height:52px;display:block"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2"/>
    <line class="cursor" x1="0" x2="0" y1="0" y2="52" stroke="#fff" stroke-width="1" opacity="0.7"/>
    <line x1="${CONTACT_F * 300}" x2="${CONTACT_F * 300}" y1="0" y2="52" stroke="#ff7a4d" stroke-dasharray="3 3"/>
    <line x1="${GAME_F * 300}" x2="${GAME_F * 300}" y1="0" y2="52" stroke="#d8ff3e" stroke-dasharray="2 4"/></svg>
    <div style="font-size:11px;color:var(--dim)">範圍 ${lo.toFixed(0)}～${hi.toFixed(0)} ${unit}（橘線＝擊球瞬間，黃線＝遊戲從這裡才開始揮）</div>`;
}

function renderBatPanel() {
  const c = swing.contact;
  const l = swing.land;
  const chips = Object.entries(STANCES).map(([k, s]) => `<button class="chip ${k === stanceKey ? 'on' : ''}" data-stance="${k}">${s.name}</button>`).join('');
  const tag = (g) => (g === 2 ? '<span class="tag ok">符合</span>' : g === 1 ? '<span class="tag mid">接近</span>' : '<span class="tag no">差距大</span>');
  const vReal = c.speedReal;
  const propChips = `<div class="row">
    <button class="chip ${isBatProp(PROP_DEFAULT) ? 'on' : ''}" data-batprop="orig">遊戲目前比例</button>
    <button class="chip ${isBatProp(PROP_MLB) ? 'on' : ''}" data-batprop="mlb">大聯盟比例</button></div>`;
  const plateFar = 85 + 21.6;
  panel.innerHTML = `
  ${compareBlock('/lab/concept_batter.jpg', '對照：大聯盟寫實打者 vs 我們目前（預備姿勢）')}
  <h2>打者模型的比例優化</h2>
  ${propChips}
  <div class="card">
    <p>${swing.reachMax >= plateFar ? '<span class="tag ok">涵蓋</span>' : '<span class="tag no">搆不到</span>'}<b>擊球前後棒頭最遠伸到：</b>${swing.reachMax.toFixed(0)} 公分（本壘板外側邊緣在 ${plateFar.toFixed(0)} 公分）</p>
    <p style="font-size:12px;color:var(--dim);margin:0">切換「大聯盟比例」會把頭縮小、手臂和腿拉長，揮棒數據會重新計算，可以直接看比例對打擊的影響。手肘大幅彎曲時前臂會有些變形（骨頭縮放近似），真正寫實要重做模型。</p>
  </div>
  <h2>打擊人員：揮棒逐格分析</h2>
  <p style="font-size:12px;color:var(--dim)">下方時間軸是整段真人揮棒動作（含遊戲跳過的載重、跨步），可拖曳逐格看，或按播放（可選慢速）。數據即時計算自目前的模型與動作。</p>
  <div class="card" id="liveCard"></div>

  <h2>關鍵發現</h2>
  <div class="card">
    <p><span class="tag no">差距大</span><b>遊戲跳過了載重與跨步：</b>遊戲的揮棒從真人動作的 ${GAME_T0.toFixed(2)} 秒才開始（時間軸上的黃色虛線），預備姿勢直接切到「啟動」。大聯盟打者的節奏是預備 → 抬腳載重 → 跨步落地 → 啟動，這兩段在我們遊戲裡看不到。</p>
    <p><span class="tag no">差距大</span><b>真人資料是慢速示範揮棒：</b>原速棒頭速度只有 ${c.speedReal.toFixed(0)} km/h，大聯盟平均約 113～121 km/h；遊戲用約 2 倍速播放才顯得夠快，但手腳的節奏也因此不自然。</p>
  </div>

  <h2>擊球瞬間 vs 大聯盟通用參考</h2>
  <div class="card">
    <p>${tag(vReal >= 105 ? 2 : vReal >= 85 ? 1 : 0)}<b>棒頭速度：</b>${vReal.toFixed(0)} km/h（真人動作原速）<br><span class="src">大聯盟平均約 113～121 km/h（70～75 mph，Statcast 揮棒速度）。遊戲中實際播放出來的速度：${c.speedGame.toFixed(0)} km/h。</span></p>
    <p>${tag(l.sep >= 25 && l.sep <= 60 ? 2 : l.sep >= 15 ? 1 : 0)}<b>跨步落地時髖肩分離：</b>${l.sep.toFixed(0)}°<br><span class="src">打擊力學常見範圍約 30～50°：下半身先轉、肩膀留在後面，力量才傳得上來。</span></p>
    <p>${tag(c.headMove <= 10 ? 2 : c.headMove <= 18 ? 1 : 0)}<b>擊球時頭部位移：</b>${c.headMove.toFixed(0)} 公分<br><span class="src">頭越穩越好，一般希望在 10 公分以內。</span></p>
    <p>${tag(c.batAngle <= 5 && c.batAngle >= -35 ? 2 : 1)}<b>擊球時球棒角度：</b>${c.batAngle.toFixed(0)}°（負值＝棒頭低於握把）<br><span class="src">中間高度的球，球棒接近水平或棒頭稍低。</span></p>
    <p>${tag(l.stride >= 15 && l.stride <= 60 ? 2 : 1)}<b>跨步距離：</b>${l.stride.toFixed(0)} 公分（前腳最高抬起 ${swing.peak.footUp.toFixed(0)} 公分）</p>
  </div>

  <h2>預備姿勢類型（大聯盟常見的幾種）</h2>
  <div class="row">${chips}</div>
  <p style="font-size:12px;color:var(--dim)">切換只影響這一頁，不會改到遊戲。選好喜歡的類型，再跟我說要不要套進遊戲。</p>

  <h2>曲線</h2>
  <div class="card"><b style="font-size:13px">棒頭速度（km/h，真人原速）</b>${sparkline('speedReal', '#ff7a4d', 'km/h')}</div>
  <div class="card"><b style="font-size:13px">雙手高度（公分）</b>${sparkline('handsCm', '#7fb2ff', '公分')}</div>
  <div class="card"><b style="font-size:13px">前腳抬起高度（公分）</b>${sparkline('footUp', '#a0e4ff', '公分')}</div>


  <h2>打擊動作的優化方向</h2>
  <ul>
    <li><b>比例先修：</b>手臂短是棒子搆不到的主因，換成寫實比例後，揮棒軌跡自然能涵蓋整個本壘板。</li>
    <li><b>多段動作庫：</b>大聯盟遊戲每位打者有自己的預備與揮棒；我們目前全隊共用一套，可先做 4～5 種預備類型。</li>
    <li><b>依球路調整：</b>已做揮棒高度跟著瞄準點；下一步是內外角改變擊球點前後（內角早擊、外角晚擊）。</li>
    <li><b>手指握棒：</b>需要五指分開的手模型才能真正握住，現在靠打擊手套遮住。</li>
  </ul>
  ${SOURCES}`;
  bindPanel();
  updateLive();
  requestAnimationFrame(() => {
    if (inStance) snapshot('bat');
  });
}
function isBatProp(p) {
  return Object.keys(p).every((k) => Math.abs(batProp[k] - p[k]) < 1e-3);
}

function updateLive() {
  const card = $('#liveCard');
  if (!card || !swing) return;
  const s = swing.at(scrubU);
  const ph = swing.phases.find((p) => scrubU >= p.a && scrubU <= p.b);
  card.innerHTML = inStance
    ? '<p style="margin:0">目前顯示：<b>預備姿勢</b>（按播放或拖時間軸看揮棒）</p>'
    : `<div class="metric"><span class="name">階段</span><span class="val">${ph ? ph.name : ''}</span></div>
      <div class="metric"><span class="name">棒頭速度（真人原速）</span><span class="val">${s.speedReal.toFixed(0)} km/h</span></div>
      <div class="metric"><span class="name">雙手高度</span><span class="val">${(s.handsY * 100).toFixed(0)} 公分</span></div>
      <div class="metric"><span class="name">球棒角度</span><span class="val">${s.batAngle.toFixed(0)}°</span></div>
      <div class="metric"><span class="name">跨步距離</span><span class="val">${s.stride.toFixed(0)} 公分</span></div>
      <div class="metric"><span class="name">髖肩分離</span><span class="val">${s.sep.toFixed(0)}°</span></div>
      <div class="metric"><span class="name">頭部位移</span><span class="val">${s.headMove.toFixed(0)} 公分</span></div>`;
  document.querySelectorAll('svg .cursor').forEach((l) => {
    l.setAttribute('x1', scrubU * 300);
    l.setAttribute('x2', scrubU * 300);
  });
  $('#tlLabel').textContent = inStance ? '預備' : `${ph ? ph.name : ''} ${(scrubU * 100).toFixed(0)}%`;
}

function drawPhases() {
  $('#phases').innerHTML = swing.phases
    .map((p) => `<div class="phase" style="left:${p.a * 100}%;width:${(p.b - p.a) * 100}%;background:${p.c}">${p.name}</div>`)
    .join('') + `<div style="position:absolute;left:${GAME_F * 100}%;top:-26px;height:46px;border-left:2px dashed #d8ff3e"></div>
      <div style="position:absolute;left:calc(${GAME_F * 100}% + 4px);top:-26px;font-size:11px;color:#d8ff3e;white-space:nowrap">遊戲從這裡才開始揮</div>`;
}

function bindPanel() {
  panel.querySelectorAll('[data-prop]').forEach((el) => {
    el.addEventListener('input', () => {
      prop[el.dataset.prop] = +el.value;
      el.nextElementSibling.textContent = `${(+el.value).toFixed(2)}×`;
      refreshBody(60);
    });
  });
  panel.querySelectorAll('[data-preset]').forEach((el) => {
    el.addEventListener('click', () => {
      Object.assign(prop, el.dataset.preset === 'mlb' ? PROP_MLB : PROP_DEFAULT);
      refreshBody(0, true);
    });
  });
  panel.querySelectorAll('[data-stance]').forEach((el) => el.addEventListener('click', () => applyStance(el.dataset.stance)));
  panel.querySelectorAll('[data-batprop]').forEach((el) =>
    el.addEventListener('click', () => {
      Object.assign(batProp, el.dataset.batprop === 'mlb' ? PROP_MLB : PROP_DEFAULT);
      applyStance(stanceKey); // 重新取樣整段揮棒
    }),
  );
}

// ── 鏡頭 ──
const CAMS = {
  body: {
    正面: [[0.4, 1.1, 4.6], [0, 0.95, 0]],
    側面: [[4.6, 1.1, 0.4], [0, 0.95, 0]],
    斜前: [[3.0, 1.4, 3.4], [0, 0.95, 0]],
    背面: [[-0.3, 1.2, -4.6], [0, 0.95, 0]],
  },
  bat: {
    '斜後方（影片角度）': 'video',
    投手方向: 'pitcher',
    捕手方向: 'catcher',
    正面: 'front',
    上視圖: 'top',
  },
};
function setCam(name) {
  const c = CAMS[tab][name];
  if (Array.isArray(c)) {
    camera.position.fromArray(c[0]);
    controls.target.fromArray(c[1]);
  } else {
    const inner = batActor.group.userData.inner;
    inner.updateMatrixWorld(true);
    const dir = (x, y, z) => new THREE.Vector3(x, y, z).transformDirection(inner.matrixWorld);
    const plate = dir(-1, 0, 0);
    const catcher = dir(0, 0, -1);
    const at = (p, q, u) => plate.clone().multiplyScalar(p).add(catcher.clone().multiplyScalar(q)).add(new THREE.Vector3(0, u, 0));
    const presets = {
      video: [at(-3.0, 2.8, 1.8), at(0.25, -0.35, 1.0)],
      pitcher: [at(0.3, -4.2, 1.4), at(0.2, 0, 1.05)],
      catcher: [at(0.3, 4.2, 1.5), at(0.2, 0, 1.05)],
      front: [at(4.2, 0, 1.4), at(0, 0, 1.05)],
      top: [at(0.4, 0.01, 5.2), at(0.4, 0, 0)],
    };
    camera.position.copy(presets[c][0]);
    controls.target.copy(presets[c][1]);
  }
  controls.update();
  document.querySelectorAll('#cams .chip').forEach((b) => b.classList.toggle('on', b.textContent === name));
}
function buildCams() {
  $('#cams').innerHTML = Object.keys(CAMS[tab]).map((n) => `<button class="chip">${n}</button>`).join('')
    + (tab === 'body' ? ['idle', 'ready', 'run'].map((p) => `<button class="chip pose" data-pose="${p}">${{ idle: '站姿', ready: '守備預備', run: '跑步' }[p]}</button>`).join('') : '<button class="chip pose" id="toStance">回到預備姿勢</button>');
  $('#cams').querySelectorAll('.chip:not(.pose)').forEach((b) => b.addEventListener('click', () => setCam(b.textContent)));
  $('#cams').querySelectorAll('[data-pose]').forEach((b) =>
    b.addEventListener('click', () => {
      bodyActor.set(b.dataset.pose);
      refreshBody(400);
    }),
  );
  const ts = $('#toStance');
  if (ts) ts.addEventListener('click', toStance);
}
function toStance() {
  inStance = true;
  playing = false;
  $('#play').textContent = '▶ 播放';
  batActor.set('stance');
  updateLive();
}

function drawPlate() {
  plateGroup.clear();
  if (tab !== 'bat') return;
  const inner = batActor.group.userData.inner;
  inner.updateMatrixWorld(true);
  const plate = new THREE.Vector3(-1, 0, 0).transformDirection(inner.matrixWorld);
  const shape = new THREE.Shape([[-0.216, 0], [0.216, 0], [0.216, 0.216], [0, 0.432], [-0.216, 0.216]].map(([x, y]) => new THREE.Vector2(x, y)));
  const m = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshStandardMaterial({ color: '#f4f1ea' }));
  m.rotation.x = -Math.PI / 2;
  const c = plate.clone().multiplyScalar(0.85);
  m.position.set(c.x, 0.004, c.z);
  plateGroup.add(m);
  // 好球帶（中間高度約 0.48～1.08 公尺）
  const zone = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(0.43, 0.6, 0.43)),
    new THREE.LineBasicMaterial({ color: '#d8ff3e', transparent: true, opacity: 0.6 }),
  );
  zone.position.set(c.x, 0.78, c.z + 0.216 * 0);
  plateGroup.add(zone);
}

function setTab(t) {
  tab = t;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  bodyActor.group.visible = t === 'body';
  batActor.group.visible = t === 'bat';
  $('#timeline').classList.toggle('show', t === 'bat');
  buildCams();
  if (t === 'body') {
    refreshBody(0, true);
    setCam('斜前');
  } else {
    rulerGroup.clear();
    if (!swing) swing = analyzeSwing(batActor);
    toStance();
    batActor.update(0); // 先套用打擊時「面向本壘」的轉向，本壘板與鏡頭方向才算得對
    renderBatPanel();
    drawPhases();
    drawPlate();
    setCam('斜後方（影片角度）');
  }
  resize();
}

// ── 啟動 ──
(async () => {
  await loadPlayerModel();
  const kit = GAME.home.kit;
  bodyActor = makeActor({ ...kit, skin: '#e9b48e', hair: '#1d1a18', no: 7, name: '', look: {}, glove: 1 });
  batActor = makeActor({ ...kit, skin: '#e9b48e', hair: '#1d1a18', no: 7, name: '', look: { band: 'white' }, helmet: 1, bat: true });
  scene.add(bodyActor.group, batActor.group);
  // 動畫每一幀都會把骨頭位置重設，所以比例要在「動畫之後、手臂 IK 握棒之前」套用
  for (const [a, pp] of [[bodyActor, prop], [batActor, batProp]]) {
    const orig = a._tweak.bind(a);
    a._tweak = () => {
      applyProportions(a, pp);
      a.group.updateMatrixWorld(true);
      orig();
    };
  }
  bodyActor.set('idle');
  Object.assign(BATPOSE, BATPOSE_DEFAULT, { freeze: false }); // 只改這一頁的記憶體
  $('#speeds').innerHTML = [0.1, 0.25, 0.5, 1].map((s) => `<button class="chip ${s === speed ? 'on' : ''}" data-speed="${s}">${s === 1 ? '原速' : `${s}×`}</button>`).join('');
  $('#speeds').querySelectorAll('[data-speed]').forEach((b) =>
    b.addEventListener('click', () => {
      speed = +b.dataset.speed;
      $('#speeds').querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === b));
    }),
  );
  $('#play').addEventListener('click', () => {
    playing = !playing;
    if (playing && (inStance || scrubU >= 0.999)) scrubU = 0;
    inStance = false;
    $('#play').textContent = playing ? '❚❚ 暫停' : '▶ 播放';
  });
  $('#scrub').addEventListener('input', (e) => {
    playing = false;
    inStance = false;
    $('#play').textContent = '▶ 播放';
    scrubU = +e.target.value;
  });
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  setTab(new URLSearchParams(location.search).get('tab') === 'bat' ? 'bat' : 'body');
  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const dt = Math.min(0.05, clock.getDelta());
    if (tab === 'body') bodyActor.update(dt);
    else if (inStance) batActor.update(dt);
    else {
      if (playing) {
        scrubU += (dt * speed) / CLIP_END;
        if (scrubU >= 1) {
          scrubU = 1;
          playing = false;
          $('#play').textContent = '▶ 播放';
        }
        $('#scrub').value = scrubU;
      }
      swingPose(batActor, scrubU);
      updateLive();
    }
    controls.update();
    renderer.render(scene, camera);
  });
})();
