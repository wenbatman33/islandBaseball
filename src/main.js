import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import '@fontsource/barlow-condensed/500.css';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';
import '@fontsource/barlow-condensed/700-italic.css';
import '@fontsource/barlow-condensed/600-italic.css';
import './ui.css';

import { LOOK, loadLook } from './look.js';
import { loadTuning, applyLayout, TUNE } from './tuning.js';
import { GAME, setMatchup } from './data.js';
import { chooseTeams } from './teamselect.js';
import { D2R } from './util.js';
import { buildField } from './field.js';
import { buildStadium } from './stadium.js';
import { buildEnvironment, buildSky } from './environment.js';
import { renderPortraits } from './portraits.js';
import { loadPlayerModel, loadPlayerSet } from './player3d.js';

// ── 不讓瀏覽器的手勢介入遊戲（手機）──
// iOS Safari 會忽略 viewport 的 user-scalable=no，所以縮放要另外用事件擋掉；長按的放大鏡與選單來自文字選取，
// CSS 已經關掉選取，這裡再擋掉長按選單與觸控的預設行為（DEV 面板與輸入框除外，才能捲動和打字）
{
  const editable = (t) => t instanceof Element && !!t.closest('.lil-gui, #dev-export, input, textarea, select');
  const stop = (e) => {
    if (!editable(e.target)) e.preventDefault();
  };
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(type, stop, { passive: false }); // iOS 雙指縮放
  document.addEventListener('contextmenu', stop); // 長按選單
  document.addEventListener('selectstart', stop);
  document.addEventListener('dblclick', stop);
  document.addEventListener('touchmove', stop, { passive: false }); // 拉動整頁、雙指縮放
  // 長按出現放大鏡：iOS 在 touchstart 沒被取消時才會啟動。按鈕與連結要保留點擊，其餘（畫面、搖桿、文字）都取消
  document.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length > 1) return stop(e);
      const t = e.target;
      if (editable(t) || (t instanceof Element && t.closest('button, a, [data-i]'))) return;
      e.preventDefault();
    },
    { passive: false },
  );
  let lastTap = 0; // 連點兩下放大
  document.addEventListener(
    'touchend',
    (e) => {
      const now = performance.now();
      if (now - lastTap < 320 && !editable(e.target)) e.preventDefault();
      lastTap = now;
    },
    { passive: false },
  );
  window.addEventListener('wheel', (e) => e.ctrlKey && e.preventDefault(), { passive: false }); // 觸控板捏合、Ctrl＋滾輪
  window.addEventListener('keydown', (e) => (e.ctrlKey || e.metaKey) && ['=', '+', '-', '0'].includes(e.key) && e.preventDefault());
}
import { buildIntroDOM, createDirector, SEGS } from './intro.js';
import { buildHud } from './hud.js';
import { buildGameUI } from './gameui.js';
import { createGame } from './game.js';
import { initAudio, sayParts, voiceStatus, setMuted, isMuted, onMute } from './audio.js';
import { introLines } from './commentary.js';
import { initDevTools } from './devtools.js';

