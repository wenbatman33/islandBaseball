// 觸身球：打者被球砸到的反應，不寫字、用動作演
//   砸到的瞬間　身體一縮、整個人往外彈開半步，砸到的位置爆出一個衝擊星
//   接下來　　　彎腰縮著、痛得發抖，頭上冒出幾道痛的記號
// 做法和投手狀態（armfx.js）一樣：動作播完之後，再在幾根骨頭上疊旋轉，動作本身不改。
import * as THREE from 'three';

const P = 'mixamorig';
const BONES = ['Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'LeftShoulder', 'RightShoulder', 'LeftArm', 'RightArm'];

function tex(draw) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  draw(g);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
// 衝擊星：尖刺狀的爆炸圖案
const T_BANG = tex((g) => {
  g.translate(64, 64);
  g.beginPath();
  for (let i = 0; i < 20; i++) {
    const r = i % 2 ? 26 : 58 - (i % 4 ? 0 : 10);
    const a = (i / 20) * Math.PI * 2;
    g[i ? 'lineTo' : 'moveTo'](Math.cos(a) * r, Math.sin(a) * r);
  }
  g.closePath();
  g.fillStyle = '#fff6b0';
  g.fill();
  g.lineJoin = 'round';
  g.lineWidth = 8;
  g.strokeStyle = '#e8372c';
  g.stroke();
  g.beginPath();
  g.arc(0, 0, 14, 0, Math.PI * 2);
  g.fillStyle = '#ffffff';
  g.fill();
});
// 痛的記號：一道短短的紅色斜線
const T_PAIN = tex((g) => {
  g.lineCap = 'round';
  for (const [w, col] of [[30, '#050a20'], [16, '#ff5a3c']]) {
    g.beginPath();
    g.moveTo(64, 16);
    g.lineTo(64, 112);
    g.lineWidth = w;
    g.strokeStyle = col;
    g.stroke();
  }
});

const sprite = (map, size) => {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false, depthTest: false }));
  s.scale.setScalar(size);
  s.visible = false;
  s.renderOrder = 6;
  return s;
};

export function createHbpFx(root) {
  const group = new THREE.Group();
  root.add(group);
  const bang = sprite(T_BANG, 0.6);
  const pains = Array.from({ length: 3 }, () => sprite(T_PAIN, 0.2));
  group.add(bang, ...pains);
  const head = new THREE.Vector3();
  let cur = null; // { actor, away, base, t, at }

  const hide = () => {
    bang.visible = false;
    pains.forEach((p) => (p.visible = false));
  };

  return {
    /** 開始演：actor＝打者；away＝往外彈開的方向（x 軸，±1）；at＝砸到的位置（root 的座標） */
    hit(actor, away, at) {
      const b = {};
      for (const n of BONES) b[n] = actor.group.getObjectByName(P + n);
      cur = { actor, away, b, base: actor.group.position.clone(), t: 0, at: at.clone() };
    },
    stop() {
      cur = null;
      hide();
    },
    /** 每格在打者的動作更新完之後呼叫 */
    update(dt) {
      if (!cur) return;
      const { actor, b } = cur;
      if (!actor.group.parent || !actor.group.visible) return this.stop();
      cur.t += dt;
      const t = cur.t;
      const snap = 1 - Math.exp(-t * 16); // 一瞬間縮起來
      const kick = Math.exp(-t * 7); // 砸到那一下的衝擊，很快消掉
      // 整個人往外彈開半步、被砸的瞬間小跳一下
      actor.group.position.set(cur.base.x + cur.away * 0.22 * snap, cur.base.y + Math.sin(Math.min(1, t / 0.28) * Math.PI) * 0.07, cur.base.z);
      if (b.Spine) {
        const shake = Math.sin(t * 34) * 0.03 * snap; // 痛得發抖
        b.Spine.rotateX(0.2 * snap + 0.18 * kick);
        b.Spine1.rotateX(0.18 * snap + shake);
        b.Spine2.rotateX(0.14 * snap);
        b.Spine2.rotateZ(shake);
        b.Neck?.rotateX(0.14 * snap);
        b.Head?.rotateX(0.16 * snap + 0.2 * kick);
        b.Head?.rotateZ(Math.sin(t * 9) * 0.06 * snap);
        // 肩膀聳起、手臂夾緊
        b.LeftShoulder?.rotateZ(-0.2 * snap);
        b.RightShoulder?.rotateZ(0.2 * snap);
        b.LeftArm?.rotateX(0.25 * snap);
        b.RightArm?.rotateX(0.25 * snap);
      }
      // 衝擊星：砸到的位置，放大後淡出
      const k = t / 0.38;
      bang.visible = k < 1;
      if (bang.visible) {
        bang.position.copy(cur.at);
        bang.scale.setScalar(0.3 + k * 0.6);
        bang.material.opacity = 1 - k * k;
        bang.material.rotation = 0.4;
      }
      // 痛的記號：頭上三道斜線一跳一跳
      if (b.Head) {
        actor.group.updateMatrixWorld(true);
        b.Head.getWorldPosition(head);
        root.worldToLocal(head);
      }
      pains.forEach((p, i) => {
        p.visible = t > 0.12 && !!b.Head;
        if (!p.visible) return;
        const a = (i - 1) * 0.55;
        const pulse = 0.5 + 0.5 * Math.sin(t * 16 + i * 1.3);
        const r = 0.4 + pulse * 0.06;
        p.position.set(head.x + Math.sin(a) * r, head.y + 0.12 + Math.cos(a) * r, head.z);
        p.material.rotation = -a;
        p.scale.set(0.09, 0.2 + pulse * 0.05, 1);
        p.material.opacity = Math.min(1, (t - 0.12) * 8);
      });
    },
  };
}
