import GUI from 'lil-gui';
import { LOOK, saveLook, resetLook } from './look.js';
import {
  LAYOUT, SHOTS, TUNE, saveTuning, resetTuning, applyLayout, layoutMode, setForcedMode,
} from './tuning.js';
import { SEGS } from './intro.js';
import * as THREE from 'three';
import { BATPOSE, saveBatPose, resetBatPose } from './batpose.js';

// DEV 微調面板：按 D 或右上角按鈕開關，調整即時生效，可匯出 JSON
export function initDevTools({ applyLook, setView, views, camera, controls, director, game }) {
  const gui = new GUI({ title: 'DEV 微調（D 鍵開關）', width: 330 });
  gui.domElement.style.zIndex = 50;
  gui.hide();
  let open = false;

  const changed = () => {
    applyLook();
    saveLook();
  };

  // ── 狀態切換 ──
  const fState = gui.addFolder('狀態切換');
  const stateActions = {};
  SEGS.forEach((s, i) => {
    stateActions[s.key] = () => {
      director.setFree(false);
      director.goto(i);
    };
    fState.add(stateActions, s.key).name(`開場 ${i + 1}：${s.label}`);
  });
  stateActions.live = () => {
    director.setFree(false);
    director.goLive(false);
  };
  stateActions.playball = () => {
    director.setFree(false);
    director.goLive(true);
  };
  fState.add(stateActions, 'live').name('比賽畫面');
  fState.add(stateActions, 'playball').name('PLAY BALL 動畫');
  fState.add(director.state, 'paused').name('暫停開場計時').listen();

  // ── 玩法 ──
  const fPlay = gui.addFolder('玩法');
  const st = () => saveTuning();
  fPlay.add(TUNE, 'speedScale', 0.3, 1, 0.01).name('球速倍率（小=慢）').onChange(st);
  fPlay.add(TUNE, 'pci', 0.08, 0.3, 0.005).name('打擊游標半徑').onChange(st);
  fPlay.add(TUNE, 'timing', 0.04, 0.25, 0.005).name('揮棒時機寬容（秒）').onChange(st);
  fPlay.add(TUNE, 'assist').name('顯示進壘點預測圈').onChange(st);
  fPlay.add(TUNE, 'aimAssist', 0, 1, 0.05).name('瞄準輔助（1=只看時機）').onChange(st);
  fPlay.add(TUNE, 'innings', 1, 9, 1).name('局數').onChange(st);
  fPlay.add(TUNE, 'extra', 0, 3, 1).name('延長賽最多幾局').onChange(st);
  fPlay.add(TUNE, 'auto').name('AI 代為操作');
  fPlay.add(TUNE, 'timeScale', 0.25, 8, 0.25).name('時間倍率');
  const playActions = {
    hr: () => game.debugHit('hr'),
    double: () => game.debugHit('double'),
    single: () => game.debugHit('single'),
    ground: () => game.debugHit('ground'),
    fly: () => game.debugHit('fly'),
    sw: () => game.debugSwitch(),
    end: () => game.debugEnd(),
  };
  fPlay.add(playActions, 'hr').name('觸發：全壘打');
  fPlay.add(playActions, 'double').name('觸發：長打');
  fPlay.add(playActions, 'single').name('觸發：平飛安打');
  fPlay.add(playActions, 'ground').name('觸發：滾地球');
  fPlay.add(playActions, 'fly').name('觸發：高飛球');
  fPlay.add(playActions, 'sw').name('觸發：攻守交替');
  fPlay.add(playActions, 'end').name('觸發：比賽結束');
  fPlay.close();

  // ── 鏡頭 ──
  const fShot = gui.addFolder('鏡頭（開場各段）');
  const shotUi = { free: false, dur: 7, shift: 0, 段落: '' };
  const cDur = fShot.add(shotUi, 'dur', 2, 20, 0.5).name('本段秒數').onChange((v) => {
    SHOTS[director.shotKey()].dur = v;
    saveTuning();
  });
  const cShift = fShot.add(shotUi, 'shift', -0.35, 0.35, 0.01).name('主體水平偏移').onChange((v) => {
    SHOTS[director.shotKey()].shift = v;
    saveTuning();
  });
  const cFree = fShot.add(shotUi, 'free').name('自由鏡頭（滑鼠拖曳）').onChange((v) => director.setFree(v));
  const capture = (which) => {
    const s = SHOTS[director.shotKey()];
    const data = {
      pos: camera.position.toArray().map((n) => +n.toFixed(2)),
      target: controls.target.toArray().map((n) => +n.toFixed(2)),
      fov: +camera.fov.toFixed(1),
    };
    if (which === 'from' || which === 'both') s.from = data;
    if (which === 'to' || which === 'both') s.to = JSON.parse(JSON.stringify(data));
    saveTuning();
  };
  const shotActions = {
    from: () => capture('from'),
    to: () => capture('to'),
    replay: () => {
      const i = SEGS.findIndex((s) => s.key === director.shotKey());
      director.setFree(false);
      if (i >= 0) director.goto(i);
    },
  };
  fShot.add(shotActions, 'from').name('目前鏡頭 → 設為本段起點');
  fShot.add(shotActions, 'to').name('目前鏡頭 → 設為本段終點');
  fShot.add(shotActions, 'replay').name('▶ 重播本段');
  fShot.add(LOOK.camera, 'fov', 15, 70, 1).name('自由鏡頭 FOV').onChange(changed);
  fShot.add(LOOK.camera, 'autoOrbit').name('自由鏡頭自動環繞').onChange(changed);
  const viewActions = {};
  views.forEach((name) => {
    viewActions[name] = () => setView(name);
    fShot.add(viewActions, name).name(`跳到：${name}`);
  });
  fShot.close();

  director.onChange((st) => {
    const s = SHOTS[director.shotKey()];
    shotUi.dur = s.dur;
    shotUi.shift = s.shift || 0;
    shotUi.free = st.free;
    cDur.updateDisplay();
    cShift.updateDisplay();
    cFree.updateDisplay();
  });

  // ── 打擊姿勢微調：拖滑桿即時看打者姿勢，調好按最下面的「匯出」 ──
  const fBat = gui.addFolder('打擊姿勢微調');
  const sb = () => saveBatPose();
  fBat.add(BATPOSE, 'on').name('套用微調').onChange(sb);
  fBat.add(BATPOSE, 'freeze').name('定格預備姿勢').onChange(sb);
  const batCam = (kind) => {
    const b = game.debugBatter?.();
    if (!b) return;
    const inner = b.group.userData.inner;
    inner.updateMatrixWorld(true);
    const dir = (x, y, z) => new THREE.Vector3(x, y, z).transformDirection(inner.matrixWorld);
    const plate = dir(-1, 0, 0);
    const catcher = dir(0, 0, -1);
    const up = new THREE.Vector3(0, 1, 0);
    const base = new THREE.Vector3().setFromMatrixPosition(inner.matrixWorld);
    const at = (p, c, u) => base.clone().add(plate.clone().multiplyScalar(p)).add(catcher.clone().multiplyScalar(c)).add(up.clone().multiplyScalar(u));
    const presets = {
      video: [at(-3.0, 2.8, 1.8), at(0.25, -0.35, 1.0)], // 影片的角度：打者斜後方、捕手那側
      front: [at(3.2, 0, 1.35), at(0, 0, 1.1)],
      pitcher: [at(0, -3.4, 1.35), at(0, 0, 1.1)],
      catcher: [at(0, 3.4, 1.35), at(0, 0, 1.1)],
      hands: [at(1.2, -1.2, 1.7), at(0, 0.1, 1.45)],
    };
    const [pos, tgt] = presets[kind];
    director.setFree(true);
    camera.fov = 30;
    camera.updateProjectionMatrix();
    camera.position.copy(pos);
    controls.target.copy(tgt);
    controls.update();
  };
  const camActs = {
    video: () => batCam('video'),
    front: () => batCam('front'),
    pitcher: () => batCam('pitcher'),
    catcher: () => batCam('catcher'),
    hands: () => batCam('hands'),
  };
  fBat.add(camActs, 'video').name('🎥 打者斜後方（影片角度）');
  fBat.add(camActs, 'front').name('🎥 打者正面');
  fBat.add(camActs, 'pitcher').name('🎥 從投手方向');
  fBat.add(camActs, 'catcher').name('🎥 從捕手方向');
  fBat.add(camActs, 'hands').name('🎥 近看雙手');
  const fGrip = fBat.addFolder('握點與球棒');
  fGrip.add(BATPOSE, 'gripPlate', -40, 40, 0.5).name('握點往本壘（公分）').onChange(sb);
  fGrip.add(BATPOSE, 'gripUp', -40, 40, 0.5).name('握點往上（公分）').onChange(sb);
  fGrip.add(BATPOSE, 'gripCatcher', -40, 40, 0.5).name('握點往捕手（公分）').onChange(sb);
  fGrip.add(BATPOSE, 'tiltBack', -90, 90, 1).name('球棒往背後倒（度）').onChange(sb);
  fGrip.add(BATPOSE, 'tiltCatcher', -90, 90, 1).name('球棒往捕手倒（度）').onChange(sb);
  fGrip.add(BATPOSE, 'roll', -90, 90, 1).name('球棒自轉（度）').onChange(sb);
  const fArm = fBat.addFolder('手臂與手肘');
  fArm.add(BATPOSE, 'elbowFront', -180, 180, 1).name('前手肘方向（度）').onChange(sb);
  fArm.add(BATPOSE, 'elbowBack', -180, 180, 1).name('後手肘方向（度）').onChange(sb);
  const fBody = fBat.addFolder('身體與腳');
  fBody.add(BATPOSE, 'crouch', -10, 30, 0.5).name('重心壓低（公分）').onChange(sb);
  fBody.add(BATPOSE, 'lean', -20, 40, 0.5).name('上身往本壘前傾（度）').onChange(sb);
  fBody.add(BATPOSE, 'spread', -30, 50, 0.5).name('兩腳再分開（公分）').onChange(sb);

  // 參考圖疊圖：把影片截圖拖進畫面、貼上（Cmd+V）或選檔案，半透明疊在畫面上對照
  const refImg = document.createElement('img');
  refImg.id = 'bp-ref';
  refImg.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);max-width:none;pointer-events:none;z-index:40;display:none;opacity:0.5';
  document.body.appendChild(refImg);
  const refUi = { show: true, opacity: 0.5, x: 0, y: 0, scale: 1, pick: () => fileIn.click() };
  const fileIn = document.createElement('input');
  fileIn.type = 'file';
  fileIn.accept = 'image/*';
  fileIn.style.display = 'none';
  document.body.appendChild(fileIn);
  const placeRef = () => {
    refImg.style.display = refImg.src && refUi.show ? 'block' : 'none';
    refImg.style.opacity = refUi.opacity;
    refImg.style.height = `${refUi.scale * 100}vh`;
    refImg.style.transform = `translate(calc(-50% + ${refUi.x}px), calc(-50% + ${refUi.y}px))`;
  };
  const loadRef = (file) => {
    if (!file || !file.type.startsWith('image/')) return;
    refImg.src = URL.createObjectURL(file);
    refUi.show = true;
    placeRef();
    fRef.controllersRecursive().forEach((c) => c.updateDisplay());
  };
  fileIn.addEventListener('change', () => loadRef(fileIn.files[0]));
  window.addEventListener('paste', (e) => {
    if (!open) return;
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (item) loadRef(item.getAsFile());
  });
  window.addEventListener('dragover', (e) => {
    if (open) e.preventDefault();
  });
  window.addEventListener('drop', (e) => {
    if (!open) return;
    e.preventDefault();
    loadRef(e.dataTransfer?.files?.[0]);
  });
  const fRef = fBat.addFolder('參考圖疊圖（拖進畫面／Cmd+V 貼上）');
  fRef.add(refUi, 'pick').name('📂 選擇參考圖檔案');
  fRef.add(refUi, 'show').name('顯示參考圖').onChange(placeRef);
  fRef.add(refUi, 'opacity', 0, 1, 0.01).name('透明度').onChange(placeRef);
  fRef.add(refUi, 'scale', 0.2, 3, 0.01).name('大小').onChange(placeRef);
  fRef.add(refUi, 'x', -1500, 1500, 1).name('左右位置').onChange(placeRef);
  fRef.add(refUi, 'y', -1000, 1000, 1).name('上下位置').onChange(placeRef);
  const batActs = {
    reset: () => {
      resetBatPose();
      fBat.controllersRecursive().forEach((c) => c.updateDisplay());
    },
  };
  fBat.add(batActs, 'reset').name('↺ 打擊姿勢歸零');
  fBat.close();

  // ── UI 版面 ──
  const fLay = gui.addFolder('UI 版面（可直接拖曳元件）');
  const layUi = { mode: 'auto', drag: false, key: '（先點選元件）', x: 0, y: 0, s: 1 };
  let selEl = null;
  const cKey = fLay.add(layUi, 'key').name('選取中').disable();
  const writeBack = () => {
    if (!selEl) return;
    const v = LAYOUT[layoutMode()][selEl.dataset.lay];
    v.x = layUi.x;
    v.y = layUi.y;
    v.s = layUi.s;
    applyLayout();
    saveTuning();
  };
  fLay.add(layUi, 'mode', { 自動依寬度: 'auto', PC: 'pc', Mobile: 'mobile' }).name('編輯的版面').onChange((v) => {
    setForcedMode(v);
    applyLayout();
    select(selEl);
  });
  fLay.add(layUi, 'drag').name('拖曳模式').onChange((v) => document.body.classList.toggle('dev-drag', v));
  const cX = fLay.add(layUi, 'x', -1200, 1200, 1).name('X 位移').onChange(writeBack);
  const cY = fLay.add(layUi, 'y', -900, 900, 1).name('Y 位移').onChange(writeBack);
  const cS = fLay.add(layUi, 's', 0.4, 2.2, 0.01).name('縮放').onChange(writeBack);
  fLay.close();

  function select(el) {
    document.querySelectorAll('[data-lay].sel').forEach((e) => e.classList.remove('sel'));
    selEl = el;
    if (!el) return;
    el.classList.add('sel');
    const v = LAYOUT[layoutMode()][el.dataset.lay];
    layUi.key = `${el.dataset.lay}（${layoutMode()}）`;
    layUi.x = v.x;
    layUi.y = v.y;
    layUi.s = v.s;
    [cKey, cX, cY, cS].forEach((c) => c.updateDisplay());
  }

  let drag = null;
  window.addEventListener('pointerdown', (e) => {
    if (!layUi.drag) return;
    const el = e.target.closest?.('[data-lay]');
    if (!el) return;
    e.preventDefault();
    select(el);
    const v = LAYOUT[layoutMode()][el.dataset.lay];
    drag = { v, sx: e.clientX, sy: e.clientY, x0: v.x, y0: v.y };
  });
  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    drag.v.x = Math.round(drag.x0 + e.clientX - drag.sx);
    drag.v.y = Math.round(drag.y0 + e.clientY - drag.sy);
    layUi.x = drag.v.x;
    layUi.y = drag.v.y;
    cX.updateDisplay();
    cY.updateDisplay();
    applyLayout();
  });
  window.addEventListener('pointerup', () => {
    if (drag) saveTuning();
    drag = null;
  });

  // ── 畫面風格 ──
  const fSun = gui.addFolder('太陽');
  fSun.add(LOOK.sun, 'azimuth', 0, 360, 1).name('方位角').onChange(changed);
  fSun.add(LOOK.sun, 'elevation', 2, 85, 0.5).name('仰角').onChange(changed);
  fSun.add(LOOK.sun, 'intensity', 0, 8, 0.05).name('強度').onChange(changed);
  fSun.addColor(LOOK.sun, 'color').name('顏色').onChange(changed);
  fSun.close();

  const fAmb = gui.addFolder('環境光');
  fAmb.addColor(LOOK.hemi, 'sky').name('天光色').onChange(changed);
  fAmb.addColor(LOOK.hemi, 'ground').name('地面反光色').onChange(changed);
  fAmb.add(LOOK.hemi, 'intensity', 0, 3, 0.05).name('強度').onChange(changed);
  fAmb.close();

  const fSky = gui.addFolder('天空與霧');
  fSky.addColor(LOOK.sky, 'top').name('天頂色').onChange(changed);
  fSky.addColor(LOOK.sky, 'mid').name('中段色').onChange(changed);
  fSky.addColor(LOOK.sky, 'horizon').name('地平線色').onChange(changed);
  fSky.addColor(LOOK.sky, 'sunGlow').name('日暈色').onChange(changed);
  fSky.addColor(LOOK.fog, 'color').name('霧色').onChange(changed);
  fSky.add(LOOK.fog, 'density', 0, 0.004, 0.00005).name('霧濃度').onChange(changed);
  fSky.close();

  const fPost = gui.addFolder('後製');
  fPost.add(LOOK.post, 'exposure', 0.3, 2, 0.01).name('曝光').onChange(changed);
  fPost.add(LOOK.post, 'bloomStrength', 0, 1.5, 0.01).name('光暈強度').onChange(changed);
  fPost.add(LOOK.post, 'bloomRadius', 0, 1.5, 0.01).name('光暈半徑').onChange(changed);
  fPost.add(LOOK.post, 'bloomThreshold', 0, 1.5, 0.01).name('光暈門檻').onChange(changed);
  fPost.add(LOOK.post, 'vignette', 0, 0.8, 0.01).name('暗角').onChange(changed);
  fPost.add(LOOK.post, 'saturation', 0.5, 1.6, 0.01).name('飽和度').onChange(changed);
  fPost.add(LOOK.post, 'contrast', 0.8, 1.4, 0.01).name('對比').onChange(changed);
  fPost.close();

  // ── 匯出／重設 ──
  const actions = {
    匯出: () => {
      const { auto, timeScale, ...tune } = TUNE;
      const json = JSON.stringify({ LOOK, SHOTS, LAYOUT, TUNE: tune, BATPOSE }, null, 2);
      console.log('[DEV 匯出]\n' + json);
      navigator.clipboard?.writeText(json).catch(() => {});
      showExport(json);
    },
    重設: () => {
      resetLook();
      resetTuning();
      gui.controllersRecursive().forEach((c) => c.updateDisplay());
      applyLook();
      applyLayout();
      select(null);
    },
  };
  gui.add(actions, '匯出').name('💾 匯出目前數值（複製到剪貼簿）');
  gui.add(actions, '重設').name('↺ 全部重設為預設值');

  const panel = document.getElementById('dev-export');
  const area = panel.querySelector('textarea');
  panel.querySelector('button').addEventListener('click', () => panel.classList.remove('show'));
  function showExport(json) {
    area.value = json;
    panel.classList.add('show');
    area.select();
  }

  function toggle() {
    open = !open;
    if (open) gui.show();
    else {
      gui.hide();
      layUi.drag = false;
      document.body.classList.remove('dev-drag');
      gui.controllersRecursive().forEach((c) => c.updateDisplay());
    }
    document.body.classList.toggle('dev-open', open);
  }
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
    if (e.key === 'd' || e.key === 'D') toggle();
  });
  // 畫面上不放 DEV 按鈕（會和其他按鈕擠在一起），只用 D 鍵開關

  // 網址加 ?pose：直接進比賽、打開面板與「打擊姿勢微調」、定格預備姿勢、切到打者斜後方鏡頭
  if (new URLSearchParams(location.search).has('pose')) {
    director.goLive(false);
    toggle();
    fBat.open();
    fGrip.open();
    fArm.open();
    fBody.open();
    BATPOSE.freeze = true;
    fBat.controllersRecursive().forEach((c) => c.updateDisplay());
    const wait = setInterval(() => {
      const b = game.debugBatter?.();
      if (!b) return;
      clearInterval(wait);
      b.set('stance'); // 直接擺出打擊預備姿勢
      batCam('video');
    }, 400);
  }
}
