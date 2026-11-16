import GUI from 'lil-gui';
import { LOOK, saveLook, resetLook } from './look.js';
import {
  LAYOUT, SHOTS, TUNE, saveTuning, resetTuning, applyLayout, layoutMode, setForcedMode,
} from './tuning.js';
import { SEGS } from './intro.js';

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
  fPlay.add(TUNE, 'innings', 1, 9, 1).name('局數').onChange(st);
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
      const json = JSON.stringify({ LOOK, SHOTS, LAYOUT, TUNE: tune }, null, 2);
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
  document.getElementById('dev-toggle').addEventListener('click', toggle);
}
