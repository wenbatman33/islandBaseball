// 遊戲用的球員：載入帶骨架與動作的模型（public/models/player/player_v7.glb：Meshy 生成、Meshy 自動綁骨架、Meshy 文字轉動畫，
// 再用 tools/blender/rig_v7.py 整理），
// 頭、頭髮、帽子都用模型本身的造型，不用程式另外捏。帽子是獨立的網格（cap），戴頭盔時藏起來。
// 下面所有座標都是這個模型靜止姿勢的座標（公尺，Y 朝上、+Z 是臉的方向），量測值見 art/concept_v2/build/rig_v6.json
import * as THREE from 'three';
import { BATPOSE, applyBatPose, applySwingAim } from './batpose.js';
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
export function loadPlayerModel(url = '/models/player/player_v7.glb') {
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
        // 區域標記（Blender 匯出成頂點顏色）改名成 region：不讓 Three.js 當成要乘在顏色上的頂點顏色
        gltf.scene.traverse((o) => {
          const g = o.geometry;
          if (g && g.getAttribute('color')) {
            g.setAttribute('region', g.getAttribute('color'));
            g.deleteAttribute('color');
          }
          if (o.material) o.material.vertexColors = false;
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
const GLOVE_COLOR = '#22252b'; // 打擊手套：深灰黑，各隊通用
// 靜止姿勢的手肘、手腕位置（Blender 量的，player_v7.glb）：著色器用來畫護腕
const BAND = {
  R: [[-0.2537, 1.1893, -0.1046], [-0.3416, 0.9748, -0.0441]],
  L: [[0.2669, 1.1928, -0.1058], [0.3514, 0.973, -0.0494]],
};
// 背號與姓名印在背上的範圍、臉部特徵貼在臉上的範圍（模型靜止姿勢的座標：x0, y0, 寬, 高）
const BACK_RECT = new THREE.Vector4(-0.15, 1.1, 0.3, 0.29);
const FACE_RECT = new THREE.Vector4(-0.13, 1.56, 0.26, 0.26);
// 身體各部位的高度：領口（以上不算球衣、深色算頭髮）、腰帶（以下是褲子）、軀幹的半寬（以內沒有露出皮膚）
const BODY = { collar: 1.52, belt: 1.065, torsoX: 0.22, clothTop: 1.46 };
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
    const k = FS;
    if (kind === 'eyeblack') {
      // 眼睛下方的防眩光黑條
      ctx.fillStyle = 'rgba(22,22,26,0.9)';
      for (const sx of [-1, 1]) ell(sx * F.eyeX, F.eyeY - 0.028, 0.036 * k, 0.0105 * k, sx * -0.1);
    } else if (kind === 'stubble') {
      soft(0, F.mouthY - 0.004, 0.15 * k, 0.062 * k, 'rgba(70,74,82,A)', 0.3);
    } else if (kind === 'goatee') {
      ctx.fillStyle = dark.replace('A', 0.9);
      ell(0, F.mouthY - 0.034, 0.03 * k, 0.018 * k); // 下巴（嘴唇下方留一點距離，不然像張著嘴）
    } else if (kind === 'mustache') {
      ctx.fillStyle = dark.replace('A', 0.9);
      for (const sx of [-1, 1]) ell(sx * 0.03 * k, F.mouthY + 0.012, 0.036 * k, 0.011 * k, sx * 0.22);
    } else if (kind === 'brows') {
      // 粗眉：蓋在原本的眉毛上，眉尾上揚
      ctx.fillStyle = dark.replace('A', 1);
      for (const sx of [-1, 1]) ell(sx * F.eyeX, F.browY + 0.002, 0.068 * k, 0.019 * k, sx * -0.2);
    } else if (kind === 'freckle') {
      ctx.fillStyle = 'rgba(150,84,52,0.55)';
      for (const sx of [-1, 1]) for (const [dx, dy] of [[0, 0], [0.03, 0.012], [-0.028, 0.01], [0.012, -0.018], [-0.014, -0.02]]) ell(sx * (F.eyeX + 0.02 * k) + dx * k, F.eyeY - 0.04 + dy * k, 0.006 * k, 0.006 * k);
    }
  });
}
// 臉上的定位點（模型靜止姿勢的座標）
const F = { eyeX: 0.046, eyeY: 1.692, browY: 1.72, mouthY: 1.613 };
const FS = 0.42; // 臉部配件的尺寸係數（數字是照舊模型的大臉寫的）

