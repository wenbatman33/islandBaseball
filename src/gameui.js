import { PITCHES } from './data.js';

// 玩法相關的畫面元件：球種選單、操作提示、判決文字、結果橫幅、終場畫面
export function buildGameUI(root) {
  root.insertAdjacentHTML(
    'beforeend',
    `<div class="pitch-menu" data-lay="pitchMenu"></div>
     <div class="hint" data-lay="hint"></div>
     <div class="pitch-info" data-lay="pitchInfo"></div>
     <div class="call" id="call"></div>
     <div class="banner" data-lay="banner"><small></small><b></b><span></span></div>
     <div class="final" id="final"></div>`,
  );
  const elMenu = root.querySelector('.pitch-menu');
  const elHint = root.querySelector('.hint');
  const elInfo = root.querySelector('.pitch-info');
  const elCall = root.querySelector('.call');
  const elBanner = root.querySelector('.banner');
  const elFinal = root.querySelector('.final');
  const dip = document.getElementById('dip');
  let pick = () => {};
  let bannerTimer = 0;
  let callTimer = 0;
  let infoTimer = 0;

  const retrigger = (el, cls) => {
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  };

  elMenu.addEventListener('pointerdown', (e) => {
    const row = e.target.closest('[data-i]');
    if (row) pick(+row.dataset.i);
  });

  return {
    onPitchPick(fn) {
      pick = fn;
    },
    // list 為 null 時隱藏
    pitchMenu(list, sel) {
      elMenu.classList.toggle('show', !!list);
      if (!list) return;
      elMenu.innerHTML =
        '<div class="pm-head">球種</div>' +
        list
          .map(([name, g], i) => {
            const d = PITCHES[name];
            const tag = d.speed >= 0.95 ? '速球' : Math.abs(d.by) > 0.3 ? '下墜' : '橫移';
            return `<div class="pm-row ${i === sel ? 'on' : ''}" data-i="${i}"><kbd>${i + 1}</kbd><b>${name}</b><em>${tag}</em><i class="g g-${g}">${g}</i></div>`;
          })
          .join('');
    },
    hint(text) {
      elHint.textContent = text;
      elHint.classList.toggle('show', !!text);
    },
    pitchInfo(text) {
      elInfo.textContent = text;
      retrigger(elInfo, 'show');
      clearTimeout(infoTimer);
      infoTimer = setTimeout(() => elInfo.classList.remove('show'), 1800);
    },
    call(text, kind) {
      elCall.textContent = text;
      elCall.dataset.kind = kind;
      retrigger(elCall, 'show');
      clearTimeout(callTimer);
      callTimer = setTimeout(() => elCall.classList.remove('show'), 1000);
    },
    banner({ kicker, title, sub, good }, sec) {
      elBanner.querySelector('small').textContent = kicker || '';
      elBanner.querySelector('b').textContent = title;
      elBanner.querySelector('span').textContent = sub || '';
      elBanner.classList.toggle('good', !!good);
      retrigger(elBanner, 'show');
      clearTimeout(bannerTimer);
      bannerTimer = setTimeout(() => elBanner.classList.remove('show'), sec * 1000);
    },
    dip() {
      retrigger(dip, 'go');
    },
    final({ S, away, home }) {
      const [a, h] = S.score;
      const verdict = a === h ? '平手' : h > a ? `${home.name} 獲勝` : `${away.name} 獲勝`;
      const row = (t, i) =>
        `<div class="fn-row ${S.score[i] > S.score[1 - i] ? 'win' : ''}"><i class="emblem" style="--c1:${t.c1};--c2:${t.c2}">${t.glyph}</i><b>${t.name}</b><span>${S.hits[i]} 安打</span><em>${S.score[i]}</em></div>`;
      elFinal.innerHTML = `
        <div class="fn-box">
          <div class="p-kicker">FINAL · 比賽結束</div>
          <h2>${verdict}</h2>
          ${row(away, 0)}${row(home, 1)}
          <button type="button" id="again">再來一場</button>
        </div>`;
      elFinal.classList.add('show');
      elFinal.querySelector('#again').addEventListener('click', () => location.reload());
    },
  };
}
