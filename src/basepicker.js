import * as THREE from 'three';
import { BASES } from './ballsim.js';
import { FIELD_Y } from './util.js';
import { TUNE } from './tuning.js';

// ── 防守傳壘：跟著鏡頭的浮動壘包圖層 ──
// 四個壘包按鈕每一幀投影到畫面上真正的壘包位置（鏡頭怎麼動都貼著壘包）。
// 手機直接點；電腦按 1–4（一壘、二壘、三壘、本壘），也可以用滑鼠點。
// 能讓跑者出局的壘包亮綠色；上方有倒數條，時間到自動傳。
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const LABEL = { 1: '一壘', 2: '二壘', 3: '三壘', 4: '本壘' };

export function createBasePicker({ camera, canvas, onPick }) {
  const root = document.createElement('div');
  root.id = 'base-picker';
  const btns = {};
  for (const n of [1, 2, 3, 4]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'bp-base';
    b.innerHTML = `<i>${n}</i><span>${LABEL[n]}</span>`;
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (open) onPick(n);
    });
    root.appendChild(b);
    btns[n] = b;
  }
  const bar = document.createElement('div');
  bar.className = 'bp-bar';
  bar.innerHTML = '<b>傳哪一壘？</b><span class="bp-keys">手機點壘包・電腦按 1–4</span><em><u></u></em>';
  root.appendChild(bar);
  document.body.appendChild(root);
  const fill = bar.querySelector('u');

  let open = false;
  window.addEventListener('keydown', (e) => {
    if (!open || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key >= '1' && e.key <= '4') {
      e.preventDefault();
      onPick(+e.key);
    }
  });

  const v = new THREE.Vector3();
  return {
    get open() {
      return open;
    },
    // hints[n]＝true：傳到 n 壘有機會讓跑者出局（亮綠色）
    show(hints) {
      open = true;
      root.classList.add('show');
      this.hints(hints);
      this.update(0);
    },
    hide() {
      open = false;
      root.classList.remove('show');
    },
    hints(h) {
      for (const n of [1, 2, 3, 4]) btns[n].classList.toggle('good', !!(h && h[n]));
    },
    // k：剩餘時間比例 1→0
    update(k) {
      if (!open) return;
      fill.style.transform = `scaleX(${clamp(k, 0, 1)})`;
      const r = canvas.getBoundingClientRect();
      const s = TUNE.pickSize;
      for (const n of [1, 2, 3, 4]) {
        const [x, z] = BASES[n % 4];
        v.set(x, FIELD_Y + 0.3, z).project(camera);
        const behind = v.z > 1;
        // 壘包跑出畫面時貼在畫面邊緣，仍然點得到
        const sx = clamp(r.left + (v.x * 0.5 + 0.5) * r.width, r.left + 44 * s, r.right - 44 * s);
        const sy = clamp(r.top + (-v.y * 0.5 + 0.5) * r.height, r.top + 90 * s, r.bottom - 54 * s);
        btns[n].style.transform = `translate(${sx}px, ${sy}px) translate(-50%, -50%) scale(${s})`;
        btns[n].classList.toggle('edge', behind);
      }
    },
  };
}
