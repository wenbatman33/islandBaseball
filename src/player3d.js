// 遊戲用的球員：載入帶骨架與動作的模型（public/models/player/player_game.glb），
// 頭、頭髮、帽子都用模型本身雕好的造型，不用程式另外捏。
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

// 守備位置（本壘在原點，+X 一壘側，-Z 外野方向）
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

const FPS = 30;
let SRC = null; // { scene, clips: {名稱: AnimationClip} }

// 遊戲開始前先載入一次；之後 makePlayer 才能同步建立球員
export function loadPlayerModel(url = '/models/player/player_game.glb') {
  return new Promise((resolve, reject) => {
    new GLTFLoader().load(
      url,
      (gltf) => {
        const clips = {};
        // 動作檔裡的縮放軌道全是 1，拿掉後才能用骨頭縮放做出每個人不同的頭型
        gltf.animations.forEach((c) => {
          c.tracks = c.tracks.filter((t) => !t.name.endsWith('.scale'));
          clips[c.name] = c;
        });
        SRC = { scene: gltf.scene, clips };
        resolve(SRC);
      },
      undefined,
      reject,
    );
  });
}

// ── 換色：模型只有一張貼圖（米白球衣、深綠配色）。在著色器裡依顏色判斷是哪一種布料，換成球隊的顏色 ──
// 深綠（帽子、內搭、襪子、滾邊、背號）→ accent；米白（球衣）→ jersey；腰帶以下的米白（褲子）→ pants；膚色乘上膚色係數
const REF_SKIN = new THREE.Color('#f2c29e');
// 背號與姓名印在背上的範圍、臉部特徵貼在臉上的範圍（模型靜止姿勢的座標：x0, y0, 寬, 高）
const BACK_RECT = new THREE.Vector4(-0.135, 0.735, 0.27, 0.25);
const FACE_RECT = new THREE.Vector4(-0.32, 1.02, 0.64, 0.64);
let BLANK = null;
const blankTex = () => BLANK || (BLANK = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1));

const texCache = new Map();
function canvasTex(key, size, draw) {
  if (texCache.has(key)) return texCache.get(key);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = 4;
  texCache.set(key, t);
  return t;
}

// 背上的姓名與背號（只用透明度當遮罩，顏色由著色器用球隊配色上色）
function backTexture(no, name) {
  if (no == null && !name) return blankTex();
  return canvasTex(`back|${no}|${name}`, 512, (ctx, S) => {
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (name) {
      ctx.font = `700 ${name.length > 2 ? 84 : 92}px "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", sans-serif`;
      const gap = name.length > 2 ? 14 : 44;
      const widths = [...name].map((ch) => ctx.measureText(ch).width);
      let x = S / 2 - (widths.reduce((p, c) => p + c, 0) + gap * (name.length - 1)) / 2;
      [...name].forEach((ch, i) => {
        ctx.fillText(ch, x + widths[i] / 2, 74);
        x += widths[i] + gap;
      });
    }
    if (no != null) {
      ctx.font = '700 380px "Barlow Condensed", "Arial Narrow", Impact, sans-serif';
      const text = String(no);
      const w = ctx.measureText(text).width;
      ctx.save();
      ctx.translate(S / 2, 318);
      ctx.scale(Math.min(1.25, 380 / w), 1); // 一位數加寬一點，兩位數不超出背部
      ctx.fillText(text, 0, 0);
      ctx.restore();
    }
  });
}