function tintedMaterial(base, { jersey, accent, pants, skin, hair, no, name, look }, creamTop, decal) {
  const m = base.clone();
  m.vertexColors = false; // 頂點顏色是區域標記（著色器自己讀），不是拿來乘在顏色上的
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
    uGlove: { value: new THREE.Color(GLOVE_COLOR).convertLinearToSRGB() }, // 打擊手套顏色
    uGloveOn: { value: 0 }, // 打者才戴打擊手套（模型頂點顏色 B＝手）
    uBand: { value: new THREE.Color('#f2efe6').convertLinearToSRGB() }, // 護腕顏色
    uBandOn: { value: 0 },
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
      .replace('#include <common>', '#include <common>\nvarying vec3 vRest;\nvarying float vRestNz;\nattribute vec3 region;\nvarying vec3 vRegion;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRest = position;\nvRestNz = normal.z;\nvRegion = region;'); // 靜止姿勢的位置與朝向：分球衣和褲子、定位背號與臉
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec3 uAccent; uniform vec3 uJersey; uniform vec3 uPants; uniform vec3 uSkin; uniform vec3 uHair;
        uniform float uCreamTop; uniform float uDecal; uniform float uFlip;
        uniform vec3 uGlove; uniform float uGloveOn; uniform vec3 uBand; uniform float uBandOn;
        uniform sampler2D uBackTex; uniform sampler2D uFaceTex; uniform vec4 uBackRect; uniform vec4 uFaceRect;
        varying vec3 vRest; varying float vRestNz; varying vec3 vRegion;`,
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
          // 區域（模型的頂點顏色，Blender 裡用每個三角形的多數顏色標好）：R＝球衣布料、G＝皮膚。
          // 布料整塊換成隊色，只有細節（綠色滾邊、深色鈕扣）逐點判斷；皮膚整塊乘上膚色
          float green = smoothstep(0.02, 0.07, s.g - max(s.r, s.b)) * (1.0 - vRegion.g);
          float darkPix = 1.0 - smoothstep(0.16, 0.28, lum);
          float cream = uDecal * vRegion.r * (1.0 - green) * (1.0 - darkPix);
          float skin = vRegion.g * (1.0 - smoothstep(0.82, 0.95, ratio) * smoothstep(0.55, 0.75, lum)); // 眼白不跟著膚色變暗
          vec3 cloth = mix(uJersey, uPants, 1.0 - smoothstep(${(BODY.belt - 0.01).toFixed(3)}, ${(BODY.belt + 0.01).toFixed(3)}, vRest.y));
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
          float hairM = uDecal * step(${BODY.collar.toFixed(3)}, vRest.y) * (1.0 - smoothstep(0.17, 0.27, lum)) * (1.0 - smoothstep(0.1, 0.2, mx - mn));
          o = mix(o, uHair * clamp(0.45 + lum * 5.0, 0.45, 1.7), hairM * 0.85);
          // 臉部特徵：從正面貼上
          vec2 fu = (vRest.xy - uFaceRect.xy) / uFaceRect.zw;
          float face = uDecal * smoothstep(0.05, 0.25, vRestNz) * step(0.0, fu.x) * step(fu.x, 1.0) * step(0.0, fu.y) * step(fu.y, 1.0);
          vec4 fc = texture2D(uFaceTex, fu);
          o = mix(o, fc.rgb, fc.a * face);
          // 打擊手套與護腕：都用靜止姿勢的位置逐像素算（沿前臂方向離手腕多遠），邊緣是乾淨的一圈，手怎麼轉都貼著皮膚。
          // 手套：手腕往指尖整隻手；護腕：手腕往前臂 1.2～6.8 公分那一圈，剛好接在手套後面
          float gl = 0.0;
          float bd = 0.0;
          for (int k = 0; k < 2; k++) {
            vec3 hw = k == 0 ? vec3(${BAND.R[1].join(', ')}) : vec3(${BAND.L[1].join(', ')});
            vec3 el = k == 0 ? vec3(${BAND.R[0].join(', ')}) : vec3(${BAND.L[0].join(', ')});
            vec3 ax = normalize(hw - el);
            vec3 d = vRest - hw;
            float t = dot(d, ax);
            float r = length(d - ax * t);
            gl = max(gl, smoothstep(-0.016, -0.011, t) * (1.0 - smoothstep(0.24, 0.27, length(d))));
            bd = max(bd, smoothstep(-0.072, -0.066, t) * (1.0 - smoothstep(-0.016, -0.011, t)) * (1.0 - smoothstep(0.07, 0.08, r)));
          }
          float notCloth = 1.0 - vRegion.r; // 袖子、褲子不上色
          gl *= uGloveOn * notCloth;
          bd *= uBandOn * notCloth;
          o = mix(o, uBand * clamp(lum / 0.62, 0.7, 1.15), bd);
          o = mix(o, uGlove * clamp(lum / 0.62, 0.55, 1.25), gl);
          diffuseColor.rgb = pow(clamp(o, 0.0, 1.0), vec3(2.2));
        }`,
      );
  };
  m.customProgramCacheKey = () => 'player-tint-v10-glove';
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
      if (!tints.has(key)) tints.set(key, tintedMaterial(o.material, opts, key === 'cap' ? 99 : BODY.collar, key === 'body'));
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
  const headBone = inner.getObjectByName(BONE.head);
  if (headBone) {
    const k = look.head || 1;
    headBone.scale.set((k * (look.hx || 1)) / build.w, (k * (look.hy || 1)) / build.h, k / build.w);
  }
  group.userData.build = build;
  group.userData.tintU = tints.has('body') ? tints.get('body').userData.u : null;
  if (group.userData.tintU) {
    const u = group.userData.tintU;
    u.uGloveOn.value = opts.helmet ? 1 : 0; // 打者戴打擊手套
    u.uBandOn.value = look.band ? 1 : 0; // 護腕：白色或隊色
    if (look.band && look.band !== 'white') u.uBand.value.set(opts.accent || '#1f5a4c').convertLinearToSRGB();
  }
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
// 模型座標：X 左、Y 上、Z 前。帽子中心約 (0, 1.74, -0.055)、眼睛高 1.69、肩關節 1.40、腰帶 1.02、胯下 0.85、膝 0.50、腳踝 0.13
// 各組裝備的零件是照舊的 Q 版模型寫的（數字不動），用 fit() 整組從舊位置搬到新模型對應的位置並縮放
function fit(meshes, from, to, s) {
  const g = new THREE.Group();
  g.add(...meshes);
  const k = Array.isArray(s) ? s : [s, s, s];
  g.scale.set(...k);
  g.position.set(to[0] - from[0] * k[0], to[1] - from[1] * k[1], to[2] - from[2] * k[2]);
  return g;
}
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

