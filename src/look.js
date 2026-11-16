// 畫面風格參數（DEV 面板調整後匯出的數值會寫回這裡）
export const LOOK = {
  sun: { azimuth: 272, elevation: 31, intensity: 3.6, color: '#ffdcae' },
  hemi: { sky: '#b4d0ff', ground: '#7a6650', intensity: 1.15 },
  sky: { top: '#2a66cc', mid: '#a6d0f7', horizon: '#ffcf96', sunGlow: '#ffb469' },
  fog: { color: '#f0d2ad', density: 0.00042 },
  post: {
    exposure: 1.08,
    bloomStrength: 0.32,
    bloomRadius: 0.7,
    bloomThreshold: 0.9,
    vignette: 0.32,
    saturation: 1.12,
    contrast: 1.06,
  },
  camera: { fov: 32, autoOrbit: false, orbitSpeed: 0.25 },
};

const STORAGE_KEY = 'starridge.look.v1';

// 深層合併：只覆蓋預設值裡已存在的欄位
function merge(target, src) {
  for (const k of Object.keys(target)) {
    if (!(k in src)) continue;
    if (typeof target[k] === 'object' && target[k] !== null) merge(target[k], src[k]);
    else target[k] = src[k];
  }
}

export const LOOK_DEFAULT = JSON.parse(JSON.stringify(LOOK));

export function loadLook() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) merge(LOOK, JSON.parse(raw));
  } catch (e) {
    /* 讀不到就用預設值 */
  }
}

export function saveLook() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(LOOK));
  } catch (e) {
    /* 忽略 */
  }
}

export function resetLook() {
  merge(LOOK, LOOK_DEFAULT);
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (e) {
    /* 忽略 */
  }
}