// 臉部特徵：畫在一張透明的圖上，再從正面貼到臉上。座標換算：模型的 (x, y) → 畫布
function faceTexture(kind, hair) {
  if (!kind || kind === 'none') return blankTex();
  return canvasTex(`face|${kind}|${hair}`, 512, (ctx, S) => {
    const X = (x) => ((x - FACE_RECT.x) / FACE_RECT.z) * S;
    const Y = (y) => (1 - (y - FACE_RECT.y) / FACE_RECT.w) * S;
    const L = (v) => (v / FACE_RECT.z) * S;
    const ell = (x, y, rx, ry, rot = 0) => {
      ctx.beginPath();
      ctx.ellipse(X(x), Y(y), L(rx), L(ry), rot, 0, Math.PI * 2);
      ctx.fill();
    };
    const soft = (x, y, rx, ry, color, a) => {
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      g.addColorStop(0, color.replace('A', a));
      g.addColorStop(0.55, color.replace('A', a * 0.8));
      g.addColorStop(1, color.replace('A', 0));
      ctx.save();
      ctx.translate(X(x), Y(y));
      ctx.scale(L(rx), L(ry));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, 1, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    };
    const hc = new THREE.Color(hair || '#1d1a18');
    const dark = `rgba(${Math.round(hc.r * 200)},${Math.round(hc.g * 200)},${Math.round(hc.b * 200)},A)`;
    if (kind === 'eyeblack') {
      // 眼睛下方的防眩光黑條
      ctx.fillStyle = 'rgba(22,22,26,0.9)';
      for (const sx of [-1, 1]) ell(sx * F.eyeX, F.eyeY - 0.078, 0.036, 0.0105, sx * -0.1);
    } else if (kind === 'stubble') {
      soft(0, F.mouthY - 0.005, 0.15, 0.062, 'rgba(70,74,82,A)', 0.3);
    } else if (kind === 'goatee') {
      ctx.fillStyle = dark.replace('A', 0.9);
      ell(0, F.mouthY - 0.05, 0.036, 0.024);
    } else if (kind === 'mustache') {
      ctx.fillStyle = dark.replace('A', 0.9);
      for (const sx of [-1, 1]) ell(sx * 0.03, F.mouthY + 0.03, 0.036, 0.011, sx * 0.22);
    } else if (kind === 'brows') {
      // 粗眉：蓋在原本的眉毛上，眉尾上揚
      ctx.fillStyle = dark.replace('A', 1);
      for (const sx of [-1, 1]) ell(sx * F.eyeX, F.browY + 0.004, 0.068, 0.019, sx * -0.2);
    } else if (kind === 'freckle') {
      ctx.fillStyle = 'rgba(150,84,52,0.55)';
      for (const sx of [-1, 1]) for (const [dx, dy] of [[0, 0], [0.03, 0.012], [-0.028, 0.01], [0.012, -0.018], [-0.014, -0.02]]) ell(sx * (F.eyeX + 0.02) + dx, F.eyeY - 0.095 + dy, 0.006, 0.006);
    }
  });
}
// 臉上的定位點（模型靜止姿勢的座標）
const F = { eyeX: 0.123, eyeY: 1.234, browY: 1.335, mouthY: 1.126 };

