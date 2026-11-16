// 球員模型檢視頁：獨立於遊戲，只用來轉著看模型
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// 要檢視的模型清單（新版本加在這裡）
const MODELS = [
  { name: '第 5 版：含骨架與動作', url: '/models/player/player_v5_anim.glb' },
  // bare：按「隱藏帽子」時換上的完整頭髮版本（戴帽版的頭髮有一部分收在帽子裡）
  { name: '第 5 版：脫帽圖做頭＋帽子配件', url: '/models/player/player_v5.glb', bare: '/models/player/player_v5_bare.glb' },
  { name: '第 4 版：帽子獨立、耳朵實體', url: '/models/player/player_v4.glb' },
  { name: '第 3 版：頭部修正', url: '/models/player/player_v3.glb' },
  { name: '第 2 版：設定圖轉 3D', url: '/models/player/player_v2.glb' },
];

const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const BG_LIGHT = new THREE.Color('#b9bcc4');
const BG_DARK = new THREE.Color('#1b2026');
scene.background = BG_LIGHT.clone();

const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 100);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.minDistance = 0.6;
controls.maxDistance = 12;
controls.target.set(0, 0.9, 0);

// 燈光：預設不打光（模型貼圖本身已含光影）；打光模式用柔和的三點光
const hemi = new THREE.HemisphereLight('#ffffff', '#8a8f99', 1.5);
const key = new THREE.DirectionalLight('#fff3e0', 2.2);
key.position.set(-2.5, 4, 4);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
Object.assign(key.shadow.camera, { left: -2, right: 2, top: 3, bottom: -1, near: 0.5, far: 12 });
key.shadow.bias = -0.0005;
const rim = new THREE.DirectionalLight('#cfe0ff', 1.0);
rim.position.set(2.5, 3, -4);
scene.add(hemi, key, rim);

