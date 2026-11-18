import * as THREE from 'three';
import { FIELD_Y } from './util.js';
import { TUNE, SHOTS } from './tuning.js';
import { PITCHES, GRADE_MUL } from './data.js';
import { makeActor, FIELD_POS, PITCH } from './player3d.js';
import { flight, fieldPlay, resolveOutcome, BASES, SIM_DT } from './ballsim.js';
import { sfx, sayParts, band } from './audio.js';
import { line } from './commentary.js';
import { createBasePicker } from './basepicker.js';

// 好球帶（相對場地高度，單位公尺）
const ZONE = { x: 0.27, y0: 0.48, y1: 1.08 };
const USER = 1; // 玩家操控主隊
const MOUND_Y = 0.26;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const gauss = () => {
  let u = 0;
  for (let i = 0; i < 6; i++) u += Math.random();
  return (u - 3) / Math.sqrt(0.5);
};
const power = (p) => clamp(0.88 + (p.ovr - 65) / 120 + p.hr / 100, 0.85, 1.12);
const outsideZone = (T) => {
  const dx = Math.max(0, Math.abs(T.x) - ZONE.x);
  const dy = Math.max(0, ZONE.y0 - T.y, T.y - ZONE.y1);
  return Math.hypot(dx, dy);
};

export function createGame({ scene, camera, canvas, data, hud, ui, scoreboard, director }) {
  const teams = [data.away, data.home];
  const root = new THREE.Group();
  root.position.y = FIELD_Y;
  scene.add(root);

  // ── 角色 ──
  const fielders = teams.map((team) => {
    const set = {};
    for (const [pos, [x, z]] of Object.entries(FIELD_POS)) {
      const info = pos === 'P' ? team.sp : team.lineup.find((p) => p.pos === pos);
      const hand = info.hand === '左投' ? -1 : 1;
      const a = makeActor({
        ...team.kit, skin: info.skin, hair: info.hair, no: info.no, name: info.name, look: info.look,
        glove: -hand, gear: pos === 'C' ? 'catcher' : null,
      });
      a.hand = hand;
      a.home = [x, z];
      a.posName = pos;
      a.info = info;
      root.add(a.group);
      set[pos] = a;
    }
    return set;
  });
  const ump = makeActor({ jersey: '#2a2f36', accent: '#15181c', pants: '#4a4f57', skin: '#c98f66', gear: 'ump' });
  ump.group.position.set(0, 0, 2.9);
  ump.group.rotation.y = Math.PI;
  ump.set('ready');
  root.add(ump.group);

  // 開場守備名牌用的位置（主隊守備）
  const anchors = {};
  for (const [pos, a] of Object.entries(fielders[USER])) {
    anchors[pos] = { pos: new THREE.Vector3(a.home[0], FIELD_Y + 2.0 + (pos === 'P' ? MOUND_Y : 0), a.home[1]), info: a.info };
  }

  // ── 球與好球帶標示 ──
  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(0.05, 16, 12),
    new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.5, emissive: '#ffffff', emissiveIntensity: 0.25 }),
  );
  ball.castShadow = true;
  ball.visible = false;
  root.add(ball);

  const flat = (color, opacity) =>
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, fog: false, toneMapped: false });
  const widgets = new THREE.Group();
  widgets.renderOrder = 10;
  root.add(widgets);
  const zc = (ZONE.y0 + ZONE.y1) / 2;
  {
    const pts = [];
    const seg = (x1, y1, x2, y2) => pts.push(x1, y1, 0, x2, y2, 0);
    seg(-ZONE.x, ZONE.y0, ZONE.x, ZONE.y0);
    seg(ZONE.x, ZONE.y0, ZONE.x, ZONE.y1);
    seg(ZONE.x, ZONE.y1, -ZONE.x, ZONE.y1);
    seg(-ZONE.x, ZONE.y1, -ZONE.x, ZONE.y0);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const frame = new THREE.LineSegments(
      g,
      new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.85, depthTest: false, fog: false, toneMapped: false }),
    );
    frame.renderOrder = 10;
    widgets.add(frame);
    const gp = [];
    for (const k of [1 / 3, 2 / 3]) {
      const x = lerp(-ZONE.x, ZONE.x, k);
      const y = lerp(ZONE.y0, ZONE.y1, k);
      gp.push(x, ZONE.y0, 0, x, ZONE.y1, 0, -ZONE.x, y, 0, ZONE.x, y, 0);
    }
    const g2 = new THREE.BufferGeometry();
    g2.setAttribute('position', new THREE.Float32BufferAttribute(gp, 3));
    const grid = new THREE.LineSegments(
      g2,
      new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.28, depthTest: false, fog: false, toneMapped: false }),
    );
    grid.renderOrder = 10;
    widgets.add(grid);
  }
  const mk = (geo, mat) => {
    const m = new THREE.Mesh(geo, mat);
    m.renderOrder = 11;
    widgets.add(m);
    return m;
  };
  const aimMark = mk(new THREE.RingGeometry(0.05, 0.064, 40), flat('#d8ff3e', 1));
  const aimDot = mk(new THREE.CircleGeometry(0.012, 16), flat('#d8ff3e', 1));
  const meterRing = mk(new THREE.RingGeometry(0.057, 0.066, 48), flat('#ffffff', 0.95));
  const pci = mk(new THREE.RingGeometry(0.93, 1, 56), flat('#d8ff3e', 0.95));
  const pciCore = mk(new THREE.RingGeometry(0.024, 0.034, 24), flat('#ffffff', 0.9));
  const ballMark = mk(new THREE.RingGeometry(0.036, 0.058, 40), flat('#ff7a4d', 0.98)); // 落點圈（加粗，會縮小）

  // ── 狀態 ──
  const S = {
    inning: 1, half: 0, outs: 0, balls: 0, strikes: 0,
    bases: [null, null, null],
    score: [0, 0], hits: [0, 0], lines: [[0], []],
    batIdx: [0, 0], pitchCount: [0, 0], over: false,
  };
  const today = new Map();
  const stat = (p) => today.get(p) || today.set(p, { ab: 0, h: 0 }).get(p);
  let phase = 'idle';
  let pt = 0;
  let gt = 0;
  let started = false;
  let paused = false;
  let timer = null;
  let camMode = 'plate';
  let batter = null;
  let batterInfo = null;
  let runners = []; // { actor, player, base }
  let plan = null;
  let pitch = null;
  let swing = null;
  let aiSwing = null;
  let play = null;
  let foul = null;
  let selPitch = 0;
  let released = false;
  let pitchBack = null; // 投手投完球後回投手板的狀態
  const SETTLE_T = 0.12;
  let lastPitch = '';
  const lastType = [null, null];
  const aim = { x: 0, y: zc };
  const look = new THREE.Vector3(0, 1, -20);
  let followFov = 42;

  const bat = () => S.half;
  const fld = () => 1 - S.half;
  const userBatting = () => S.half === USER && !TUNE.auto;
  const userPitching = () => S.half !== USER && !TUNE.auto;
  // 防守傳壘的浮動壘包（手機點、電腦按 1–4）
  const picker = createBasePicker({ camera, canvas, onPick: (n) => play && play.manual && play.pick && chooseBase(play, n) });
  const pitcher = () => fielders[fld()].P;
  const setPhase = (p) => {
    phase = p;
    pt = 0;
    if (p !== 'play' && typeof picker !== 'undefined') picker.hide(); // 換階段時收起浮動壘包
  };
  const schedule = (sec, fn) => {
    timer = { t: sec, fn };
  };

  // 應援熱度：得點圈有人、球數到關鍵、比賽後段、比數接近時，應援節奏加快、聲音變大
  function bandHeat() {
    let h = 0;
    if (S.bases[1] || S.bases[2]) h += 0.4;
    else if (S.bases[0]) h += 0.15;
    if (S.strikes === 2 || S.balls === 3) h += 0.2;
    if (S.inning >= TUNE.innings - 1) h += 0.2;
    if (Math.abs(S.score[0] - S.score[1]) <= 1) h += 0.2;
    band.heat(h);
  }

  function refresh() {
    bandHeat();
    hud.render({
      S, away: teams[0], home: teams[1],
      batter: batterInfo, batTeam: teams[bat()], order: S.batIdx[bat()] + 1,
      today: batterInfo ? stat(batterInfo) : null,
      pitcher: teams[fld()].sp, fldTeam: teams[fld()], pitchCount: S.pitchCount[fld()], lastPitch,
    });
    scoreboard.draw({ S, away: teams[0], home: teams[1], innings: TUNE.innings });
  }

  function resetField() {
    pitchBack = null;
    fielders.forEach((set, ti) => {
      for (const [pos, a] of Object.entries(set)) {
        a.group.visible = ti === fld();
        a.group.position.set(a.home[0], pos === 'P' ? MOUND_Y : 0, a.home[1]);
        if (pos === 'C') a.group.rotation.y = Math.PI;
        else a.face(0, 0);
        a.set(pos === 'P' ? 'idle' : pos === 'C' ? 'crouch' : 'ready');
      }
    });
    ball.visible = false;
    placeRunners();
  }

  function placeRunners() {
    for (const r of runners) {
      const [x, z] = BASES[r.base];
      r.actor.group.position.set(x, 0, z);
      r.actor.face(0, 0);
      r.actor.set('idle');
    }
  }

  function removeBatter() {
    if (batter) root.remove(batter.group);
    batter = null;
  }

  function spawnBatter() {
    removeBatter();
    const team = teams[bat()];
    const p = team.lineup[S.batIdx[bat()]];
    batterInfo = p;
    const side = p.bats === '左' ? -1 : 1;
    batter = makeActor({
      ...team.kit, skin: p.skin, hair: p.hair, no: p.no, name: p.name, look: p.look, bat: true, helmet: side,
    });
    batter.side = side;
    batter.group.position.set(-batter.side * 0.85, 0, 0.05); // 站近本壘板：球棒才掃得過整個本壘板
    batter.group.rotation.y = batter.side * (Math.PI / 2);
    batter.set('stance');
    root.add(batter.group);
  }

  // ── 打席流程 ──
  function beginPA() {
    S.balls = 0;
    S.strikes = 0;
    camMode = 'plate';
    spawnBatter();
    band.song(teams[bat()].cheer); // 進攻球隊的應援曲
    sayParts(line.batter(S.batIdx[bat()] + 1, batterInfo.pos, batterInfo.name), true);
    resetField();
    lastPitch = '';
    refresh();
    setPhase('pre');
    schedule(0.7, beginPitch);
  }

  function beginPitch() {
    swing = null;
    aiSwing = null;
    pitch = null;
    foul = null;
    play = null;
    camMode = 'plate';
    ball.visible = false;
    if (batter) batter.set('stance');
    pitcher().set('idle');
    const sp = teams[fld()].sp;
    if (userPitching()) {
      setPhase('select');
      ui.pitchMenu(sp.pitches, selPitch, sp.maxKmh);
      ui.hint(ui.touch ? '搖桿瞄準　點選球種　按「投球」，圈縮到剛好時再按一下' : '1–4 選球種　滑鼠瞄準　點擊投球，圈縮到剛好時再點一下');
      ui.batHelp(false);
    } else {
      plan = aiPlan(sp);
      ui.pitchMenu(null);
      ui.hint('');
      ui.batHelp(userBatting());
      setPhase('set');
      schedule(0.6 + Math.random() * 0.7, startWindup);
    }
  }

  function aiPlan(sp) {
    const w = sp.pitches.map((_, i) => (i === 0 ? 0.45 : 0.55 / (sp.pitches.length - 1)));
    let r = Math.random();
    let idx = 0;
    for (let i = 0; i < w.length; i++) {
      r -= w[i];
      if (r <= 0) {
        idx = i;
        break;
      }
    }
    const [name, g] = sp.pitches[idx];
    const def = PITCHES[name];
    let T;
    if (Math.random() < 0.62) {
      T = { x: (Math.random() * 2 - 1) * ZONE.x * 0.95, y: lerp(ZONE.y0, ZONE.y1, Math.random()) };
      if (def.by < -0.2) T.y = lerp(ZONE.y0, zc, Math.random());
    } else {
      const off = 0.06 + Math.random() * 0.18;
      const side = Math.floor(Math.random() * 4);
      T = { x: (Math.random() * 2 - 1) * ZONE.x, y: lerp(ZONE.y0, ZONE.y1, Math.random()) };
      if (side === 0) T.x = ZONE.x + off;
      else if (side === 1) T.x = -ZONE.x - off;
      else if (side === 2 || def.by < -0.2) T.y = ZONE.y0 - off;
      else T.y = ZONE.y1 + off;
    }
    const acc = 0.5 + Math.random() * 0.45;
    return finishPlan(sp, idx, T, acc);
  }

  function finishPlan(sp, idx, target, acc) {
    const [name, g] = sp.pitches[idx];
    const errMax = 0.34 - sp.control * 0.0022;
    const err = (1 - acc) * errMax + 0.015;
    const a = Math.random() * Math.PI * 2;
    return {
      idx, name, g, acc,
      T: { x: target.x + Math.cos(a) * err, y: target.y + Math.sin(a) * err },
      kmh: sp.maxKmh * PITCHES[name].speed * (0.95 + 0.03 * acc + Math.random() * 0.02),
    };
  }

  function startWindup() {
    setPhase('windup');
    released = false;
    ui.pitchMenu(null);
    S.pitchCount[fld()]++;
    // 上一球投完還沒走回投手板就要投下一球：直接站回去
    if (pitchBack) {
      const p = pitcher();
      p.group.position.x = p.home[0];
      p.group.position.z = p.home[1];
      p.face(0, 0);
      pitchBack = null;
    }
    pitcher().play('pitch', PITCH.dur, 'idle');
  }

  // 投手手上的球：掌心＝手腕骨和中指根部的中點（用兩根骨頭的實際位置算，不同身材的模型都對得上）。
  // 出手前球跟著手走，出手時從這裡飛出去
  const _wrist = new THREE.Vector3();
  const _knuckle = new THREE.Vector3();
  function pitcherBallPos() {
    const p = pitcher();
    if (!p) return null;
    const w = p.group.getObjectByName('mixamorigRightHand'); // 左投是整個模型鏡射，丟球的仍是這隻手
    const k = p.group.getObjectByName('mixamorigRightHandMiddle1');
    if (!w) return null;
    p.group.updateMatrixWorld(true);
    w.getWorldPosition(_wrist);
    if (k) _wrist.lerp(k.getWorldPosition(_knuckle), 0.6);
    // 球放在場地的群組裡（群組本身有墊高），要把世界座標換成球所在群組的座標，不然球會比手高一截
    if (ball.parent) ball.parent.worldToLocal(_wrist);
    return _wrist;
  }

  function release(from) {
    released = true;
    const hand = pitcher().hand;
    const def = PITCHES[plan.name];
    const mul = GRADE_MUL[plan.g] || 1;
    // 出手點＝這一刻手的實際位置（原本是寫死的固定點，球會憑空出現在手的旁邊）
    const hp = from || pitcherBallPos();
    const R = hp ? { x: hp.x, y: hp.y, z: hp.z } : { x: -0.3 * hand, y: MOUND_Y + 1.6, z: -18.44 + 0.9 };
    const B = { x: def.bx * hand * mul, y: def.by * mul };
    const T = plan.T;
    const d = Math.hypot(T.x - R.x, T.y - R.y, R.z);
    pitch = {
      R, B, T, A: { x: T.x - B.x, y: T.y - B.y },
      Tf: d / (plan.kmh / 3.6) / TUNE.speedScale,
      arc: (1 - def.speed) * 1.1 + 0.05,
      t: 0, resolved: false, swung: false,
    };
    pitch.arrive = gt + pitch.Tf; // 球到本壘的時間點
    setPhase('flight');
    ball.visible = true;
    ball.position.set(R.x, R.y, R.z); // 出手這一格球就在出手點（不要留在已經往回收的手上）
    if (!userBatting()) aiSwing = aiBat();
  }

  function aiBat() {
    const T = pitch.T;
    const dz = outsideZone(T);
    const inZone = dz === 0;
    const breaking = Math.abs(PITCHES[plan.name].by) > 0.2 || Math.abs(PITCHES[plan.name].bx) > 0.2;
    let pSwing = inZone ? 0.7 : Math.max(0.04, 0.46 - dz * 2.6 + (breaking ? 0.07 : 0));
    if (S.strikes === 2) pSwing += inZone ? 0.22 : 0.12;
    if (S.balls === 3 && S.strikes < 2 && !inZone) pSwing *= 0.5;
    if (Math.random() >= pSwing) return { type: 'take' };
    const skill = clamp((batterInfo.ovr - 55) / 40, 0.1, 0.8);
    const c = inZone ? 1 - Math.max(Math.abs(T.x) / ZONE.x, Math.abs(T.y - zc) / ((ZONE.y1 - ZONE.y0) / 2)) : 0;
    const repeat = lastType[fld()] === plan.name;
    const pContact = clamp(0.57 + 0.26 * skill + 0.12 * c - dz * 1.6 - 0.1 * plan.acc + (repeat ? 0.08 : 0), 0.08, 0.92);
    if (Math.random() >= pContact) return { type: 'whiff' };
    if (Math.random() < 0.24) return { type: 'foul' };
    const q = clamp(0.12 + Math.random() * 0.8 + 0.3 * skill + 0.15 * c - 0.12 * plan.acc + (repeat ? 0.1 : 0), 0.05, 1);
    const spray = -6 * batter.side + gauss() * 23;
    if (Math.abs(spray) > 45) return { type: 'foul' };
    return { type: 'contact', ev: ((88 + 80 * q) * power(batterInfo)) / 3.6, la: clamp(11 + gauss() * 19, -28, 62), spray, q };
  }

  // 揮棒後告訴玩家偏在哪裡：時機（太早／太晚）與位置（偏高／偏低／偏左／偏右）
  function swingFeedback(dt, dx, dy) {
    const tm = Math.abs(dt) <= TUNE.timing * 0.35 ? '時機剛好' : dt < 0 ? '揮得太早' : '揮得太晚';
    const far = Math.hypot(dx, dy);
    let where = '位置對準';
    if (far > TUNE.pci * 0.45) where = Math.abs(dy) >= Math.abs(dx) ? (dy > 0 ? '瞄得太高' : '瞄得太低') : dx > 0 ? '瞄得偏右' : '瞄得偏左';
    const good = tm === '時機剛好' && where === '位置對準';
    ui.feedback(good ? '完美擊球！' : `${tm}　${where}`, good ? 'good' : 'bad');
  }

  // 揮棒時機：球到本壘前 LEAD 秒按下最準；球到了才按也來得及（GRACE 秒內都算，只是偏晚）
  const LEAD = 0.07;
  const GRACE = 0.08;
  function userSwingResult() {
    if (!swing) return { type: 'take' };
    const T = pitch.T;
    const dt = swing.at + LEAD - pitch.arrive;
    swingFeedback(dt, swing.x - T.x, swing.y - T.y);
    if (Math.abs(dt) > TUNE.timing * 1.35) return { type: 'whiff' };
    // 瞄準輔助：球棒會自動往球的方向靠過去一部分（1＝完全自動對準，0＝完全靠自己瞄）
    const d = Math.hypot(swing.x - T.x, swing.y - T.y) * (1 - TUNE.aimAssist);
    const lim = TUNE.pci * 1.9; // 瞄準圈放在好球帶中央時，大部分好球都碰得到，只是越偏打得越不紮實
    if (d > lim) return { type: 'whiff' };
    const q = clamp((1 - d / lim) * (1 - (0.5 * Math.abs(dt)) / TUNE.timing) * 1.2, 0, 1);
    if (q < 0.16) return { type: 'foul' };
    const spray = (dt / TUNE.timing) * 50 * batter.side + gauss() * 5;
    if (Math.abs(spray) > 45) return { type: 'foul' };
    return {
      type: 'contact', q, spray,
      ev: ((88 + 80 * q) * power(batterInfo)) / 3.6,
      la: clamp(13 + (T.y - swing.y) * (1 - TUNE.aimAssist) * 190 + gauss() * 6, -28, 62),
    };
  }

  function resolvePitch() {
    pitch.resolved = true;
    lastType[fld()] = plan.name;
    lastPitch = `${plan.name} ${Math.round(plan.kmh)} km/h`;
    ui.pitchInfo(lastPitch);
    const res = userBatting() ? userSwingResult() : aiSwing;
    if (res.type === 'take') callPitch(outsideZone(pitch.T) <= 0.04 ? 'strike' : 'ball');
    else if (res.type === 'whiff') callPitch('swing');
    else if (res.type === 'foul') foulBall();
    else startPlay(res);
  }

  function callPitch(kind) {
    setPhase('call');
    if (kind === 'ball') S.balls++;
    else S.strikes++;
    const k = S.strikes >= 3;
    const bb = S.balls >= 4;
    ui.call(k ? '三振' : bb ? '保送' : kind === 'ball' ? '壞球' : kind === 'swing' ? '揮棒落空' : '好球', kind);
    if (!k && !bb) sayParts(kind === 'ball' ? line.ball() : kind === 'swing' ? line.swing() : line.strike());
    sfx.call(kind !== 'ball');
    refresh();
    schedule(1.1, () => {
      if (k) strikeout();
      else if (bb) walk();
      else beginPitch();
    });
  }

  function foulBall() {
    if (S.strikes < 2) S.strikes++;
    sfx.hit(0.3);
    ui.call('界外球', 'foul');
    sayParts(line.foul());
    foul = flight(26 + Math.random() * 10, 20 + Math.random() * 30, (Math.random() < 0.5 ? -1 : 1) * (58 + Math.random() * 25));
    setPhase('foul');
    refresh();
    schedule(1.1, beginPitch);
  }

  function strikeout() {
    S.outs++;
    stat(batterInfo).ab++;
    removeBatter();
    ui.banner({ kicker: `${batterInfo.name}`, title: '三振出局', sub: `${S.outs} 出局` }, 1.6);
    sayParts(line.strikeout(batterInfo.name, S.outs), true);
    endPA(1.6);
  }

  function walk() {
    // 被擠壘的跑者依序前進
    let runs = 0;
    const b = S.bases;
    if (b[0]) {
      if (b[1]) {
        if (b[2]) {
          runs++;
          removeRunner(b[2]);
        }
        b[2] = b[1];
      }
      b[1] = b[0];
    }
    b[0] = batterInfo;
    batter.rig.bat.visible = false;
    runners.push({ actor: batter, player: batterInfo, base: 1 });
    batter = null;
    for (const r of runners) r.base = b.indexOf(r.player) + 1;
    if (runs) addRuns(runs);
    ui.dip();
    placeRunners();
    ui.banner({ kicker: batterInfo.name, title: '四壞球保送', sub: runs ? `擠回 ${runs} 分` : '' }, 1.6);
    sayParts(line.walk(runs), true);
    endPA(1.6);
  }

  function removeRunner(player) {
    const i = runners.findIndex((r) => r.player === player);
    if (i >= 0) {
      root.remove(runners[i].actor.group);
      runners.splice(i, 1);
    }
  }

  function addRuns(n) {
    S.score[bat()] += n;
    S.lines[bat()][S.inning - 1] = (S.lines[bat()][S.inning - 1] || 0) + n;
  }

  function endPA(delay) {
    S.batIdx[bat()] = (S.batIdx[bat()] + 1) % 9;
    refresh();
    setPhase('post');
    schedule(delay, () => {
      const walkOff = S.half === 1 && S.inning >= TUNE.innings && S.score[1] > S.score[0];
      if (walkOff) gameOver();
      else if (S.outs >= 3) switchHalf();
      else {
        ui.dip();
        beginPA();
      }
    });
  }

  // ── 攻守交替：守備的那一隊跑回休息區，另一隊從休息區跑上場就定位 ──
  const DUG = [[-19.3, 2.0], [19.3, 2.0]]; // 休息區前方：客隊在三壘側、主隊在一壘側
  const SWAP_T = 6.5;
  let swap = null;
  function startSwap(outTeam) {
    const list = [];
    for (const team of [0, 1]) {
      const [dx, dz] = DUG[team];
      const sx = Math.sign(dx);
      Object.entries(fielders[team]).forEach(([pos, a], i) => {
        // 休息區前一字排開（沿著休息區的方向錯開）
        const k = (i - 4) * 1.5;
        const spot = [dx + sx * 0.707 * k, 0, dz - 0.707 * k];
        const home = [a.home[0], pos === 'P' ? MOUND_Y : 0, a.home[1]];
        const leaving = team === outTeam;
        const from = leaving ? [a.group.position.x, a.group.position.y, a.group.position.z] : spot;
        const to = leaving ? spot : home;
        a.group.visible = true;
        a.group.position.set(from[0], from[1], from[2]);
        a.face(to[0], to[2]);
        a.set('run');
        // 下場的先動，上場的晚一點出發；離得遠的外野手早一點起跑
        list.push({ a, pos, from, to, leaving, delay: leaving ? i * 0.05 : 0.9 + i * 0.06, done: false });
      });
    }
    swap = { t: 0, list };
    camMode = 'follow';
    ball.visible = false;
  }
  function updateSwap(dt) {
    swap.t += dt;
    for (const m of swap.list) {
      if (m.done) continue;
      const k = clamp((swap.t - m.delay) / (SWAP_T - 1.3 - m.delay), 0, 1);
      const e = k * k * (3 - 2 * k);
      m.a.group.position.set(lerp(m.from[0], m.to[0], e), lerp(m.from[1], m.to[1], e), lerp(m.from[2], m.to[2], e));
      if (k >= 1) {
        m.done = true;
        if (m.leaving) m.a.group.visible = false;
        else {
          if (m.pos === 'C') m.a.group.rotation.y = Math.PI;
          else m.a.face(0, 0);
          m.a.set(m.pos === 'P' ? 'idle' : m.pos === 'C' ? 'crouch' : 'ready');
        }
      }
    }
    if (swap.t >= SWAP_T) {
      swap = null;
      resetField();
      beginPA();
    }
  }

  function switchHalf() {
    const outTeam = fld(); // 這半局守備的隊伍，等一下要跑下場
    runners.forEach((r) => root.remove(r.actor.group));
    runners = [];
    removeBatter();
    S.outs = 0;
    S.balls = 0;
    S.strikes = 0;
    S.bases = [null, null, null];
    const N = TUNE.innings;
    let extraStart = false; // 這次換局是不是剛進入延長賽
    if (S.half === 0) {
      if (S.inning >= N && S.score[1] > S.score[0]) return gameOver();
      S.half = 1;
    } else {
      // 打滿規定局數：分出勝負就結束；平手進延長賽，延長局數用完仍平手才以和局收場
      if (S.inning >= N && S.score[0] !== S.score[1]) return gameOver();
      if (S.inning >= N + TUNE.extra) return gameOver();
      S.half = 0;
      S.inning++;
      extraStart = S.inning === N + 1;
    }
    S.lines[S.half][S.inning - 1] = 0;
    batterInfo = null;
    startSwap(outTeam);
    ui.pitchMenu(null);
    ui.hint('');
    refresh();
    const extra = S.inning > N;
    ui.banner({ kicker: extra ? '延長賽' : '攻守交替', title: `${S.inning} 局${S.half ? '下' : '上'}`, sub: extraStart ? `雙方 ${S.score[0]}：${S.score[1]} 平手，比賽繼續` : `${teams[bat()].name} 進攻` }, extraStart ? 3.2 : 2.2);
    sayParts(line.change(S.inning, S.half, teams[bat()].name, extraStart), true);
    setPhase('switch'); // 兩隊跑完位置後由 updateSwap 開始下一個打席
  }

  function gameOver() {
    S.over = true;
    S.regulation = TUNE.innings;
    removeBatter();
    batterInfo = null;
    setPhase('over');
    camMode = 'follow';
    ball.visible = false;
    ui.pitchMenu(null);
    ui.hint('');
    refresh();
    sfx.cheer(0.5);
    ui.final({ S, away: teams[0], home: teams[1] });
    sayParts(line.gameOver(S.score[0] === S.score[1] ? null : teams[S.score[0] > S.score[1] ? 0 : 1].name), true);
  }

  // ── 擊出後的攻防 ──
  function startPlay(res) {
    setPhase('play');
    camMode = 'follow';
    sfx.hit(res.q ?? 0.7);
    ui.hint('');
    const fl = flight(res.ev, res.la, res.spray);
    const set = fielders[fld()];
    const list = Object.values(set).map((a) => ({ pos: a.posName, x: a.home[0], z: a.home[1] }));
    const fp = fl.hr || fl.grd ? null : fieldPlay(fl, list);
    const out = resolveOutcome(fl, fp, { outs: S.outs, on: S.bases.map(Boolean) }, res.la);
    const on = S.bases.map(Boolean);
    // 我方防守、球被接住或撿起：改成玩家選壘傳球，傳到了才判定出局（一壘手自己踩壘的滾地球照舊）
    if (userPitching() && fp && !(out.kind === 'GROUND' && out.own)) return startManualPlay(res, fl, fp, out, set);

    // 跑者與打者的進壘計畫
    const movers = [];
    const mv = (actor, player, from, to, o = {}) => movers.push({ actor, player, from, to, start: 0, ...o });
    let outsAdd = 0;
    if (out.kind === 'HR') {
      mv(batter, batterInfo, 0, 4);
      runners.forEach((r) => mv(r.actor, r.player, r.base, 4));
    } else if (out.kind === 'HIT') {
      mv(batter, batterInfo, 0, out.bases);
      for (const r of runners) {
        const extra = out.outfield && ((out.bases === 1 && r.base >= 2) || (out.bases === 2 && r.base >= 1)) && (S.outs === 2 || Math.random() < 0.55);
        mv(r.actor, r.player, r.base, Math.min(4, r.base + out.bases + (extra ? 1 : 0)));
      }
    } else if (out.kind === 'GROUND' || out.kind === 'DP') {
      outsAdd = out.kind === 'DP' ? 2 : 1;
      mv(batter, batterInfo, 0, 1, { out: true });
      for (const r of runners) {
        const forced = r.base === 1 || (r.base === 2 && on[0]) || (r.base === 3 && on[0] && on[1]);
        if (out.kind === 'DP' && r.base === 1) mv(r.actor, r.player, 1, 2, { out: true });
        else if (forced) mv(r.actor, r.player, r.base, r.base + 1);
      }
    } else {
      outsAdd = 1;
      mv(batter, batterInfo, 0, 1, { out: true });
      if (out.sac) {
        const r = runners.find((x) => x.base === 3);
        if (r) mv(r.actor, r.player, 3, 4, { start: fp.t + 0.1 });
      }
    }
    const inningOver = S.outs + outsAdd >= 3;

    // 傳球與補位
    const throws = [];
    const covers = [];
    const cover = (pos, base, by) => {
      if (set[pos] && pos !== fp.who) covers.push({ actor: set[pos], base, by });
    };
    let tEnd;
    if (out.kind === 'HR') tEnd = Math.min(7.5, fl.path[fl.path.length - 1].t + 1.5);
    else if (!fp) tEnd = fl.path[fl.path.length - 1].t + 1.2;
    else if (out.kind === 'FLY') tEnd = fp.t + 1.0;
    else if (out.kind === 'GROUND') {
      if (!out.own) {
        throws.push({ t0: Math.max(fp.t + 0.3, out.tFirst - 0.9), t1: out.tFirst, to: BASES[1] });
        cover('1B', 1, fp.t);
      }
      tEnd = out.tFirst + 0.8;
    } else if (out.kind === 'DP') {
      throws.push({ t0: fp.t + 0.3, t1: out.tSecond, to: BASES[2] });
      throws.push({ t0: out.tSecond + 0.3, t1: out.tFirst, to: BASES[1] });
      cover(fp.who === 'SS' ? '2B' : 'SS', 2, out.tSecond - 0.1);
      cover('1B', 1, out.tSecond);
      tEnd = out.tFirst + 0.8;
    } else {
      const tb = Math.min(3, out.bases + 1);
      const d = Math.hypot(fp.point.x - BASES[tb][0], fp.point.z - BASES[tb][1]);
      const t1 = fp.t + 0.7 + d / 35;
      throws.push({ t0: fp.t + 0.6, t1, to: BASES[tb] });
      cover(tb === 3 ? '3B' : fp.who === 'SS' ? '2B' : 'SS', tb, fp.t + 0.6);
      const legs = (m) => m.start + (m.from === 0 ? 4.3 : 3.9) + Math.max(0, m.to - m.from - 1) * 3.9;
      tEnd = Math.min(13, Math.max(t1, ...movers.map(legs)) + 0.5);
    }

    if (batter) batter.rig.bat.visible = false;
    play = {
      fl, fp, out, res, movers, throws, covers, outsAdd, inningOver, tEnd, t: 0,
      fielder: fp ? set[fp.who] : null, popped: false, thrown: 0,
    };
  }

  // ── 玩家選壘傳球 ──
  // 跑者 m 跑到第 B 個壘包（4＝本壘）的時間
  function arriveAt(m, B) {
    return m.start + (m.from === 0 ? 4.3 : 3.9) + Math.max(0, B - m.from - 1) * 3.9;
  }
  // 現在從持球的位置傳到 B 壘，會不會比跑者先到（回傳那位跑者，沒機會則 null）
  function outChance(p, B) {
    const m = p.movers.find((x) => !x.out && x.from < B && B <= x.to && arriveAt(x, B) > p.t);
    if (!m) return null;
    const [bx, bz] = BASES[B % 4];
    const t1 = p.t + 0.25 + Math.hypot(bx - p.holder.x, bz - p.holder.z) / TUNE.throwSpeed;
    return t1 + 0.05 < arriveAt(m, B) ? m : null;
  }
  function stillRunning(p) {
    return p.movers.some((m) => !m.out && arriveAt(m, m.to) > p.t);
  }
  function startManualPlay(res, fl, fp, out, set) {
    const movers = [];
    const mv = (actor, player, from, to, o = {}) => movers.push({ actor, player, from, to, start: 0, ...o });
    const on = S.bases.map(Boolean);
    let outsAdd = 0;
    if (out.kind === 'FLY') {
      outsAdd = 1;
      mv(batter, batterInfo, 0, 1, { out: true });
      if (out.sac) {
        const r = runners.find((x) => x.base === 3);
        if (r) mv(r.actor, r.player, 3, 4, { start: fp.t + 0.1, tagUp: true });
      }
    } else if (out.kind === 'HIT') {
      mv(batter, batterInfo, 0, out.bases);
      for (const r of runners) {
        const extra = out.outfield && ((out.bases === 1 && r.base >= 2) || (out.bases === 2 && r.base >= 1)) && (S.outs === 2 || Math.random() < 0.55);
        mv(r.actor, r.player, r.base, Math.min(4, r.base + out.bases + (extra ? 1 : 0)));
      }
    } else {
      // 滾地球：打者跑一壘、被迫進壘的跑者往前一個壘，誰出局看玩家傳哪一壘
      mv(batter, batterInfo, 0, 1);
      for (const r of runners) {
        const forced = r.base === 1 || (r.base === 2 && on[0]) || (r.base === 3 && on[0] && on[1]);
        if (forced) mv(r.actor, r.player, r.base, r.base + 1);
      }
    }
    if (batter) batter.rig.bat.visible = false;
    play = {
      manual: true, set, fl, fp, out, res, movers, throws: [], covers: [], outsAdd, inningOver: S.outs + outsAdd >= 3,
      tEnd: Math.max(fp.t + 1.2, ...movers.filter((m) => !m.out).map((m) => arriveAt(m, m.to) + 0.6)),
      t: 0, fielder: set[fp.who], thrower: set[fp.who], popped: false, thrown: 0,
      holder: { x: fp.point.x, z: fp.point.z }, pick: null, flying: null, noMore: false,
    };
  }
  function openPick(p) {
    const hints = {};
    for (const B of [1, 2, 3, 4]) hints[B] = !!outChance(p, B);
    p.pick = { real: 0, hints };
    picker.show(hints);
  }
  // 時間到沒選：傳到能讓最前面跑者出局的壘包；都沒機會就不傳
  function autoBase(p) {
    for (const B of [4, 3, 2, 1]) if (outChance(p, B)) return B;
    return 0;
  }
  function coverActor(p, B) {
    let pos = B === 1 ? '1B' : B === 2 ? (p.fp.who === 'SS' ? '2B' : 'SS') : B === 3 ? '3B' : 'C';
    if (p.set[pos] === p.thrower) pos = B === 2 ? '2B' : 'P';
    return p.set[pos];
  }
  function chooseBase(p, B) {
    picker.hide();
    p.pick = null;
    if (!B) {
      p.noMore = true; // 不傳：把球帶回內野
      return;
    }
    const [bx, bz] = BASES[B % 4];
    const t0 = p.t + 0.25;
    const t1 = t0 + Math.hypot(bx - p.holder.x, bz - p.holder.z) / TUNE.throwSpeed;
    p.flying = { B, t0, t1, from: { ...p.holder }, to: [bx, bz] };
    p.thrower.face(bx, bz);
    p.thrower.play('throw', 0.3, 'ready');
    const c = coverActor(p, B);
    if (c && !p.covers.some((x) => x.actor === c)) p.covers.push({ actor: c, base: B % 4, by: t1 - 0.05, t0: p.t });
    p.catcherAt = c;
    p.tEnd = Math.max(p.tEnd, t1 + 1.0);
  }
  const BASE_NAME = { 1: '一壘', 2: '二壘', 3: '三壘', 4: '本壘' };
  function resolveThrow(p, th) {
    p.holder = { x: th.to[0], z: th.to[1] };
    if (p.catcherAt) p.thrower = p.catcherAt;
    const m = p.movers.find((x) => !x.out && x.from < th.B && th.B <= x.to);
    if (!m) return;
    if (arriveAt(m, th.B) > th.t1 - 0.02) {
      m.out = true;
      m.to = th.B; // 停在那個壘包
      m.outAt = p.t;
      p.outsAdd++;
      if (m.tagUp) p.out.sac = false;
      ui.call(`${BASE_NAME[th.B]}出局`, 'strike');
      sfx.pop();
      if (S.outs + p.outsAdd >= 3) {
        p.inningOver = true;
        p.noMore = true;
        p.tEnd = Math.min(p.tEnd, p.t + 1.4);
      }
    } else ui.call('安全上壘', 'ball');
  }
  function manualBall(p, t, rdt) {
    const { fl, fp } = p;
    if (t < fp.t) {
      const s = fl.path[Math.min(fl.path.length - 1, Math.floor(t / SIM_DT))];
      ball.position.set(s.x, s.y + 0.05, s.z);
      return;
    }
    if (!p.popped) {
      p.popped = true;
      sfx.pop();
      if (fp.caught) p.fielder.set('catchUp');
    }
    const th = p.flying;
    if (th && t >= th.t1) {
      p.flying = null;
      resolveThrow(p, th);
    }
    if (p.flying && t >= p.flying.t0) {
      const f = p.flying;
      const k = (t - f.t0) / (f.t1 - f.t0);
      const d = Math.hypot(f.to[0] - f.from.x, f.to[1] - f.from.z);
      ball.position.set(lerp(f.from.x, f.to[0], k), 1.0 + Math.sin(k * Math.PI) * Math.min(2.2, d * 0.05), lerp(f.from.z, f.to[1], k));
    } else ball.position.set(p.holder.x, 1.0, p.holder.z);
    // 球在手上、還有跑者在跑：開放選壘（慢動作），時間到自動傳
    if (!p.flying && !p.pick && !p.noMore && t >= fp.t + 0.12 && stillRunning(p) && S.outs + p.outsAdd < 3) openPick(p);
    if (p.pick) {
      p.pick.real += rdt;
      // 每一幀重算：跑者越來越接近，綠色提示要即時反映「現在傳還來不來得及」
      const hints = {};
      for (const B of [1, 2, 3, 4]) hints[B] = !!outChance(p, B);
      picker.hints(hints);
      picker.update(1 - p.pick.real / TUNE.pickWindow);
      if (p.pick.real >= TUNE.pickWindow) chooseBase(p, autoBase(p));
    }
  }

  function moverPos(m, t) {
    let rem = t - m.start;
    let cur = m.p0;
    if (rem <= 0) return { x: cur[0], z: cur[1], moving: false };
    for (let b = m.from; b < m.to; b++) {
      const nxt = BASES[(b + 1) % 4];
      const lt = b === 0 ? 4.3 : 3.9;
      if (rem < lt) {
        const k = rem / lt;
        return { x: lerp(cur[0], nxt[0], k), z: lerp(cur[1], nxt[1], k), moving: true, nx: nxt[0], nz: nxt[1] };
      }
      rem -= lt;
      cur = nxt;
    }
    return { x: cur[0], z: cur[1], moving: false };
  }

  function updatePlay(dt) {
    const p = play;
    const rdt = dt;
    if (p.manual && p.pick) dt *= TUNE.slowMo; // 選壘時慢動作
    p.t += dt;
    const t = p.t;
    const { fl, fp } = p;

    // 球
    if (p.manual) manualBall(p, t, rdt);
    else {
    const sample = (tt) => fl.path[Math.min(fl.path.length - 1, Math.floor(tt / SIM_DT))];
    if (!fp || t < fp.t) {
      const s = sample(t);
      ball.position.set(s.x, s.y + 0.05, s.z);
    } else {
      if (!p.popped) {
        p.popped = true;
        sfx.pop();
        if (fp.caught) p.fielder.set('catchUp');
      }
      let from = { x: fp.point.x, z: fp.point.z };
      let pos = { x: from.x, y: 1.0, z: from.z };
      for (const th of p.throws) {
        if (t >= th.t1) {
          from = { x: th.to[0], z: th.to[1] };
          pos = { x: from.x, y: 1.0, z: from.z };
        } else if (t >= th.t0) {
          const k = (t - th.t0) / (th.t1 - th.t0);
          const d = Math.hypot(th.to[0] - from.x, th.to[1] - from.z);
          pos = { x: lerp(from.x, th.to[0], k), y: 1.0 + Math.sin(k * Math.PI) * Math.min(2.2, d * 0.05), z: lerp(from.z, th.to[1], k) };
          break;
        } else break;
      }
      // 自己踩壘：球跟著守備員
      if (p.out.kind === 'GROUND' && p.out.own) {
        pos = { x: p.fielder.group.position.x, y: 1.0, z: p.fielder.group.position.z };
      }
      ball.position.set(pos.x, pos.y, pos.z);
      if (p.thrown < p.throws.length && t >= p.throws[p.thrown].t0) {
        if (p.thrown === 0) p.fielder.play('throw', 0.3, 'ready');
        p.thrown++;
      }
    }
    }

    // 接球的守備員
    if (fp) {
      const f = p.fielder;
      const h = f.home;
      if (t < fp.react) f.set('ready');
      else if (t < fp.t) {
        const k = (t - fp.react) / Math.max(0.01, fp.t - fp.react);
        f.group.position.x = lerp(h[0], fp.point.x, k);
        f.group.position.z = lerp(h[1], fp.point.z, k);
        f.group.position.y = lerp(f.group.position.y, 0, 0.2);
        f.face(fp.point.x, fp.point.z);
        f.set('run');
      } else if (p.out.kind === 'GROUND' && p.out.own && t < p.out.tFirst) {
        const k = (t - fp.t) / (p.out.tFirst - fp.t);
        f.group.position.x = lerp(fp.point.x, BASES[1][0], k);
        f.group.position.z = lerp(fp.point.z, BASES[1][1], k);
        f.face(BASES[1][0], BASES[1][1]);
        f.set('run');
      } else if (!f.dur && f.pose === 'run') f.set('ready');
    }
    // 補位的守備員
    for (const c of p.covers) {
      const h = c.actor.home;
      const b = BASES[c.base];
      const t0 = c.t0 ?? 0.3;
      const k = clamp((t - t0) / Math.max(0.3, c.by - t0), 0, 1);
      c.actor.group.position.x = lerp(h[0], b[0], k);
      c.actor.group.position.z = lerp(h[1], b[1], k);
      if (k < 1) {
        c.actor.face(b[0], b[1]);
        c.actor.set('run');
      } else {
        c.actor.face(ball.position.x, ball.position.z);
        c.actor.set('ready');
      }
    }
    // 跑者
    for (const m of p.movers) {
      if (!m.p0) m.p0 = m.from === 0 ? [m.actor.group.position.x, m.actor.group.position.z] : BASES[m.from];
      const q = moverPos(m, t);
      m.actor.group.position.x = q.x;
      m.actor.group.position.z = q.z;
      if (q.moving) {
        m.actor.group.rotation.y = Math.atan2(q.nx - q.x, q.nz - q.z);
        m.actor.set('run');
      } else if (t > m.start) m.actor.set('idle');
    }

    if (t >= p.tEnd && !(p.manual && (p.pick || p.flying))) finishPlay();
  }

  function finishPlay() {
    const p = play;
    const { out } = p;
    picker.hide();
    if (p.manual) {
      // 玩家選壘後的實際結果
      const bOut = p.movers.some((m) => m.player === batterInfo && m.out);
      if (out.kind === 'GROUND' || out.kind === 'DP') {
        if (bOut) {
          out.kind = p.outsAdd >= 2 ? 'DP' : 'GROUND';
          out.text = p.outsAdd >= 2 ? '雙殺打' : '滾地球出局';
        } else if (p.outsAdd) {
          out.kind = 'GROUND';
          out.text = p.outsAdd >= 2 ? '野手選擇・雙殺' : '野手選擇';
        } else {
          out.kind = 'HIT';
          out.bases = 1;
          out.text = '內野安打';
        }
      } else if (out.kind === 'FLY' && p.outsAdd >= 2) out.text += '・雙殺';
      else if (out.kind === 'HIT' && p.outsAdd) out.text += '（跑者出局）';
    }
    let runs = 0;
    const b = [null, null, null];
    const next = [];
    for (const r of runners) {
      if (!p.movers.some((m) => m.player === r.player)) {
        b[r.base - 1] = r.player;
        next.push(r);
      }
    }
    for (const m of p.movers) {
      if (m.out) root.remove(m.actor.group);
      else if (m.to >= 4) {
        if (!p.inningOver) runs++;
        root.remove(m.actor.group);
      } else {
        b[m.to - 1] = m.player;
        next.push({ actor: m.actor, player: m.player, base: m.to });
      }
    }
    runners = next;
    batter = null;
    S.bases = b;
    S.outs += p.outsAdd;
    const s = stat(batterInfo);
    if (!out.sac) s.ab++;
    if (out.kind === 'HIT' || out.kind === 'HR') {
      s.h++;
      S.hits[bat()]++;
    }
    if (runs) addRuns(runs);
    const good = out.kind === 'HIT' || out.kind === 'HR';
    sfx.cheer(out.kind === 'HR' ? 1 : good ? 0.6 : 0.3);
    if (good) band.burst(out.kind === 'HR');
    const subs = [];
    if (out.kind === 'HR') subs.push(`飛行距離 ${Math.round(p.fl.dist)} 公尺`);
    if (runs) subs.push(`${runs} 分打點`);
    if (p.outsAdd) subs.push(`${Math.min(3, S.outs)} 出局`);
    ui.banner({ kicker: batterInfo.name, title: out.sac ? '高飛犧牲打' : out.text, sub: subs.join('　'), good }, 2.0);
    sayParts(line.result(batterInfo.name, out.sac ? '高飛犧牲打' : out.text, good, runs, p.outsAdd, S.outs), true);
    play = null;
    endPA(2.0);
  }

  // ── 鏡頭 ──
  const vT = new THREE.Vector3();
  function liveCam(dt) {
    camera.clearViewOffset();
    const portrait = camera.aspect < 1;
    if (camMode === 'plate') {
      const s = SHOTS.live.from;
      camera.position.fromArray(s.pos);
      vT.fromArray(s.target);
      camera.lookAt(vT);
      camera.fov = s.fov * (portrait ? 1.15 : 1);
      look.set(0, 1, -18);
      followFov = 44;
    } else {
      camera.position.set(0, 10.4, 27.4);
      const bx = ball.visible ? ball.position.x : 0;
      const by = ball.visible ? ball.position.y : 1;
      const bz = ball.visible ? ball.position.z : -18;
      vT.set(bx, Math.max(1, by * 0.75) + FIELD_Y, bz);
      look.lerp(vT, 1 - Math.pow(0.001, dt));
      camera.lookAt(look);
      const d = Math.hypot(look.x, look.z - 27.4);
      const want = clamp(50 - d * 0.27, 17, 46);
      followFov = lerp(followFov, want, 1 - Math.pow(0.02, dt));
      camera.fov = followFov * (portrait ? 1.3 : 1);
    }
    camera.updateProjectionMatrix();
  }

  // ── 輸入 ──
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  const hit = new THREE.Vector3();
  const active = () => started && !paused && director.state.mode === 'live' && !director.state.free;

  function pointerToAim(e) {
    if (camMode !== 'plate') return;
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    if (!ray.ray.intersectPlane(plane, hit)) return;
    aim.x = clamp(hit.x, -0.62, 0.62);
    aim.y = clamp(hit.y - FIELD_Y, 0.18, 1.45);
  }

  function action() {
    if (!active()) return;
    if (phase === 'select') setPhase('meter');
    else if (phase === 'meter') throwWithMeter();
    else if (userBatting() && !swing && batter) {
      // 投手還沒出手、或球剛離手還很遠：當成練習揮棒，只做動作、不算好球
      const practice = phase !== 'flight' || !pitch || pitch.t < pitch.Tf * 0.4;
      if (practice) {
        if (['select', 'meter', 'set', 'windup', 'flight'].includes(phase) && batter.pose !== 'swing') {
          batter.aimY = aim.y;
          batter.play('swing', 0.34, 'stance');
          sfx.swing();
        }
        return;
      }
      swing = { at: gt, x: aim.x, y: aim.y };
      batter.aimY = aim.y; // 揮棒高度跟著瞄準點：低球壓低、高球揮高
      batter.play('swing', 0.34, 'stance');
      sfx.swing();
    }
  }
  const meterScale = () => 3.2 - 2.8 * pt;
  function throwWithMeter(acc) {
    const a = acc ?? 1 - Math.min(1, Math.abs(meterScale() - 1) / 1.2);
    plan = finishPlan(teams[fld()].sp, selPitch, { x: aim.x, y: aim.y }, a);
    ui.hint('');
    startWindup();
  }

  // 觸控操作：瞄準用搖桿、動作用主按鈕，點畫面不會投球或揮棒（手指不用伸到好球帶上）
  ui.onMainPress(action);
  canvas.addEventListener('pointermove', (e) => active() && !ui.touch && pointerToAim(e));
  canvas.addEventListener('pointerdown', (e) => {
    if (!active() || ui.touch) return;
    if (phase !== 'meter') pointerToAim(e);
    action();
  });
  window.addEventListener('keydown', (e) => {
    if (!active() || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === ' ') {
      e.preventDefault();
      action();
    } else if (phase === 'select' && e.key >= '1' && e.key <= '4') {
      const n = +e.key - 1;
      if (n < teams[fld()].sp.pitches.length) {
        selPitch = n;
        ui.pitchMenu(teams[fld()].sp.pitches, selPitch, teams[fld()].sp.maxKmh);
      }
    }
  });
  ui.onPitchPick((i) => {
    if (phase === 'select') {
      selPitch = i;
      ui.pitchMenu(teams[fld()].sp.pitches, selPitch, teams[fld()].sp.maxKmh);
    }
  });

  // ── 每幀更新 ──
  function updateWidgets() {
    const plate = camMode === 'plate' && started && director.state.mode === 'live';
    fielders[fld()].C.group.visible = !plate;
    ump.group.visible = !plate;
    widgets.visible = plate && ['select', 'meter', 'set', 'windup', 'flight', 'call'].includes(phase);
    if (!widgets.visible) {
      // 球打出去、攻守交替、比賽結束時，把打擊說明和「揮！」收起來
      ui.batHelp(false);
      ui.swingNow(false);
      return;
    }
    const pitching = phase === 'select' || phase === 'meter';
    aimMark.visible = aimDot.visible = pitching;
    meterRing.visible = phase === 'meter';
    aimMark.position.set(aim.x, aim.y, 0);
    aimDot.position.set(aim.x, aim.y, 0);
    if (phase === 'meter') {
      meterRing.position.set(aim.x, aim.y, 0);
      meterRing.scale.setScalar(Math.max(0.3, meterScale()));
    }
    const batting = userBatting() && phase !== 'call';
    pci.visible = pciCore.visible = batting;
    if (batting) {
      const x = swing ? swing.x : aim.x;
      const y = swing ? swing.y : aim.y;
      pci.position.set(x, y, 0);
      pci.scale.setScalar(TUNE.pci);
      pciCore.position.set(x, y, 0);
      // 瞄準圈蓋到這球的進壘點時變綠色
      const onTarget = !!(pitch && phase === 'flight' && Math.hypot(x - pitch.T.x, y - pitch.T.y) <= TUNE.pci * 0.9);
      pci.material.color.set(onTarget ? '#58f08a' : '#d8ff3e');
    }
    // 該揮棒的那一小段時間：落點圈變綠色，並跳出「揮！」
    const swingWindow = !!(batting && pitch && phase === 'flight' && !swing && Math.abs(pitch.Tf - pitch.t - LEAD) <= TUNE.timing);
    ballMark.material.color.set(swingWindow ? '#58f08a' : '#ff7a4d');
    ui.swingNow(swingWindow);
    if (!userBatting() || phase === 'play' || phase === 'switch' || phase === 'over') ui.batHelp(false);
    ballMark.visible = !!(pitch && phase === 'flight' && pitch.t < pitch.Tf && (TUNE.assist || !userBatting()));
    if (ballMark.visible) {
      const s = pitch.t / pitch.Tf;
      const k = 2 * s - s * s;
      ballMark.position.set(pitch.A.x + pitch.B.x * k, pitch.A.y + pitch.B.y * k + 4 * pitch.arc * (1 - s) * (1 - s), 0);
      ballMark.scale.setScalar(1 + 2.2 * (1 - s));
    }
  }

  function update(rawDt) {
    if (!started || paused) return;
    const dt = rawDt * TUNE.timeScale;
    gt += dt;
    pt += dt;
    if (timer) {
      timer.t -= dt;
      if (timer.t <= 0) {
        const fn = timer.fn;
        timer = null;
        fn();
      }
    }

    if (phase === 'select' && TUNE.auto && pt > 0.3) throwWithMeter(0.75);
    else if (phase === 'meter' && pt >= 1.0) throwWithMeter(0.2);
    else if (phase === 'windup') {
      if (!released && pt >= PITCH.dur * 0.9) release(); // 保險：正常由下面依投球動作的進度放球，這裡只防萬一沒觸發
    }
    if (phase === 'flight' && pitch) {
      pitch.t += dt;
      const s = pitch.t / pitch.Tf;
      const { R, A, B, arc } = pitch;
      ball.position.set(
        R.x + (A.x - R.x) * s + B.x * s * s,
        R.y + (A.y - R.y) * s + B.y * s * s + arc * 4 * s * Math.max(0, 1 - s),
        R.z * (1 - s),
      );
      if (aiSwing && aiSwing.type !== 'take' && !pitch.swung && pitch.t >= pitch.Tf - 0.12) {
        pitch.swung = true;
        batter.aimY = pitch.T.y; // 電腦打者往球的高度揮
        batter.play('swing', 0.34, 'stance');
        sfx.swing();
      }
      // 我方打擊且還沒揮棒：球到本壘後多等一下，晚一點點按也算數
      const wait = userBatting() && !swing ? GRACE : 0;
      if (pitch.t >= pitch.Tf + wait && !pitch.resolved) resolvePitch();
    }
    if (phase === 'call' && pitch) {
      // 沒打到的球繼續飛進捕手手套
      pitch.t += dt;
      const s = pitch.t / pitch.Tf;
      if (ball.visible && s >= 1.085) {
        ball.visible = false;
        sfx.pop();
      } else if (ball.visible) {
        ball.position.set(pitch.T.x, pitch.T.y + pitch.B.y * (s - 1) * 2, -pitch.R.z * (s - 1));
      }
    }
    if (phase === 'foul' && foul) {
      const s = foul.path[Math.min(foul.path.length - 1, Math.floor(pt / SIM_DT))];
      ball.position.set(s.x, s.y + 0.05, s.z);
    }
    if (phase === 'play' && play) updatePlay(dt);

    if (swap) {
      updateSwap(dt);
      for (const set of fielders) for (const a of Object.values(set)) a.update(dt);
    } else for (const a of Object.values(fielders[fld()])) a.update(dt);
    if (batter) batter.update(dt);
    for (const r of runners) r.actor.update(dt);
    ump.update(dt);
    // 投手投完球：真人投球會往前跨出半公尺多，動作播完人停在跨步後的位置。接著轉身小跑回投手板、再轉回來面向本壘
    // （不在動作裡把人平移回去：腳沒動、人卻滑回原位，看起來像在飄）
    {
      const p = pitcher();
      const hips = p && p.group.getObjectByName('mixamorigHips');
      if (p && hips) {
        const g = p.group.position;
        if (p.pose === 'pitch') {
          hips.getWorldPosition(_knuckle);
          const off = { x: _knuckle.x - g.x, z: _knuckle.z - g.z };
          if (!pitchBack || pitchBack.state !== 'pitching') pitchBack = { state: 'pitching', off0: off, off };
          else pitchBack.off = off;
        } else if (pitchBack && pitchBack.state === 'pitching') {
          const dx = pitchBack.off.x - pitchBack.off0.x;
          const dz = pitchBack.off.z - pitchBack.off0.z;
          if (Math.hypot(dx, dz) > 0.15) pitchBack = { state: 'settle', dx, dz, t: 0 };
          else pitchBack = null; // 這套投球動作會自己回到原位
        } else if (pitchBack && pitchBack.state === 'settle') {
          // 動作從投球淡出的這一小段，把人的位置補到跨步後的地方（和淡出同步，才不會跳一下）
          const k = Math.min(dt, SETTLE_T - pitchBack.t) / SETTLE_T;
          g.x += pitchBack.dx * k;
          g.z += pitchBack.dz * k;
          pitchBack.t += dt;
          if (pitchBack.t >= SETTLE_T) {
            pitchBack = { state: 'return' };
            p.face(p.home[0], p.home[1]);
            p.set('run');
          }
        } else if (pitchBack && pitchBack.state === 'return') {
          const dx = p.home[0] - g.x;
          const dz = p.home[1] - g.z;
          const d = Math.hypot(dx, dz);
          const step = 2.2 * dt;
          if (d <= step) {
            g.x = p.home[0];
            g.z = p.home[1];
            p.face(0, 0);
            p.set('idle');
            pitchBack = null;
          } else {
            g.x += (dx / d) * step;
            g.z += (dz / d) * step;
          }
        }
      }
    }
    // 出手前：球握在投手手裡。一定要放在球員動畫更新之後，不然球會用到上一格的手，慢一格就差十幾公分
    if (phase === 'windup' && !released) {
      const hp = pitcherBallPos();
      if (hp) {
        ball.visible = true;
        ball.position.copy(hp);
        // 出手時機：投球動作播到「出手那一格」的進度就放球，球從手當時的位置飛出去。
        // 每套投球動作的出手進度不同（在 Blender 量手的軌跡定出來的，見 player3d.js 的 PITCH.releaseU）
        const p = pitcher();
        if (p.pose === 'pitch' && p.u >= PITCH.releaseU) release(hp);
      }
    }
    updateWidgets();
    updateTouch(dt);
  }

  // 觸控：搖桿推多少、準星就以那個速度移動（放開就停）；主按鈕的文字跟著目前能做的動作換
  const STICK_SPEED = 1.1; // 推到底時準星每秒移動的距離（公尺）
  function updateTouch(dt) {
    if (!ui.touch) return;
    let label = '';
    if (active() && camMode === 'plate') {
      if (phase === 'select' && !userBatting()) label = '投球';
      else if (phase === 'meter') label = '出手';
      else if (userBatting() && ['select', 'meter', 'set', 'windup', 'flight'].includes(phase)) label = '揮棒';
    }
    ui.touchControls(label);
    const st = ui.stick();
    if (label && phase !== 'meter' && (st.x || st.y)) {
      aim.x = clamp(aim.x + st.x * STICK_SPEED * dt, -0.62, 0.62);
      aim.y = clamp(aim.y + st.y * STICK_SPEED * dt, 0.18, 1.45);
    }
  }

  function start() {
    paused = false;
    band(true); // 開場期間會被設成暫停；第一次開始也要解除，否則進到比賽後不會更新
    if (started) return;
    started = true;
    refresh();
    beginPA();
  }

  // 開場期間先擺好守備與打者
  resetField();
  spawnBatter();
  for (const a of Object.values(fielders[fld()])) a.update(0);
  batter.update(0);
  ump.update(0);
  widgets.visible = false;
  refresh();

  return {
    S,
    anchors,
    start,
    update,
    // 除錯量測：球與投手手掌的位置（驗證球有沒有握在手上、有沒有從手裡出去）
    // 除錯量測：投手的位置、骨盆與雙腳的世界座標（驗證投完球後有沒有平移滑動）
    debugPitcher: () => {
      const p = pitcher();
      const w = (n) => {
        const b = p.group.getObjectByName(n);
        return b ? b.getWorldPosition(new THREE.Vector3()).toArray() : null;
      };
      return { pose: p.pose, state: pitchBack ? pitchBack.state : '', group: p.group.position.toArray(), hips: w('mixamorigHips'), footL: w('mixamorigLeftFoot'), footR: w('mixamorigRightFoot') };
    },
    debugBall: () => {
      // 用獨立的方式取手的位置（手腕骨本身），不經過 pitcherBallPos，才驗得出球是不是真的在手上
      const w = pitcher().group.getObjectByName('mixamorigRightHand');
      const h = w ? w.getWorldPosition(new THREE.Vector3()) : null;
      // 球也取世界座標（球放在有墊高的群組裡，直接拿 position 比會差一截而看不出來）
      return { phase, released, visible: ball.visible, ball: ball.getWorldPosition(new THREE.Vector3()).toArray(), hand: h ? h.toArray() : null };
    },
    liveCam,
    setPaused: (v) => {
      paused = v;
      band(!v);
      if (v) widgets.visible = false;
    },
    get phase() {
      return phase;
    },
    // 測試用：目前這球的飛行進度與進壘點、直接設定游標位置
    debugPitch: () => (pitch ? { s: pitch.t / pitch.Tf, T: pitch.T, Tf: pitch.Tf } : null),
    debugState: () => ({ phase, aim: { ...aim }, selPitch, userBatting: userBatting() }),
    debugAim(x, y) {
      aim.x = x;
      aim.y = y;
    },
    // DEV：直接觸發指定的擊球結果
    debugHit(kind) {
      if (!started || S.over || !batter || phase === 'play' || phase === 'post' || phase === 'switch') return;
      timer = null;
      const sp = (Math.random() * 2 - 1) * 30;
      const presets = {
        hr: { ev: 49, la: 29, spray: sp },
        single: { ev: 38, la: 9, spray: sp },
        double: { ev: 44, la: 17, spray: (Math.random() < 0.5 ? -1 : 1) * 24 },
        ground: { ev: 30, la: -6, spray: (Math.random() < 0.5 ? -1 : 1) * 14 },
        fly: { ev: 36, la: 38, spray: sp },
      };
      batter.play('swing', 0.34, 'idle');
      startPlay({ ...presets[kind], q: 0.9 });
    },
    debugBatter() {
      return batter; // DEV：打擊姿勢微調用的鏡頭要知道打者在哪
    },
    debugSwitch() {
      if (!started || S.over) return;
      timer = null;
      play = null;
      switchHalf();
    },
    debugEnd() {
      if (!started || S.over) return;
      timer = null;
      play = null;
      gameOver();
    },
  };
}