function tintedMaterial(base, { jersey, accent, pants, skin, hair, no, name, look }, creamTop, decal) {
  const m = base.clone();
  const u = {
    uAccent: { value: new THREE.Color(accent).convertLinearToSRGB() },
    uJersey: { value: new THREE.Color(jersey).convertLinearToSRGB() },
    uPants: { value: new THREE.Color(pants || jersey).convertLinearToSRGB() },
    uSkin: { value: new THREE.Vector3(1, 1, 1) },
    uCreamTop: { value: creamTop }, // 高於這個高度的米白色不換色（眼白也是淺暖白，不可以被當成球衣）
    uDecal: { value: decal ? 1 : 0 }, // 身體才有背號、髮色、臉部特徵；帽子沒有
    uHair: { value: new THREE.Color(hair || '#1d1a18').convertLinearToSRGB() },
    uBackTex: { value: decal ? backTexture(no, name) : blankTex() },
    uFaceTex: { value: decal ? faceTexture(look && look.face, hair) : blankTex() },
    uBackRect: { value: BACK_RECT },
    uFaceRect: { value: FACE_RECT },
    uFlip: { value: 1 }, // 左打／左投的模型左右鏡射時設為 -1，背上的字才不會跟著反過來
  };
  if (skin) {
    const c = new THREE.Color(skin).convertLinearToSRGB();
    const r = REF_SKIN.clone().convertLinearToSRGB();
    u.uSkin.value.set(Math.min(1.08, c.r / r.r), Math.min(1.08, c.g / r.g), Math.min(1.08, c.b / r.b));
  }
  m.userData.u = u;
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRest;\nvarying float vRestNz;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRest = position;\nvRestNz = normal.z;'); // 靜止姿勢的位置與朝向：分球衣和褲子、定位背號與臉
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec3 uAccent; uniform vec3 uJersey; uniform vec3 uPants; uniform vec3 uSkin; uniform vec3 uHair;
        uniform float uCreamTop; uniform float uDecal; uniform float uFlip;
        uniform sampler2D uBackTex; uniform sampler2D uFaceTex; uniform vec4 uBackRect; uniform vec4 uFaceRect;
        varying vec3 vRest; varying float vRestNz;`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        {
          vec3 s = pow(max(diffuseColor.rgb, 0.0), vec3(1.0 / 2.2));
          float mx = max(s.r, max(s.g, s.b));
          float mn = min(s.r, min(s.g, s.b));
          float ratio = mn / max(mx, 1e-3);
          float lum = dot(s, vec3(0.299, 0.587, 0.114));
          float green = smoothstep(0.02, 0.07, s.g - max(s.r, s.b));
          float cream = smoothstep(0.5, 0.64, lum) * smoothstep(0.7, 0.78, ratio) * (1.0 - smoothstep(0.93, 0.97, ratio)) * step(s.b, s.r) * step(vRest.y, uCreamTop);
          // 軀幹和腿上沒有露出皮膚：球衣皺褶的暖色陰影要當成布料，否則深色球衣會出現一塊塊膚色
          float clothZone = uDecal * step(vRest.y, 1.0) * step(abs(vRest.x), 0.27);
          cream = max(cream, clothZone * (1.0 - green) * smoothstep(0.3, 0.42, lum) * step(s.b, s.r));
          float skin = (1.0 - cream) * smoothstep(0.12, 0.2, s.r - s.b) * step(s.g, s.r) * step(s.b, s.g) * smoothstep(0.4, 0.55, lum);
          vec3 cloth = mix(uJersey, uPants, 1.0 - smoothstep(0.66, 0.7, vRest.y));
          // 背上原本印死的 17：整塊改回球衣布料，再印上這位球員自己的姓名與背號
          vec2 bu = (vRest.xy - uBackRect.xy) / uBackRect.zw;
          float back = uDecal * step(vRestNz, -0.1) * step(0.0, bu.x) * step(bu.x, 1.0) * step(0.0, bu.y) * step(bu.y, 1.0);
          green *= 1.0 - back;
          cream = mix(cream, 1.0, back);
          // 背號範圍內布料的明暗改成均勻的（邊緣漸進），原本的 17 才不會留下亮暗不同的殘影
          float soft = smoothstep(0.0, 0.12, bu.x) * smoothstep(0.0, 0.12, 1.0 - bu.x) * smoothstep(0.0, 0.1, bu.y) * smoothstep(0.0, 0.1, 1.0 - bu.y);
          float shade = mix(clamp(lum / 0.86, 0.0, 1.12), 0.95, back * max(soft, 1.0 - smoothstep(0.5, 0.64, lum)));
          vec3 o = s;
          o = mix(o, uAccent * clamp(lum / 0.2, 0.0, 2.0), green);
          o = mix(o, cloth * shade, cream);
          o = mix(o, s * uSkin, skin * (1.0 - back));
          float ink = texture2D(uBackTex, vec2(uFlip > 0.0 ? 1.0 - bu.x : bu.x, bu.y)).a * back;
          o = mix(o, uAccent * 0.92, ink);
          // 髮色：脖子以上的深色（頭髮、眉毛）
          float hairM = uDecal * step(1.03, vRest.y) * (1.0 - smoothstep(0.17, 0.27, lum)) * (1.0 - smoothstep(0.1, 0.2, mx - mn));
          o = mix(o, uHair * clamp(0.45 + lum * 5.0, 0.45, 1.7), hairM * 0.85);
          // 臉部特徵：從正面貼上
          vec2 fu = (vRest.xy - uFaceRect.xy) / uFaceRect.zw;
          float face = uDecal * smoothstep(0.05, 0.25, vRestNz) * step(0.0, fu.x) * step(fu.x, 1.0) * step(0.0, fu.y) * step(fu.y, 1.0);
          vec4 fc = texture2D(uFaceTex, fu);
          o = mix(o, fc.rgb, fc.a * face);
          diffuseColor.rgb = pow(clamp(o, 0.0, 1.0), vec3(2.2));
        }`,
      );
  };
  m.customProgramCacheKey = () => 'player-tint-10';
  return m;
}

