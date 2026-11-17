import * as THREE from 'three';

// ── 打擊預備姿勢微調層 ──
// 動作檔播完後再疊一層調整：握點位置、球棒角度、前後手肘方向、蹲低、上身前傾、腳距。
// 用兩節 IK 讓雙手始終握在球棒上、雙腳踩在原處。DEV 面板（D 鍵）即時調整，匯出後把數值寫回 BATPOSE_DEFAULT。
// 單位：位移是公分、角度是度。全部是 0 時等於沒有調整。
// 目前的預設值是使用者在 DEV 面板對照職業打者影片調好、匯出後鎖定的數值。

export const BATPOSE_DEFAULT = {
  on: true,
  gripPlate: 7.5, // 握點往本壘（+）／往身體（-）
  gripUp: -25, // 握點往上（+）／往下（-）
  gripCatcher: 0, // 握點往捕手（+）／往投手（-）
  tiltBack: -25, // 球棒往打者背後倒（+）／往本壘倒（-）
  tiltCatcher: 10, // 球棒往捕手倒（+）／往投手倒（-）
  roll: -8, // 球棒繞自己轉
  elbowFront: 2, // 前手肘繞手臂轉的角度
  elbowBack: 23, // 後手肘繞手臂轉的角度
  crouch: 4, // 重心壓低
  lean: 0.5, // 上身往本壘前傾
  spread: -7, // 兩腳再分開
  freeze: false, // 定格預備姿勢（不晃動，方便對照）
};

const KEY = 'island.batpose';
export const BATPOSE = { ...BATPOSE_DEFAULT };
try {
  Object.assign(BATPOSE, JSON.parse(localStorage.getItem(KEY) || '{}'));
} catch {
  /* 讀不到就用預設值 */
}
export function saveBatPose() {
  try {
    localStorage.setItem(KEY, JSON.stringify(BATPOSE));
  } catch {
    /* 存不了就算了，只是重新整理後會回到預設 */
  }
}
export function resetBatPose() {
  Object.assign(BATPOSE, BATPOSE_DEFAULT);
  saveBatPose();
}

// 動作檔（模型自己的座標）裡的方向：打者面向 -X（本壘），+Y 上，-Z 往捕手
const PLATE = new THREE.Vector3(-1, 0, 0);
const UP = new THREE.Vector3(0, 1, 0);
const CATCHER = new THREE.Vector3(0, 0, -1);
const P = 'mixamorig';
const NAMES = ['Hips', 'Spine', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm', 'RightHand',
  'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot'];

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();

// 以下都在「模型自己的座標」（inner 的座標系）裡算：左打者的鏡射在 inner 上，這樣算出的旋轉不會被鏡射搞亂
function inSpace(inv, obj) {
  return new THREE.Matrix4().multiplyMatrices(inv, obj.matrixWorld);
}
function posOf(inv, obj) {
  return new THREE.Vector3().setFromMatrixPosition(inSpace(inv, obj));
}
function quatOf(inv, obj) {
  inSpace(inv, obj).decompose(_v, _q, _s);
  return _q.clone();
}
// 把骨頭的「模型座標」轉成父骨頭底下的區域座標
function setInSpace(inv, obj, M) {
  const parentM = inSpace(inv, obj.parent);
  _m.copy(parentM).invert().multiply(M);
  const scale = obj.scale.clone();
  _m.decompose(obj.position, obj.quaternion, _s);
  obj.scale.copy(scale);
  obj.updateMatrixWorld(true);
}
// 讓骨頭在模型座標裡多轉 q（以骨頭自己的位置為軸心）
function rotateBone(inv, bone, q) {
  const parentQ = quatOf(inv, bone.parent);
  const worldQ = quatOf(inv, bone);
  bone.quaternion.copy(parentQ.invert().multiply(q.clone().multiply(worldQ)));
  bone.updateMatrixWorld(true);
}

// 兩節 IK：上段 A、下段 B、末端 C 指向目標 T，中間關節往 pole 方向彎
function ik2(inv, A, B, C, T, pole) {
  const a = posOf(inv, A);
  const b = posOf(inv, B);
  const c = posOf(inv, C);
  const L1 = a.distanceTo(b);
  const L2 = b.distanceTo(c);
  const dv = T.clone().sub(a);
  const d = THREE.MathUtils.clamp(dv.length(), Math.abs(L1 - L2) + 1e-3, L1 + L2 - 1e-3);
  const dn = dv.normalize();
  const x = (L1 * L1 - L2 * L2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, L1 * L1 - x * x));
  const pv = pole.clone().sub(dn.clone().multiplyScalar(pole.dot(dn)));
  if (pv.lengthSq() < 1e-8) pv.copy(UP);
  pv.normalize();
  const e = a.clone().add(dn.clone().multiplyScalar(x)).add(pv.multiplyScalar(h));
  rotateBone(inv, A, new THREE.Quaternion().setFromUnitVectors(b.clone().sub(a).normalize(), e.clone().sub(a).normalize()));
  const b2 = posOf(inv, B);
  const c2 = posOf(inv, C);
  const end = a.clone().add(dn.clone().multiplyScalar(d));
  rotateBone(inv, B, new THREE.Quaternion().setFromUnitVectors(c2.sub(b2.clone()).normalize(), end.sub(b2).normalize()));
}