const HELMET_TILT = -0.36; // 負值：頂部往後、前緣抬高（正值會讓前緣壓到眼睛）
// 裝備程式裡的骨頭名稱 → 模型的骨頭（Mixamo 命名；three.js 載入時會拿掉名稱裡的冒號）
const BONE = {
  head: 'mixamorigHead', chest: 'mixamorigSpine2', spine: 'mixamorigSpine', hips: 'mixamorigHips',
  handL: 'mixamorigLeftHand', handR: 'mixamorigRightHand', forearmL: 'mixamorigLeftForeArm', forearmR: 'mixamorigRightForeArm',
  thighL: 'mixamorigLeftUpLeg', thighR: 'mixamorigRightUpLeg', shinL: 'mixamorigLeftLeg', shinR: 'mixamorigRightLeg',
  footL: 'mixamorigLeftFoot', footR: 'mixamorigRightFoot',
};

function addGear(inner, opts) {
  inner.updateMatrixWorld(true);
  const bone = (name) => inner.getObjectByName(BONE[name] || name);
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
    const k = (catcher ? 1.32 : 1) * 1.25;
    const glove = new THREE.Group();
    glove.add(part(sphere(), leather, null, [0.095 * k, 0.12 * k, 0.062 * k]));
    glove.add(part(sphere(), leather, [-0.01, 0.03, 0.09 * k], [0.04 * k, 0.068 * k, 0.04 * k]));
    glove.position.set(0.37, 0.9, -0.03); // 左手掌心再往指尖一點
    glove.rotation.z = 0.38; // 順著手臂的斜度
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
      helmet.add(part(brimGeo, shellMat, [0, -0.045, 0.2], null, [0.16 - HELMET_TILT, 0, 0])); // 抵掉整頂往後傾的角度，帽簷才是平的
      // 護耳在面向投手的那一側。右打者的左耳朝投手；左打者整個模型鏡射，護耳也跟著換邊
      helmet.add(part(sphere(), shellMat, [0.3, -0.13, 0.0], [0.063, 0.15, 0.142]));
    }
    // 剛好比帽子大一圈，並往後傾：前緣停在眉毛上方，後緣往下蓋住後腦（帽子切掉後頭頂沒有頭髮，要蓋住）
    helmet.position.set(0, 1.76, -0.06);
    helmet.scale.set(0.43, 0.45, 0.48);
    helmet.rotation.x = HELMET_TILT;
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
    hang('head', fit(mask, [0, CY, CZ], [0, 1.69, 0.1], 0.48)); // 搬到新模型的臉前

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
    const TORSO = [[0, 0.835, 0], [0, 1.24, -0.06], [1.15, 1.55, 1.4]]; // 舊軀幹中心 → 新軀幹中心、縮放
    hang('chest', fit(chest, ...TORSO));
    if (!ump) hang('spine', fit([part(sphere(), chestMat, [0, 0.645, 0.075], [0.085, 0.05, 0.05])], ...TORSO)); // 護襠片
  }

  if (catcher) {
    // 護脛：膝蓋護片＋小腿護殼＋腳背護片
    const guard = new THREE.MeshStandardMaterial({ color: accent, roughness: 0.6 });
    const strap = gmat('strap', '#191b1f', 0.9);
    for (const [side, sx] of [['L', 1], ['R', -1]]) {
      const x = sx * 0.111;
      const LEG = [[x, 0.2, 0], [sx * 0.172, 0.31, -0.1], [1.1, 1.9, 1.15]]; // 舊小腿 → 新小腿（腿長很多）
      hang(`shin${side}`, fit([
        part(sphere(), guard, [x, 0.2, 0.03], [0.068, 0.105, 0.062]),
        part(sphere(), strap, [x, 0.2, 0.068], [0.014, 0.1, 0.03]),
        part(sphere(), guard, [x, 0.315, 0.04], [0.066, 0.052, 0.058]),
        part(box(), strap, [x, 0.24, -0.02], [0.13, 0.016, 0.1]),
        part(box(), strap, [x, 0.15, -0.02], [0.13, 0.016, 0.1])], ...LEG));
      hang(`thigh${side}`, fit([part(sphere(), guard, [x, 0.375, 0.045], [0.06, 0.04, 0.05])], ...LEG));
      hang(`foot${side}`, fit([part(sphere(), guard, [x, 0.075, 0.085], [0.055, 0.03, 0.06])], [x, 0.075, 0.085], [sx * 0.19, 0.1, 0.03], 1.2));
    }
  }

  if (ump) {
    // 腰側的球袋
    hang('hips', part(sphere(), gmat('umpBag', '#2c3036', 0.9), [0.225, 0.93, -0.03], [0.06, 0.08, 0.07]));
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
    hang('head', fit(g, [0, 1.236, 0.268], [0, 1.692, 0.082], [0.42, 0.42, 0.75])); // 搬到新模型的眼睛前面
  }

  // 護腕改由著色器畫在手腕皮膚上（模型頂點顏色 B＝0.5 那一圈），手轉動時永遠貼合，不再是會翹起來的圓筒
}