/**
 * 建立一位球員（沿用舊介面的參數）。
 * opts: jersey / accent / pants 球隊配色；skin 膚色；bat 是否拿球棒。
 * glove：非 0 時戴手套（守備員）；helmet：非 0 時戴打擊頭盔、不戴帽子（打者）。
 * no / name：印在背上的背號與姓名；hair 髮色；look：體型、頭型、臉部特徵、配件（見 data.js 的 lookOf）。
 * gear：'catcher' 捕手護具、'ump' 主審裝備。flat：true 時不套用身高體型（頭像用）。
 */
export function makePlayer(opts) {
  if (!SRC) throw new Error('球員模型尚未載入，請先 await loadPlayerModel()');
  const inner = cloneSkinned(SRC.scene);
  const tints = new Map();
  let bat = null;
  inner.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.frustumCulled = false; // 有骨架的模型動起來會超出原本的範圍
    if (o.name === 'bat_mesh') {
      bat = o;
      o.visible = !!opts.bat;
    } else if (o.name === 'ball_mesh') {
      o.visible = false; // 遊戲有自己的球
    } else if (o.material.map) {
      // 身體：只有脖子以下的米白色算球衣（頭上的淺色是眼白）；帽子：帽徽可以換色
      const key = o.name === 'cap' ? 'cap' : 'body';
      if (!tints.has(key)) tints.set(key, tintedMaterial(o.material, opts, key === 'cap' ? 99 : 1.03, key === 'body'));
      o.material = tints.get(key);
    }
  });
  const group = new THREE.Group();
  group.add(inner);
  addGear(inner, opts);
  // 體型與頭型：整個人的高矮胖瘦用最外層縮放，頭的長寬用頭骨縮放（頭盔、面罩掛在頭骨上會一起變）
  const look = opts.look || {};
  const build = { h: opts.flat ? 1 : look.h || 1, w: opts.flat ? 1 : look.w || 1 };
  inner.scale.set(build.w, build.h, build.w);
  const headBone = inner.getObjectByName('head');
  if (headBone) {
    const k = look.head || 1;
    headBone.scale.set((k * (look.hx || 1)) / build.w, (k * (look.hy || 1)) / build.h, k / build.w);
  }
  group.userData.build = build;
  group.userData.tintU = tints.has('body') ? tints.get('body').userData.u : null;
  const mixer = new THREE.AnimationMixer(inner);
  const actions = {};
  for (const [name, clip] of Object.entries(SRC.clips)) actions[name] = mixer.clipAction(clip);
  actions.idle.play();
  mixer.update(0);
  group.userData.rig = { bat: bat || new THREE.Object3D() };
  group.userData.inner = inner;
  group.userData.mixer = mixer;
  group.userData.actions = actions;
  return group;
}