// 關節目前往哪邊彎（給 IK 當預設的彎曲方向）
function bendDir(inv, A, B, C) {
  const a = posOf(inv, A);
  const b = posOf(inv, B);
  const c = posOf(inv, C);
  const ax = c.clone().sub(a).normalize();
  const v = b.clone().sub(a);
  return v.sub(ax.multiplyScalar(v.dot(ax))).normalize();
}

function bonesOf(inner) {
  let B = inner.userData.batBones;
  if (!B) {
    B = {};
    for (const n of NAMES) B[n] = inner.getObjectByName(P + n);
    if (NAMES.some((n) => !B[n])) return null;
    inner.userData.batBones = B;
  }
  return B;
}

// 球棒在 bat 骨頭座標裡的方向與長度（從球棒網格量，不假設骨頭的軸向）
function batInfo(inner, bat) {
  if (inner.userData.batInfo) return inner.userData.batInfo;
  let mesh = null;
  inner.traverse((o) => {
    if (o.name === 'bat_mesh' && o.isSkinnedMesh) mesh = o;
  });
  const info = { axis: new THREE.Vector3(0, 1, 0), len: 0.9 };
  if (mesh) {
    const i = mesh.skeleton.bones.indexOf(bat);
    if (i >= 0) {
      const M = new THREE.Matrix4().multiplyMatrices(mesh.skeleton.boneInverses[i], mesh.bindMatrix);
      const pos = mesh.geometry.attributes.position;
      const v = new THREE.Vector3();
      let best = 0;
      for (let k = 0; k < pos.count; k++) {
        v.fromBufferAttribute(pos, k).applyMatrix4(M);
        if (v.length() > best) {
          best = v.length();
          info.axis.copy(v).normalize();
        }
      }
      info.len = best;
    }
  }
  inner.userData.batInfo = info;
  return info;
}

// 把球棒移到 batNew，雙手 IK 回到球棒上原本握的位置（turn：前／後手肘繞手臂轉幾度）
function moveBat(inv, B, bat, batNew, relL, relR, poles, turnF, turnB) {
  setInSpace(inv, bat, batNew);
  for (const [side, rel, turn] of [['Left', relL, turnF], ['Right', relR, turnB]]) {
    const target = batNew.clone().multiply(rel);
    const T = new THREE.Vector3().setFromMatrixPosition(target);
    const sh = posOf(inv, B[side + 'Arm']);
    const axis = T.clone().sub(sh).normalize();
    const pole = poles[side].clone().applyAxisAngle(axis, turn);
    ik2(inv, B[side + 'Arm'], B[side + 'ForeArm'], B[side + 'Hand'], T, pole);
    target.setPosition(posOf(inv, B[side + 'Hand']));
    setInSpace(inv, B[side + 'Hand'], target);
  }
}

/**
 * 揮棒高度跟著瞄準點：擊球前後把雙手往下沉、棒頭往下壓（或往上抬），讓球棒甜蜜點經過瞄準的高度。
 * aimY：瞄準點離地高度（公尺，和好球帶同一套座標）；w：套用比例（擊球那一刻最大）
 */
export function applySwingAim(inner, bat, w, aimY) {
  if (w <= 0 || !bat || aimY == null) return;
  const B = bonesOf(inner);
  if (!B) return;
  inner.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(inner.matrixWorld).invert();
  const bat0 = inSpace(inv, bat);
  const bat0inv = bat0.clone().invert();
  const relL = bat0inv.clone().multiply(inSpace(inv, B.LeftHand));
  const relR = bat0inv.clone().multiply(inSpace(inv, B.RightHand));
  const poles = {
    Left: bendDir(inv, B.LeftArm, B.LeftForeArm, B.LeftHand),
    Right: bendDir(inv, B.RightArm, B.RightForeArm, B.RightHand),
  };
  const info = batInfo(inner, bat);
  const origin = new THREE.Vector3().setFromMatrixPosition(bat0);
  const dir = info.axis.clone().transformDirection(bat0);
  const pivot = new THREE.Vector3().setFromMatrixPosition(bat0.clone().multiply(relL))
    .add(new THREE.Vector3().setFromMatrixPosition(bat0.clone().multiply(relR))).multiplyScalar(0.5);
  // 甜蜜點：離棒頭約 17 公分
  const sweet = origin.clone().add(dir.clone().multiplyScalar(info.len - 0.17));
  const target = aimY / Math.max(0.5, inner.scale.y); // 模型座標裡的高度（模型有依體型縮放）
  const dh = sweet.y - target; // 正值＝要往下
  const hands = THREE.MathUtils.clamp(dh * 0.35, -0.08, 0.22);
  const reach = sweet.clone().sub(pivot);
  const flat = Math.max(0.2, Math.hypot(reach.x, reach.z));
  const ang = Math.asin(THREE.MathUtils.clamp((dh - hands) / Math.max(0.3, reach.length()), -0.8, 0.8));
  const axis = new THREE.Vector3().crossVectors(dir, UP);
  if (axis.lengthSq() < 1e-6 || flat < 0.2) return;
  axis.normalize();
  const R = new THREE.Matrix4().makeRotationAxis(axis, -ang * w);
  const batNew = new THREE.Matrix4().makeTranslation(pivot.x, pivot.y - hands * w, pivot.z)
    .multiply(R).multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z)).multiply(bat0);
  moveBat(inv, B, bat, batNew, relL, relR, poles, 0, 0);
}