// 自由鏡頭用的快速鏡位（DEV 面板）
export const VIEWS = {
  鳥瞰: { pos: [-225, 84, 165], target: [0, 8, -55] },
  轉播席: { pos: [0, 10.4, 27.4], target: [0, 1, -30] },
  打者: { pos: [3.4, 2.0, 8.2], target: [-0.6, 1.3, -18] },
  外野: { pos: [70, 34, -165], target: [0, 2, -20] },
  湖畔遠景: { pos: [330, 60, -430], target: [0, 20, -50] },
};

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uVignette: { value: 0.3 },
    uSaturation: { value: 1 },
    uContrast: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uVignette, uSaturation, uContrast;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      c.rgb = mix(vec3(l), c.rgb, uSaturation);
      c.rgb = (c.rgb - 0.5) * uContrast + 0.5;
      float v = smoothstep(0.9, 0.3, length(vUv - 0.5));
      c.rgb *= mix(1.0 - uVignette, 1.0, v);
      gl_FragColor = c;
    }`,
};

async function start() {
  loadLook();
  loadTuning();
  // 貼圖上的文字要用到字型，先等載入
  try {
    await Promise.all([
      document.fonts.load('italic 700 40px "Barlow Condensed"'),
      document.fonts.load('600 40px "Barlow Condensed"'),
      document.fonts.load('700 40px "Barlow Condensed"'),
    ]);
  } catch (e) {
    /* 字型載入失敗就用後備字型 */
  }

  const q = new URLSearchParams(location.search);
  // 檢查用參數：?seg=0~4 或 ?seg=live 直接停在該段，&t=0~1 指定進度
  const segParam = q.get('seg');
  const still = q.has('still') || segParam != null;
  if (still) document.body.classList.add('instant');

  const canvas = document.getElementById('scene');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5)); // 上限 1.5 倍，減輕顯示卡負擔
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(LOOK.camera.fov, 1, 0.3, 9000);

  const sky = buildSky();
  scene.add(sky);
  scene.add(buildEnvironment());
  scene.add(buildField());
  const stadium = buildStadium();
  scene.add(stadium);

  const hemi = new THREE.HemisphereLight();
  scene.add(hemi);
  const sun = new THREE.DirectionalLight();
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048); // 4096 太吃顯示卡；2048 在比賽鏡頭距離下看不出差別
  const sc = sun.shadow.camera;
  sc.left = -185;
  sc.right = 185;
  sc.top = 185;
  sc.bottom = -185;
  sc.near = 10;
  sc.far = 800;
  sun.shadow.bias = -0.0002;
  sun.shadow.normalBias = 0.12;
  sun.target.position.set(0, 0, -50);
  scene.add(sun, sun.target);
  scene.fog = new THREE.FogExp2(0xffffff, 0.001);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI / 2 - 0.02;
  controls.minDistance = 1;
  controls.maxDistance = 1400;
  controls.enabled = false;

  // 後製
  const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.3, 0.6, 0.9);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);

  // 球員模型要先載入，頭像和場上球員才能建立
  // 球員模型：預設是卡通比例的四個角色（守備員是 Tripo 生成並綁好骨架的，手套做在模型上；打者、捕手、裁判是 Meshy 的）。
  // 網址加 ?model=classic 用原本的漫畫風球員、?model=meshy 四個角色換回 Meshy 版（比較用）、?model=real 是寫實球員
  const modelKind = new URLSearchParams(location.search).get('model');
  // 四個角色都是 Tripo 生成的版本；?model=meshy 換回 Meshy 生成的舊版對照
  const SET = { batter: '/lab/tripo_batter.glb', fielder: '/lab/tripo_fielder.glb', catcher: '/lab/tripo_catcher.glb', umpire: '/lab/tripo_umpire.glb' };
  const MESHY = { batter: '/lab/chibi_batter.glb', fielder: '/lab/chibi_fielder.glb', catcher: '/lab/chibi_catcher.glb', umpire: '/lab/chibi_umpire.glb' };
  if (modelKind === 'classic') await loadPlayerModel();
  else if (modelKind === 'real') await loadPlayerModel('/lab/batter_pro_game.glb');
  else if (modelKind === 'meshy') await loadPlayerSet(MESHY);
  else await loadPlayerSet(SET, { gloveBaked: true, belt: { batter: 1.03, fielder: 0.97, catcher: 0.92, umpire: 0.93 } });

  // 選隊：選好之後才建立頭像、開場畫面與比賽（這些都是照對戰組合做的）
  const matchup = await chooseTeams();
  setMatchup(matchup.away, matchup.home);

  // UI
  renderPortraits(GAME);
  document.getElementById('game-tag').innerHTML = `<b>${GAME.title}</b>GAME ${GAME.no}`;
  buildIntroDOM(document.getElementById('intro'), document.getElementById('tags'), GAME);
  const liveEl = document.getElementById('live');
  const hud = buildHud(liveEl);
  const ui = buildGameUI(liveEl);
  applyLayout();

  const director = createDirector({ camera, controls, renderer });
  // ?auto 讓 AI 代打整場（測試用），可加倍率例如 ?auto=6
  if (q.has('auto')) {
    TUNE.auto = true;
    TUNE.timeScale = parseFloat(q.get('auto')) || 1;
  }
  const game = createGame({
    scene, camera, canvas, data: GAME, hud, ui, scoreboard: stadium.userData.scoreboard, director,
  });
  window.__game = game;
  // 預覽賽後畫面（不用真的打完一場）：網址加 ?end=win、?end=lose 或 ?end=tie
  const endPreview = q.get('end');
  if (['win', 'lose', 'tie'].includes(endPreview)) {
    const sc = { win: [2, 5], lose: [6, 3], tie: [4, 4] }[endPreview];
    const lines = { win: [[0, 2, 0], [1, 0, 4]], lose: [[3, 0, 3], [0, 2, 1]], tie: [[1, 3, 0], [2, 0, 2]] }[endPreview];
    liveEl.style.display = 'block';
    ui.final({ S: { score: sc, lines, hits: endPreview === 'lose' ? [10, 6] : [6, 9], inning: 3, regulation: 3 }, away: GAME.away, home: GAME.home, user: 1 });
  }
  window.__dbg = { camera, controls, director, renderer, scene }; // 檢查用
  director.setAnchors(game.anchors);
  director.setLiveCam(game.liveCam);
  director.onChange((st) => {
    if (st.mode === 'live') game.start();
    else game.setPaused(true);
  });
  // 開場轉播：每換一段介紹就播報一句（球場與賽事、對戰組合、打序、守備、先發投手）
  const A = GAME.away;
  const H = GAME.home;
  const INTRO_LINES = introLines(GAME);
  window.__voice = voiceStatus; // 檢查用
  // 右上角的靜音按鍵（和 M 鍵同一個開關）
  const muteBtn = document.getElementById('mute-toggle');
  onMute((off) => {
    muteBtn.classList.toggle('off', off);
    muteBtn.querySelector('span').textContent = off ? '已靜音' : '聲音開';
  });
  muteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setMuted(!isMuted());
    muteBtn.blur(); // 不然之後按空白鍵會變成又按一次這顆按鈕
  });
  let lastIntroKey = null;
  let soundOn = false; // 使用者點過一次之後才能出聲
  director.onChange((st) => {
    const key = st.mode === 'intro' ? SEGS[st.index].key : null;
    if (key && key !== lastIntroKey && !director.state.paused && soundOn) sayParts([INTRO_LINES[key]], true, 'calm');
    lastIntroKey = director.state.paused ? null : key;
  });
  initAudio();

  function setView(name) {
    const v = VIEWS[name];
    if (!v) return;
    director.setFree(true);
    camera.position.set(...v.pos);
    controls.target.set(...v.target);
    camera.fov = LOOK.camera.fov;
    camera.updateProjectionMatrix();
    controls.update();
  }

  function applyLook() {
    const L = LOOK;
    const az = L.sun.azimuth * D2R;
    const el = L.sun.elevation * D2R;
    const dir = new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
    sun.position.copy(sun.target.position).addScaledVector(dir, 400);
    sun.color.set(L.sun.color);
    sun.intensity = L.sun.intensity;
    hemi.color.set(L.hemi.sky);
    hemi.groundColor.set(L.hemi.ground);
    hemi.intensity = L.hemi.intensity;
    sky.material.uniforms.uTop.value.set(L.sky.top);
    sky.material.uniforms.uHorizon.value.set(L.sky.horizon);
    sky.material.uniforms.uMid.value.set(L.sky.mid);
    sky.material.uniforms.uSunColor.value.set(L.sky.sunGlow);
    sky.material.uniforms.uSunDir.value.copy(dir);
    scene.fog.color.set(L.fog.color);
    scene.fog.density = L.fog.density;
    renderer.toneMappingExposure = L.post.exposure;
    bloom.strength = L.post.bloomStrength;
    bloom.radius = L.post.bloomRadius;
    bloom.threshold = L.post.bloomThreshold;
    grade.uniforms.uVignette.value = L.post.vignette;
    grade.uniforms.uSaturation.value = L.post.saturation;
    grade.uniforms.uContrast.value = L.post.contrast;
    if (director.state.free) {
      camera.fov = L.camera.fov;
      camera.updateProjectionMatrix();
    }
    controls.autoRotateSpeed = L.camera.orbitSpeed;
  }

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    applyLayout();
  }
  window.addEventListener('resize', resize);

  applyLook();
  resize();

  initDevTools({ applyLook, setView, views: Object.keys(VIEWS), camera, controls, director, game });

  if (segParam != null) {
    if (segParam === 'live') director.goLive(false);
    else director.goto(Math.min(SEGS.length - 1, Math.max(0, parseInt(segParam, 10) || 0)));
    director.state.paused = true;
    director.state.t = parseFloat(q.get('t') ?? '0.6') * 8;
  } else if (q.has('still')) {
    director.state.paused = true;
    director.state.t = 99;
  } else if (!q.has('auto')) {
    // 開場一打開就自動播放。瀏覽器規定使用者點一下之後才能出聲，所以只放一個不擋畫面的小提示；
    // 第一次點擊或按鍵後，從當下這一段開始播報
    const hint = document.createElement('div');
    hint.id = 'sound-hint';
    hint.textContent = '點一下畫面開啟轉播聲音';
    document.body.appendChild(hint);
    const unlock = () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      hint.remove();
      soundOn = true;
      const st = director.state;
      if (st.mode === 'intro') setTimeout(() => sayParts([INTRO_LINES[SEGS[director.state.index].key]], true, 'calm'), 120); // 等音訊恢復運作
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }


  // 減輕負擔：上限 60 fps、陰影每 3 格更新、分頁不可見時不渲染
  renderer.shadowMap.autoUpdate = false;
  const clock = new THREE.Clock();
  let acc = 0;
  let frame = 0;
  renderer.setAnimationLoop(() => {
    acc += clock.getDelta();
    if (document.hidden) {
      acc = 0;
      return;
    }
    if (acc < 1 / 62) return;
    const dt = Math.min(0.1, acc);
    acc = 0;
    if (frame++ % 3 === 0) renderer.shadowMap.needsUpdate = true; // 陰影每 3 格更新一次
    if (director.state.free) {
      controls.autoRotate = LOOK.camera.autoOrbit;
      controls.update();
    }
    game.update(dt);
    director.update(dt);
    composer.render();
  });

  document.body.classList.add('ready');
}

start();