// ── 裝備：手套、頭盔、捕手護具、主審裝備、眼鏡、護腕。先在模型的靜止姿勢擺好位置，再掛到骨頭上跟著動 ──
// 模型座標：X 左、Y 上、Z 前。頭的中心約在 (0, 1.36, -0.03)、眼睛高 1.23、肩 0.93、腰 0.69、膝 0.29、腳踝 0.10
const gearGeo = {};
const gearMat = {};
const geo = (key, make) => gearGeo[key] || (gearGeo[key] = make());
const gmat = (key, color, rough = 0.6, metal = 0) => gearMat[key] || (gearMat[key] = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal }));
function part(g, material, pos, scale, rot) {
  const m = new THREE.Mesh(g, material);
  m.castShadow = true;
  m.frustumCulled = false;
  if (pos) m.position.set(pos[0], pos[1], pos[2]);
  if (scale) m.scale.set(scale[0], scale[1], scale[2]);
  if (rot) m.rotation.set(rot[0], rot[1], rot[2]);
  return m;
}
const sphere = () => geo('sphere', () => new THREE.SphereGeometry(1, 20, 14));
const box = () => geo('box', () => new THREE.BoxGeometry(1, 1, 1));
const shellGeo = () => geo('shell', () => new THREE.SphereGeometry(0.345, 32, 18, 0, Math.PI * 2, 0, Math.PI * 0.6));