// 單次動作：把「遊戲裡的進度 0–1」對應到動作檔的時間（秒）。
// 投球：遊戲在進度 0.69 讓球離手，對到動作的出手那一格（第 41 格）。
// 揮棒：從跨步前開始，進度 0.42 對到擊球那一格（第 25 格）。
// 第 7 版：投球（Meshy 動作）在 1.25 秒出手；揮棒（CMU 真人動作捕捉）0.67 秒擊球；傳球在 0.5 秒出手
const ONE_SHOT = {
  pitch: [[0, 0], [0.69, 1.25], [1, 1.72]],
  swing: [[0, 0.45], [0.42, 0.67], [1, 1.13]], // CMU 真人揮棒：0.67 秒擊球
  throw: [[0, 0], [0.5, 0.5], [1, 0.85]],
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

function findBatBone(inner) {
  if (inner.userData.batBone === undefined) inner.userData.batBone = inner.getObjectByName('bat') || null;
  return inner.userData.batBone;
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
        a._tweak();
        if (a.u >= 1) {
          const after = a.after;
          a.dur = 0;
          a.pose = '';
          a.set(after);
        }
        return;
      }
      mixer.update(dt); // 時間照常走：動作之間的淡入淡出才會完成
      if (BATPOSE.freeze && a.pose === 'stance') {
        current.time = 0.7; // DEV：定格預備姿勢，方便和參考圖對照
        mixer.update(0);
      }
      a._tweak();
    },
    // 打擊姿勢微調層（DEV 面板可即時調整）：預備時整段套用，揮棒剛開始時平順退掉
    _tweak() {
      if (!BATTING.has(a.pose)) return;
      let w = 1;
      const bat = findBatBone(inner);
      if (a.pose === 'swing') {
        const k = Math.max(0, 1 - a.u / 0.25);
        w = k * k * (3 - 2 * k);
        // 擊球（u≈0.42）前後讓球棒經過瞄準點的高度：0.18 起漸入、0.5 後漸出
        const sm = (e0, e1, x) => {
          const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
          return t * t * (3 - 2 * t);
        };
        const wa = sm(0.18, 0.36, a.u) * (1 - sm(0.5, 0.75, a.u));
        applyBatPose(inner, bat, w);
        applySwingAim(inner, bat, wa, a.aimY ?? 0.78);
        return;
      }
      applyBatPose(inner, bat, w);
    },
    face(x, z) {
      group.rotation.y = Math.atan2(x - group.position.x, z - group.position.z);
    },
  };
  return a;
}