/**
 * 在動作檔的姿勢上套用微調。w：套用比例（預備姿勢 1；揮棒剛開始時從 1 平順降到 0）
 */
export function applyBatPose(inner, bat, w) {
  const S = BATPOSE;
  if (!S.on || w <= 0 || !bat) return;
  const B = bonesOf(inner);
  if (!B) return;
  inner.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(inner.matrixWorld).invert();
  const cm = 0.01 * w;
  const deg = THREE.MathUtils.DEG2RAD * w;

  // 先記下原本：球棒、雙手相對球棒的位置、雙腳
  const bat0 = inSpace(inv, bat);
  const bat0inv = bat0.clone().invert();
  const relL = bat0inv.clone().multiply(inSpace(inv, B.LeftHand));
  const relR = bat0inv.clone().multiply(inSpace(inv, B.RightHand));
  const feet = {
    Left: inSpace(inv, B.LeftFoot),
    Right: inSpace(inv, B.RightFoot),
  };
  const poles = {
    Left: bendDir(inv, B.LeftArm, B.LeftForeArm, B.LeftHand),
    Right: bendDir(inv, B.RightArm, B.RightForeArm, B.RightHand),
    knee: {
      Left: bendDir(inv, B.LeftUpLeg, B.LeftLeg, B.LeftFoot),
      Right: bendDir(inv, B.RightUpLeg, B.RightLeg, B.RightFoot),
    },
  };

  // 1. 身體：壓低重心、上身前傾
  if (S.crouch) {
    const hp = inSpace(inv, B.Hips);
    hp.elements[13] -= S.crouch * cm;
    setInSpace(inv, B.Hips, hp);
  }
  if (S.lean) {
    const axis = new THREE.Vector3().crossVectors(UP, PLATE).normalize(); // 繞這個軸，頭往本壘那側倒
    rotateBone(inv, B.Spine, new THREE.Quaternion().setFromAxisAngle(axis, -S.lean * deg));
  }

  // 2. 雙腳：踩回原處（再依腳距往兩側分開），膝蓋照原本方向彎，腳掌維持原本朝向
  const pitcher = CATCHER.clone().negate();
  for (const [side, sign] of [['Left', 1], ['Right', -1]]) {
    const F = feet[side];
    const T = new THREE.Vector3().setFromMatrixPosition(F).add(pitcher.clone().multiplyScalar(sign * S.spread * 0.5 * cm));
    ik2(inv, B[side + 'UpLeg'], B[side + 'Leg'], B[side + 'Foot'], T, poles.knee[side]);
    const FM = F.clone();
    FM.setPosition(posOf(inv, B[side + 'Foot']));
    setInSpace(inv, B[side + 'Foot'], FM);
  }

  // 3. 球棒：以雙手中間為軸心轉動、再整根移動
  const pivot = new THREE.Vector3().setFromMatrixPosition(bat0.clone().multiply(relL))
    .add(new THREE.Vector3().setFromMatrixPosition(bat0.clone().multiply(relR))).multiplyScalar(0.5);
  const batDir = batInfo(inner, bat).axis.clone().transformDirection(bat0);
  const rot = new THREE.Quaternion()
    .setFromAxisAngle(CATCHER, S.tiltBack * deg)
    .multiply(new THREE.Quaternion().setFromAxisAngle(PLATE, -S.tiltCatcher * deg))
    .multiply(new THREE.Quaternion().setFromAxisAngle(batDir, S.roll * deg));
  const move = PLATE.clone().multiplyScalar(S.gripPlate * cm)
    .add(UP.clone().multiplyScalar(S.gripUp * cm))
    .add(CATCHER.clone().multiplyScalar(S.gripCatcher * cm));
  const R = new THREE.Matrix4().makeRotationFromQuaternion(rot);
  const batNew = new THREE.Matrix4().makeTranslation(pivot.x + move.x, pivot.y + move.y, pivot.z + move.z)
    .multiply(R).multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z)).multiply(bat0);
  moveBat(inv, B, bat, batNew, relL, relR, poles, S.elbowFront * deg, S.elbowBack * deg);
}