function addGear(inner, opts) {
  inner.updateMatrixWorld(true);
  const bone = (name) => inner.getObjectByName(name);
  // 把一組零件掛到骨頭上（保持現在擺好的位置）
  const hang = (boneName, ...meshes) => {
    const b = bone(boneName);
    if (!b) return;
    const g = new THREE.Group();
    g.add(...meshes);
    inner.add(g);
    g.updateMatrixWorld(true);
    b.attach(g);
  };
  const look = opts.look || {};
  const catcher = opts.gear === 'catcher';
  const ump = opts.gear === 'ump';
  const accent = opts.accent || '#1f5a4c';

  if (opts.glove && !ump) {
    // 手套戴在模型的左手（左投的球員整個模型會鏡射，手套就到右手）。捕手用比較大、比較圓的捕手手套
    const leather = catcher ? gmat('mitt', '#6b3d1c', 0.7) : gmat('leather', '#8a5527', 0.75);
    const k = catcher ? 1.32 : 1;
    const glove = new THREE.Group();
    glove.add(part(sphere(), leather, null, [0.095 * k, 0.12 * k, 0.062 * k]));
    glove.add(part(sphere(), leather, [-0.01, 0.03, 0.09 * k], [0.04 * k, 0.068 * k, 0.04 * k]));
    glove.position.set(0.385, 0.62, 0); // 左手掌心再往指尖一點
    glove.rotation.z = 0.65; // 順著手臂的斜度
    hang('handL', glove);
  }

  if (opts.helmet || catcher || ump) {
    const cap = inner.getObjectByName('cap');
    if (cap) cap.visible = false; // 戴頭盔的人不戴帽子
    const shellMat = ump
      ? gmat('umpShell', '#16181c', 0.55)
      : new THREE.MeshStandardMaterial({ color: accent, roughness: 0.32, metalness: 0.05 });
    const helmet = new THREE.Group();
    helmet.add(part(shellGeo(), shellMat));
    if (opts.helmet && !catcher && !ump) {
      const brimGeo = geo('brim', () => new THREE.CylinderGeometry(0.27, 0.27, 0.03, 28, 1, false, -Math.PI / 2, Math.PI));
      helmet.add(part(brimGeo, shellMat, [0, -0.045, 0.2], null, [0.16, 0, 0]));
      // 護耳在面向投手的那一側。右打者的左耳朝投手；左打者整個模型鏡射，護耳也跟著換邊
      helmet.add(part(sphere(), shellMat, [0.3, -0.13, 0.0], [0.063, 0.15, 0.142]));
    }
    helmet.position.set(0, 1.44, -0.06); // 頭的中心略高處
    hang('head', helmet);
  }

  if (catcher || ump) {
    // 面罩：橢圓外框＋橫向與直向的護條（往前鼓出），上下有軟墊
    const steel = gmat('steel', '#23272d', 0.4, 0.5);
    const pad = ump ? gmat('umpPad', '#1b1d21', 0.85) : new THREE.MeshStandardMaterial({ color: accent, roughness: 0.8 });
    const ring = geo('maskRing', () => new THREE.TorusGeometry(0.2, 0.017, 8, 36));
    const arc = geo('maskArc', () => new THREE.TorusGeometry(0.2, 0.012, 6, 20, Math.PI));
    const CY = 1.25;
    const CZ = 0.265;
    const mask = [part(ring, steel, [0, CY, CZ], [1.02, 1.12, 1])];
    for (const dy of [-0.1, -0.03, 0.04, 0.11]) {
      const w = Math.sqrt(1 - (dy / 0.224) ** 2) * 1.02; // 橫條兩端剛好接在橢圓外框上
      mask.push(part(arc, steel, [0, CY + dy, CZ], [w, 0.42, 1], [Math.PI / 2, 0, 0]));
    }
    for (const dx of [-0.07, 0.07]) mask.push(part(arc, steel, [dx, CY, CZ], [1.07, 0.4, 1], [Math.PI / 2, Math.PI / 2, 0]));
    mask.push(part(sphere(), pad, [0, CY + 0.215, CZ - 0.012], [0.13, 0.036, 0.04])); // 額頭軟墊
    mask.push(part(sphere(), pad, [0, CY - 0.215, CZ - 0.012], [0.11, 0.036, 0.04])); // 下巴軟墊
    mask.push(part(sphere(), pad, [0, CY - 0.285, CZ - 0.03], [0.05, 0.05, 0.022])); // 護喉
    for (const sx of [-1, 1]) mask.push(part(box(), steel, [sx * 0.245, CY + 0.03, CZ - 0.11], [0.02, 0.035, 0.24], [0, sx * -0.38, 0])); // 兩側固定帶
    hang('head', ...mask);

    // 護胸：一節一節的橫向護墊，越往下越窄；背後有交叉的固定帶
    const chestMat = ump ? gmat('umpPad', '#1b1d21', 0.85) : new THREE.MeshStandardMaterial({ color: accent, roughness: 0.85 });
    const strap = gmat('strap', '#191b1f', 0.9);
    const chest = [];
    const rows = ump ? [[0.955, 0.165], [0.895, 0.172], [0.835, 0.165], [0.775, 0.15]] : [[0.955, 0.168], [0.895, 0.178], [0.835, 0.172], [0.775, 0.158], [0.715, 0.136]];
    const top = rows[0][0];
    const low = rows[rows.length - 1][0];
    chest.push(part(sphere(), chestMat, [0, (top + low) / 2, 0.05], [0.172, (top - low) / 2 + 0.045, 0.085])); // 底板
    for (const [y, w] of rows) chest.push(part(sphere(), chestMat, [0, y, 0.066], [w, 0.031, 0.09])); // 一節節的護墊
    for (const sx of [-1, 1]) chest.push(part(sphere(), chestMat, [sx * 0.155, 0.985, 0.012], [0.062, 0.036, 0.085])); // 肩墊
    if (!ump) {
      for (const sx of [-1, 1]) chest.push(part(box(), strap, [0, 0.855, -0.112], [0.03, 0.4, 0.014], [0, 0, sx * 0.72])); // 背後交叉帶
      chest.push(part(box(), strap, [0, 0.735, -0.108], [0.3, 0.028, 0.014])); // 腰帶
    }
    hang('chest', ...chest);
    if (!ump) hang('spine', part(sphere(), chestMat, [0, 0.645, 0.075], [0.085, 0.05, 0.05])); // 護襠片
  }

  if (catcher) {
    // 護脛：膝蓋護片＋小腿護殼＋腳背護片
    const guard = new THREE.MeshStandardMaterial({ color: accent, roughness: 0.6 });
    const strap = gmat('strap', '#191b1f', 0.9);
    for (const [side, sx] of [['L', 1], ['R', -1]]) {
      const x = sx * 0.111;
      hang(`shin${side}`,
        part(sphere(), guard, [x, 0.2, 0.03], [0.068, 0.105, 0.062]),
        part(sphere(), strap, [x, 0.2, 0.068], [0.014, 0.1, 0.03]),
        part(sphere(), guard, [x, 0.315, 0.04], [0.066, 0.052, 0.058]),
        part(box(), strap, [x, 0.24, -0.02], [0.13, 0.016, 0.1]),
        part(box(), strap, [x, 0.15, -0.02], [0.13, 0.016, 0.1]));
      hang(`thigh${side}`, part(sphere(), guard, [x, 0.375, 0.045], [0.06, 0.04, 0.05]));
      hang(`foot${side}`, part(sphere(), guard, [x, 0.075, 0.085], [0.055, 0.03, 0.06]));
    }
  }

  if (ump) {
    // 腰側的球袋
    hang('hips', part(sphere(), gmat('umpBag', '#2c3036', 0.9), [0.175, 0.62, 0.03], [0.05, 0.065, 0.06]));
  }

  if (look.glasses && !catcher && !ump) {
    // 眼鏡：細框（'sun' 為運動太陽眼鏡，鏡片是深色的）
    const sun = look.glasses === 'sun';
    const frame = gmat(sun ? 'sunFrame' : 'frame', sun ? '#14161a' : '#2a2320', 0.4, 0.3);
    const rim = geo('rim', () => new THREE.TorusGeometry(0.082, 0.008, 6, 24));
    const g = [];
    for (const sx of [-1, 1]) {
      g.push(part(rim, frame, [sx * 0.118, 1.236, 0.268], [1, 0.9, 1], [0, sx * 0.3, 0]));
      if (sun) g.push(part(geo('lens', () => new THREE.CircleGeometry(0.082, 20)), gmat('lens', '#1d2a33', 0.15, 0.6), [sx * 0.118, 1.236, 0.268], [1, 0.9, 1], [0, sx * 0.3, 0]));
      g.push(part(box(), frame, [sx * 0.245, 1.25, 0.14], [0.008, 0.012, 0.26], [0, sx * -0.3, 0])); // 鏡腳
    }
    g.push(part(box(), frame, [0, 1.25, 0.29], [0.075, 0.01, 0.008])); // 鼻樑
    hang('head', ...g);
  }

  if (look.band) {
    // 護腕：戴在手腕上方（'both' 兩手都戴）
    const bandMat = look.band === 'white' ? gmat('bandW', '#f2efe6', 0.9) : new THREE.MeshStandardMaterial({ color: accent, roughness: 0.9 });
    const cyl = geo('band', () => new THREE.CylinderGeometry(0.056, 0.058, 0.05, 16));
    hang('forearmR', part(cyl, bandMat, [-0.311, 0.716, 0], null, [0, 0, -0.653]));
    hang('forearmL', part(cyl, bandMat, [0.315, 0.719, 0], null, [0, 0, 0.645]));
  }
}