const ground = new THREE.Mesh(new THREE.CircleGeometry(3, 64), new THREE.ShadowMaterial({ opacity: 0.22 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

let current = null; // { root, meshes, originals }
// 動作播放
let mixer = null;
let playing = null; // 目前播放的動作
let slow = false;
const clock = new THREE.Clock();
const CLIP_NAMES = { idle: '待機', swing: '揮棒', pitch: '投球' };
// 球棒只在揮棒時出現、球只在投球時出現
function showProps(name) {
  if (!current) return;
  const bat = current.root.getObjectByName('bat_mesh');
  const ball = current.root.getObjectByName('ball_mesh');
  if (bat) bat.visible = name === 'swing';
  if (ball) ball.visible = name === 'pitch';
}
// 鏡頭跟著骨盆移動：角色跨步、前傾時，近距離特寫才不會跑出畫面
let hipBone = null;
const hipLast = new THREE.Vector3();
const hipNow = new THREE.Vector3();
function followHips(reset = false) {
  if (!hipBone) return;
  hipBone.getWorldPosition(hipNow);
  if (!reset) {
    const d = hipNow.clone().sub(hipLast);
    if (d.lengthSq() > 1e-10) {
      camera.position.add(d);
      controls.target.add(d);
      dirty = true;
    }
  }
  hipLast.copy(hipNow);
}
function play(clips, name) {
  if (!mixer) return;
  mixer.stopAllAction();
  playing = null;
  const clip = clips.find((c) => c.name === name);
  if (clip) {
    playing = mixer.clipAction(clip);
    playing.reset().play();
  }
  showProps(name);
  const row = document.getElementById('clips');
  [...row.querySelectorAll('button[data-clip]')].forEach((b) => b.classList.toggle('on', b.dataset.clip === (name || '')));
  draw();
}
function buildClipButtons(clips) {
  const row = document.getElementById('clips');
  [...row.querySelectorAll('button')].forEach((b) => b.remove());
  row.style.display = clips.length ? '' : 'none';
  if (!clips.length) return;
  const add = (label, name) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.dataset.clip = name;
    b.addEventListener('click', () => play(clips, name));
    row.appendChild(b);
  };
  add('靜止', '');
  clips.forEach((c) => add(CLIP_NAMES[c.name] || c.name, c.name));
  const sl = document.createElement('button');
  sl.type = 'button';
  sl.textContent = '慢動作';
  sl.classList.toggle('on', slow);
  sl.addEventListener('click', () => {
    slow = !slow;
    sl.classList.toggle('on', slow);
  });
  row.appendChild(sl);
}
let lit = false;
let wire = false;
let dirty = true;
// 立刻重畫一次（不等下一幀），確保載入、切角度、改尺寸後畫面一定更新
function draw() {
  renderer.render(scene, camera);
  dirty = false;
}
const $ = (id) => document.getElementById(id);

function applyMaterials() {
  if (!current) return;
  current.meshes.forEach((m, i) => {
    const src = current.originals[i];
    if (lit) {
      m.material = src;
    } else {
      // 不打光：直接顯示貼圖顏色
      m.material = new THREE.MeshBasicMaterial({ map: src.map || null, color: src.map ? 0xffffff : src.color });
    }
    m.material.wireframe = wire;
  });
  hemi.visible = key.visible = rim.visible = lit;
  ground.visible = lit;
  draw();
}

let faceZoom = false; // 臉部特寫：鏡頭拉近並對準頭部
let lastAngle = [25, 8];
function setAngle(deg, elev = 8) {
  lastAngle = [deg, elev];
  const d = faceZoom ? 1.9 : 5.2;
  const a = THREE.MathUtils.degToRad(deg);
  const e = THREE.MathUtils.degToRad(elev);
  const h = current ? current.height : 1.8;
  controls.target.set(0, h * (faceZoom ? 0.8 : 0.5), 0);
  camera.position.set(Math.sin(a) * Math.cos(e) * d, controls.target.y + Math.sin(e) * d, Math.cos(a) * Math.cos(e) * d);
  controls.update();
  draw();
}

// keepView：只換模型、不重設鏡頭（切換戴帽／不戴帽時用）
function load(entry, url = entry.url, keepView = false) {
  $('err').textContent = '';
  $('i-file').textContent = url;
  new GLTFLoader().load(
    url,
    (gltf) => {
      if (current) scene.remove(current.root);
      const root = gltf.scene;
      const meshes = [];
      let tris = 0;
      let tex = '無';
      let bones = 0;
      root.traverse((o) => {
        if (o.isBone) bones++;
        if (!o.isMesh) return;
        o.castShadow = true;
        o.frustumCulled = false; // 有骨架的模型動起來會超出原本的範圍
        meshes.push(o);
        const g = o.geometry;
        tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
        const img = o.material.map && o.material.map.image;
        if (img) tex = `${img.width}×${img.height}`;
      });
      const box = new THREE.Box3().setFromObject(root);
      root.position.y -= box.min.y; // 腳底貼地
      const height = box.max.y - box.min.y;
      current = { root, meshes, originals: meshes.map((m) => m.material), height };
      // 帽子是獨立物件（名稱 cap）時才能單獨隱藏
      const cap = root.getObjectByName('cap');
      $('cap').disabled = !cap && !entry.bare;
      if (!keepView) $('cap').classList.remove('on');
      $('i-parts').textContent = meshes.map((m) => m.name || '未命名').join('、');
      scene.add(root);
      $('i-tris').textContent = Math.round(tris).toLocaleString();
      $('i-tex').textContent = tex;
      $('i-h').textContent = `${height.toFixed(2)} 公尺`;
      $('i-rig').textContent = bones ? `有（${bones} 根骨頭）` : '無';
      $('i-anim').textContent = gltf.animations.length ? `${gltf.animations.length} 個` : '無';
      applyMaterials();
      mixer = gltf.animations.length ? new THREE.AnimationMixer(root) : null;
      hipBone = root.getObjectByName('hips') || null;
      root.updateMatrixWorld(true);
      followHips(true);
      playing = null;
      buildClipButtons(gltf.animations);
      if (mixer) play(gltf.animations, gltf.animations.some((c) => c.name === 'idle') ? 'idle' : '');
      if (!keepView) setAngle(25);
      else draw();
    },
    undefined,
    (e) => {
      $('err').textContent = `載入失敗：${e.message || e}`;
    },
  );
}

// ── 介面 ──
const sel = $('model');
MODELS.forEach((m, i) => sel.add(new Option(m.name, String(i))));
sel.addEventListener('change', () => load(MODELS[+sel.value]));
[['正面', 0], ['斜 25°', 25], ['斜 45°', 45], ['側面', 90], ['斜背', 140], ['背面', 180], ['俯視', 25, 55]].forEach(([label, deg, elev]) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', () => setAngle(deg, elev));
  $('angles').appendChild(b);
});
const toggle = (id, fn) =>
  $(id).addEventListener('click', (e) => {
    const on = e.currentTarget.classList.toggle('on');
    fn(on);
    draw();
  });
toggle('face', (on) => {
  faceZoom = on;
  setAngle(...lastAngle);
});
toggle('cap', (on) => {
  const entry = MODELS[+sel.value];
  if (entry.bare) {
    load(entry, on ? entry.bare : entry.url, true);
    return;
  }
  const cap = current && current.root.getObjectByName('cap');
  if (cap) cap.visible = !on;
});
toggle('spin', (on) => (controls.autoRotate = on));
toggle('lit', (on) => {
  lit = on;
  applyMaterials();
});
toggle('wire', (on) => {
  wire = on;
  applyMaterials();
});
toggle('bg', (on) => scene.background.copy(on ? BG_DARK : BG_LIGHT));
$('more').addEventListener('click', (e) => {
  const open = document.querySelector('.bar').classList.toggle('open');
  e.currentTarget.classList.toggle('on', open);
});
controls.autoRotateSpeed = 2.2;
controls.addEventListener('change', () => (dirty = true));

function resize() {
  // 以畫布實際顯示的大小為準（窄畫面時畫布只佔控制列下方的區域）
  const stage = canvas.parentElement;
  const w = stage.clientWidth || window.innerWidth;
  const h = stage.clientHeight || window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  draw();
}
window.addEventListener('resize', resize);
new ResizeObserver(resize).observe(canvas.parentElement);
resize();
load(MODELS[0]);

// 只有畫面有變化時才重畫，避免佔用電腦資源
renderer.setAnimationLoop(() => {
  if (document.hidden) return;
  controls.update();
  const dt = Math.min(clock.getDelta(), 0.1);
  if (mixer && playing) mixer.update(dt * (slow ? 0.25 : 1));
  followHips();
  if (dirty || controls.autoRotate || (mixer && playing)) {
    renderer.render(scene, camera);
    dirty = false;
  }
});
