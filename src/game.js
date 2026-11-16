import * as THREE from 'three';
import { FIELD_Y } from './util.js';
import { TUNE, SHOTS } from './tuning.js';
import { PITCHES, GRADE_MUL } from './data.js';
import { makeActor, FIELD_POS } from './player3d.js'; // 舊的程式建模球員在 players.js，改回那個檔即可還原
import { flight, fieldPlay, resolveOutcome, BASES, SIM_DT } from './ballsim.js';
import { sfx, sayParts, band } from './audio.js';
import { line } from './commentary.js';

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
        ...team.kit, skin: info.skin, hair: info.hair, hairStyle: info.hairStyle, no: info.no, icon: team.icon,
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
  const ballMark = mk(new THREE.RingGeometry(0.042, 0.054, 32), flat('#ff7a4d', 0.95));

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
  let lastPitch = '';
  const lastType = [null, null];
  const aim = { x: 0, y: zc };
  const look = new THREE.Vector3(0, 1, -20);
  let followFov = 42;

  const bat = () => S.half;
  const fld = () => 1 - S.half;
  const userBatting = () => S.half === USER && !TUNE.auto;
  const userPitching = () => S.half !== USER && !TUNE.auto;
  const pitcher = () => fielders[fld()].P;
  const setPhase = (p) => {
    phase = p;
    pt = 0;
  };
  const schedule = (sec, fn) => {
    timer = { t: sec, fn };
  };

  function refresh() {
    hud.render({
      S, away: teams[0], home: teams[1],
      batter: batterInfo, batTeam: teams[bat()], order: S.batIdx[bat()] + 1,
      today: batterInfo ? stat(batterInfo) : null,
      pitcher: teams[fld()].sp, fldTeam: teams[fld()], pitchCount: S.pitchCount[fld()], lastPitch,
    });
    scoreboard.draw({ S, away: teams[0], home: teams[1], innings: TUNE.innings });
  }

  function resetField() {
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
      ...team.kit, skin: p.skin, hair: p.hair, hairStyle: p.hairStyle, no: p.no, bat: true, helmet: side,
    });
    batter.side = side;
    batter.group.position.set(-batter.side * 1.0, 0, 0.05);
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
      ui.pitchMenu(sp.pitches, selPitch);
      ui.hint('1–4 選球種　滑鼠瞄準　點擊投球，圈縮到剛好時再點一下');
    } else {
      plan = aiPlan(sp);
      ui.pitchMenu(null);
      ui.hint(userBatting() ? '移動游標對準來球　點擊或空白鍵揮棒' : '');
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
    pitcher().play('pitch', 1.25, 'idle');
  }

  function release() {
    released = true;
    const hand = pitcher().hand;
    const def = PITCHES[plan.name];
    const mul = GRADE_MUL[plan.g] || 1;
    const R = { x: -0.3 * hand, y: MOUND_Y + 1.6, z: -18.44 + 0.9 };
    const B = { x: def.bx * hand * mul, y: def.by * mul };
    const T = plan.T;
    const d = Math.hypot(T.x - R.x, T.y - R.y, R.z);
    pitch = {
      R, B, T, A: { x: T.x - B.x, y: T.y - B.y },
      Tf: d / (plan.kmh / 3.6) / TUNE.speedScale,
      arc: (1 - def.speed) * 1.1 + 0.05,
      t: 0, resolved: false, swung: false,
    };
    setPhase('flight');
    ball.visible = true;
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

  function userSwingResult() {
    if (!swing) return { type: 'take' };
    const T = pitch.T;
    const dt = swing.at + 0.12 - gt;
    if (Math.abs(dt) > TUNE.timing * 1.25) return { type: 'whiff' };
    const d = Math.hypot(swing.x - T.x, swing.y - T.y);
    const lim = TUNE.pci * 1.55;
    if (d > lim) return { type: 'whiff' };
    const q = clamp((1 - d / lim) * (1 - (0.55 * Math.abs(dt)) / TUNE.timing) * 1.15, 0, 1);
    if (q < 0.16) return { type: 'foul' };
    const spray = (dt / TUNE.timing) * 50 * batter.side + gauss() * 5;
    if (Math.abs(spray) > 45) return { type: 'foul' };
    return {
      type: 'contact', q, spray,
      ev: ((88 + 80 * q) * power(batterInfo)) / 3.6,
      la: clamp(13 + (T.y - swing.y) * 190 + gauss() * 4, -28, 62),
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

  function switchHalf() {
    runners.forEach((r) => root.remove(r.actor.group));
    runners = [];
    removeBatter();
    S.outs = 0;
    S.balls = 0;
    S.strikes = 0;
    S.bases = [null, null, null];
    const N = TUNE.innings;
    if (S.half === 0) {
      if (S.inning >= N && S.score[1] > S.score[0]) return gameOver();
      S.half = 1;
    } else {
      if (S.inning >= N) return gameOver();
      S.half = 0;
      S.inning++;
    }
    S.lines[S.half][S.inning - 1] = 0;
    batterInfo = null;
    ui.dip();
    resetField();
    ui.pitchMenu(null);
    ui.hint('');
    refresh();
    ui.banner({ kicker: '攻守交替', title: `${S.inning} 局${S.half ? '下' : '上'}`, sub: `${teams[bat()].name} 進攻` }, 2.2);
    sayParts(line.change(S.inning, S.half, teams[bat()].name), true);
    setPhase('switch');
    schedule(2.4, beginPA);
  }

  function gameOver() {
    S.over = true;
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
    p.t += dt;
    const t = p.t;
    const { fl, fp } = p;

    // 球
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
      const k = clamp((t - 0.3) / Math.max(0.3, c.by - 0.3), 0, 1);
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

    if (t >= p.tEnd) finishPlay();
  }

  function finishPlay() {
    const p = play;
    const { out } = p;
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
    else if (userBatting() && !swing && (phase === 'set' || phase === 'windup' || phase === 'flight')) {
      swing = { at: gt, x: aim.x, y: aim.y };
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

  canvas.addEventListener('pointermove', (e) => active() && pointerToAim(e));
  canvas.addEventListener('pointerdown', (e) => {
    if (!active()) return;
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
        ui.pitchMenu(teams[fld()].sp.pitches, selPitch);
      }
    }
  });
  ui.onPitchPick((i) => {
    if (phase === 'select') {
      selPitch = i;
      ui.pitchMenu(teams[fld()].sp.pitches, selPitch);
    }
  });

  // ── 每幀更新 ──
  function updateWidgets() {
    const plate = camMode === 'plate' && started && director.state.mode === 'live';
    fielders[fld()].C.group.visible = !plate;
    ump.group.visible = !plate;
    widgets.visible = plate && ['select', 'meter', 'set', 'windup', 'flight', 'call'].includes(phase);
    if (!widgets.visible) return;
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
    }
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
      if (!released && pt >= 1.25 * 0.69) release();
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
        batter.play('swing', 0.34, 'stance');
        sfx.swing();
      }
      if (s >= 1 && !pitch.resolved) resolvePitch();
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

    for (const a of Object.values(fielders[fld()])) a.update(dt);
    if (batter) batter.update(dt);
    for (const r of runners) r.actor.update(dt);
    ump.update(dt);
    updateWidgets();
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