// 單次動作：把「遊戲裡的進度 0–1」對應到動作檔的時間（秒）。
// 投球：遊戲在進度 0.69 讓球離手，對到動作的出手那一格（第 41 格）。
// 揮棒：從跨步前開始，進度 0.42 對到擊球那一格（第 25 格）。
const ONE_SHOT = {
  pitch: [[0, 0], [0.69, 41 / FPS], [1, 56 / FPS]],
  swing: [[0, 17 / FPS], [0.42, 25 / FPS], [1, 36 / FPS]],
  throw: [[0, 0], [1, 16 / FPS]],
};
const BATTING = new Set(['stance', 'swing']);
const FADE = 0.12;

function mapTime(segs, u) {
  for (let i = 1; i < segs.length; i++) {
    if (u <= segs[i][0]) {
      const k = (u - segs[i - 1][0]) / (segs[i][0] - segs[i - 1][0]);
      return segs[i - 1][1] + (segs[i][1] - segs[i - 1][1]) * k;
    }
  }
  return segs[segs.length - 1][1];
}

// 把模型包成可播放姿勢的角色
export function makeActor(opts) {
  const group = makePlayer(opts);
  const { inner, mixer, actions } = group.userData;
  let current = actions.idle;
  const a = {
    group,
    rig: group.userData.rig,
    pose: 'idle',
    t: 0,
    u: 0,
    dur: 0,
    after: null,
    side: 1, // 打擊站位：-1 為左打
    hand: 1, // 慣用手：-1 為左投
    seed: Math.random() * 6,
    _switch(name, oneShot) {
      const next = actions[name] || actions.idle;
      if (next !== current) {
        next.reset();
        next.enabled = true;
        next.setEffectiveWeight(1);
        next.paused = oneShot;
        next.play();
        current.crossFadeTo(next, FADE, false);
        current = next;
      } else {
        next.paused = oneShot;
        if (oneShot) next.time = 0;
      }
      if (!oneShot && next.getClip().duration > 0) next.time = (a.seed / 6) * next.getClip().duration; // 每個人起始時間錯開，不會全隊同步晃動
    },
    // 循環姿勢
    set(name) {
      if (a.pose === name && !a.dur) return;
      a.pose = name;
      a.dur = 0;
      a.u = 0;
      a._switch(name, false);
    },
    // 單次動作，播完切到 after
    play(name, dur, after = 'idle') {
      a.pose = name;
      a.dur = dur;
      a.u = 0;
      a.after = after;
      a._switch(name, true);
      current.time = mapTime(ONE_SHOT[name] || [[0, 0], [1, current.getClip().duration]], 0);
    },
    update(dt) {
      if (!group.visible) return; // 沒顯示的球員（另一隊的守備）不用算動作
      a.t += dt;
      if (dt === 0) {
        // 只擺一次姿勢、時間沒有前進（開場介紹時）：動作切換的淡入不會發生，要直接切到位，
        // 否則會停在上一個姿勢（例如打者手垂著、球棒浮在半空）
        for (const act of Object.values(actions)) {
          if (act !== current) act.stop();
        }
        current.enabled = true;
        current.setEffectiveWeight(1);
      }
      // 左打／左投：整個模型左右鏡射
      const mirror = a.side < 0 || a.hand < 0 ? -1 : 1;
      inner.scale.x = mirror * group.userData.build.w;
      if (group.userData.tintU) group.userData.tintU.uFlip.value = mirror;
      // 遊戲把打者轉成面向本壘板；動作檔裡的打者是以「投手方向」為正前方，所以多轉 90 度
      inner.rotation.y = BATTING.has(a.pose) ? (a.side < 0 ? -1 : 1) * (Math.PI / 2) : 0;
      if (a.dur) {
        a.u = Math.min(1, a.u + dt / a.dur);
        current.time = mapTime(ONE_SHOT[a.pose] || [[0, 0], [1, current.getClip().duration]], a.u);
        mixer.update(dt);
        if (a.u >= 1) {
          const after = a.after;
          a.dur = 0;
          a.pose = '';
          a.set(after);
        }
        return;
      }
      mixer.update(dt);
    },
    face(x, z) {
      group.rotation.y = Math.atan2(x - group.position.x, z - group.position.z);
    },
  };
  return a;
}
