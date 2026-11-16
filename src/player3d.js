// 遊戲用的球員：載入帶骨架與動作的模型（public/models/player/player_game.glb），
// 對外介面和舊的 players.js 相同（makePlayer / makeActor），所以遊戲主程式不用改流程。
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

export { FIELD_POS } from './players.js';

const FPS = 30;
let SRC = null; // { scene, clips: {名稱: AnimationClip} }

// 遊戲開始前先載入一次；之後 makePlayer 才能同步建立球員
export function loadPlayerModel(url = '/models/player/player_game.glb') {
  return new Promise((resolve, reject) => {
    new GLTFLoader().load(
      url,
      (gltf) => {
        const clips = {};
        gltf.animations.forEach((c) => (clips[c.name] = c));
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
function tintedMaterial(base, { jersey, accent, pants, skin }, creamTop) {
  const m = base.clone();
  const u = {
    uAccent: { value: new THREE.Color(accent).convertLinearToSRGB() },
    uJersey: { value: new THREE.Color(jersey).convertLinearToSRGB() },
    uPants: { value: new THREE.Color(pants || jersey).convertLinearToSRGB() },
    uSkin: { value: new THREE.Vector3(1, 1, 1) },
    uCreamTop: { value: creamTop }, // 高於這個高度的米白色不換色（眼白也是淺暖白，不可以被當成球衣）
  };
  if (skin) {
    const c = new THREE.Color(skin).convertLinearToSRGB();
    const r = REF_SKIN.clone().convertLinearToSRGB();
    u.uSkin.value.set(Math.min(1.08, c.r / r.r), Math.min(1.08, c.g / r.g), Math.min(1.08, c.b / r.b));
  }
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vRestY;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRestY = position.y;'); // 靜止姿勢的高度，用來分球衣和褲子
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uAccent;\nuniform vec3 uJersey;\nuniform vec3 uPants;\nuniform vec3 uSkin;\nuniform float uCreamTop;\nvarying float vRestY;')
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
          float cream = smoothstep(0.5, 0.64, lum) * smoothstep(0.7, 0.78, ratio) * (1.0 - smoothstep(0.93, 0.97, ratio)) * step(s.b, s.r) * step(vRestY, uCreamTop);
          float skin = (1.0 - cream) * smoothstep(0.12, 0.2, s.r - s.b) * step(s.g, s.r) * step(s.b, s.g) * smoothstep(0.4, 0.55, lum);
          vec3 cloth = mix(uJersey, uPants, 1.0 - smoothstep(0.66, 0.7, vRestY));
          vec3 o = s;
          o = mix(o, uAccent * clamp(lum / 0.2, 0.0, 2.0), green);
          o = mix(o, cloth * clamp(lum / 0.86, 0.0, 1.12), cream);
          o = mix(o, s * uSkin, skin);
          diffuseColor.rgb = pow(clamp(o, 0.0, 1.0), vec3(2.2));
        }`,
      );
  };
  m.customProgramCacheKey = () => 'player-tint-2';
  return m;
}

/**
 * 建立一位球員（沿用舊介面的參數）。
 * opts: jersey / accent / pants 球隊配色；skin 膚色；bat 是否拿球棒。
 * glove：非 0 時戴手套（守備員）；helmet：非 0 時戴打擊頭盔、不戴帽子（打者）。
 * 目前模型不支援的舊參數會被忽略：hair、hairStyle、no（背號固定 17）、icon、gear 的護具。
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
      if (!tints.has(key)) tints.set(key, tintedMaterial(o.material, opts, key === 'cap' ? 99 : 1.03));
      o.material = tints.get(key);
    }
  });
  const group = new THREE.Group();
  group.add(inner);
  addGear(inner, opts);
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

// ── 裝備：守備員的手套、打者的頭盔。先在模型的靜止姿勢擺好位置，再掛到骨頭上跟著動 ──
const gearGeo = {};
const gearMat = {};
function addGear(inner, opts) {
  if (!opts.glove && !opts.helmet) return;
  inner.updateMatrixWorld(true);
  const bone = (name) => inner.getObjectByName(name);
  const mat = (key, color, rough) => gearMat[key] || (gearMat[key] = new THREE.MeshStandardMaterial({ color, roughness: rough }));
  const mesh = (geo, material) => {
    const m = new THREE.Mesh(geo, material);
    m.castShadow = true;
    m.frustumCulled = false;
    return m;
  };
  if (opts.glove && opts.gear !== 'ump') {
    // 手套戴在模型的左手（左投的球員整個模型會鏡射，手套就到右手）
    const hand = bone('handL');
    if (hand) {
      gearGeo.mitt = gearGeo.mitt || new THREE.SphereGeometry(0.1, 18, 14);
      gearGeo.thumb = gearGeo.thumb || new THREE.SphereGeometry(0.045, 12, 10);
      const leather = mat('leather', '#8a5527', 0.75);
      const glove = new THREE.Group();
      const palm = mesh(gearGeo.mitt, leather);
      palm.scale.set(0.95, 1.2, 0.62);
      const thumb = mesh(gearGeo.thumb, leather);
      thumb.position.set(-0.01, 0.03, 0.09);
      thumb.scale.set(0.9, 1.5, 0.9);
      glove.add(palm, thumb);
      glove.position.set(0.385, 0.62, 0); // 左手掌心再往指尖一點（模型座標：X 左、Y 上、Z 前）
      glove.rotation.z = 0.65; // 順著手臂的斜度
      inner.add(glove);
      glove.updateMatrixWorld(true);
      hand.attach(glove);
    }
  }
  if (opts.helmet) {
    const head = bone('head');
    const cap = inner.getObjectByName('cap');
    if (head) {
      if (cap) cap.visible = false; // 打者戴頭盔，不戴帽子
      gearGeo.shell = gearGeo.shell || new THREE.SphereGeometry(0.345, 32, 18, 0, Math.PI * 2, 0, Math.PI * 0.6);
      gearGeo.brim = gearGeo.brim || new THREE.CylinderGeometry(0.27, 0.27, 0.03, 28, 1, false, -Math.PI / 2, Math.PI);
      gearGeo.flap = gearGeo.flap || new THREE.SphereGeometry(0.15, 18, 12);
      const shellMat = new THREE.MeshStandardMaterial({ color: opts.accent || '#1f5a4c', roughness: 0.32, metalness: 0.05 });
      const helmet = new THREE.Group();
      const shell = mesh(gearGeo.shell, shellMat);
      const brim = mesh(gearGeo.brim, shellMat);
      brim.position.set(0, -0.045, 0.2);
      brim.rotation.x = 0.16;
      // 護耳在面向投手的那一側。右打者的左耳朝投手；左打者整個模型鏡射，護耳也跟著換邊
      const flap = mesh(gearGeo.flap, shellMat);
      flap.position.set(0.3, -0.13, 0.0);
      flap.scale.set(0.42, 1, 0.95);
      helmet.add(shell, brim, flap);
      helmet.position.set(0, 1.44, -0.06); // 頭的中心略高處
      inner.add(helmet);
      helmet.updateMatrixWorld(true);
      head.attach(helmet);
    }
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
      inner.scale.x = mirror;
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
