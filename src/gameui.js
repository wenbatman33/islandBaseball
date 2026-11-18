import { PITCHES } from './data.js';

// 玩法相關的畫面元件：球種選單、操作提示、判決文字、結果橫幅、終場畫面
// 判決文字 → 美術字素材
const CALL_ART = { 好球: 'call_strike', 壞球: 'call_ball', 揮棒落空: 'call_swing', 界外球: 'call_foul', 三振: 'call_k', 保送: 'call_bb', 安全上壘: 'call_safe', 出局: 'call_out', 全壘打: 'call_hr' };

export function buildGameUI(root) {
  root.insertAdjacentHTML(
    'beforeend',
    `<div class="tc-stick" data-lay="stick"><i></i></div>
     <button type="button" class="tc-main" data-lay="mainBtn"></button>
     <div class="pitch-menu" data-lay="pitchMenu"></div>
     <div class="hint" data-lay="hint"></div>
     <div class="bat-help"></div>
     <div class="swing-fb"></div>
     <div class="swing-now">揮！</div>
     <div class="pitch-info" data-lay="pitchInfo"></div>
     <div class="call" id="call"></div>
     <div class="banner" data-lay="banner"><small></small><b></b><span></span></div>
     <div class="final" id="final"></div>`,
  );
  const elMenu = root.querySelector('.pitch-menu');
  const elHint = root.querySelector('.hint');
  const elHelp = root.querySelector('.bat-help');
  const elFb = root.querySelector('.swing-fb');
  const elNow = root.querySelector('.swing-now');
  const elInfo = root.querySelector('.pitch-info');
  const elCall = root.querySelector('.call');
  const elBanner = root.querySelector('.banner');
  const elFinal = root.querySelector('.final');
  const dip = document.getElementById('dip');
  let pick = () => {};
  // ── 觸控操作（手機）：左下搖桿瞄準、右下主按鈕。網址加 ?touch=1 可在電腦上強制開啟來測試 ──
  const touchParam = new URLSearchParams(location.search).get('touch');
  const touch = touchParam === '1' || (touchParam !== '0' && matchMedia('(pointer: coarse)').matches);
  document.body.classList.toggle('touch', touch);
  const elStick = root.querySelector('.tc-stick');
  const elKnob = elStick.querySelector('i');
  const elMain = root.querySelector('.tc-main');
  const stick = { x: 0, y: 0, id: null };
  let mainPress = () => {};
  const dragging = () => document.body.classList.contains('dev-drag'); // DEV 拖曳版面時不當成操作
  function stickMove(e) {
    const r = elStick.getBoundingClientRect();
    const R = r.width / 2;
    let dx = (e.clientX - (r.left + R)) / R;
    let dy = (e.clientY - (r.top + R)) / R;
    const d = Math.hypot(dx, dy);
    if (d > 1) {
      dx /= d;
      dy /= d;
    }
    stick.x = dx;
    stick.y = -dy; // 往上推是正的
    elKnob.style.translate = `${dx * 30}% ${dy * 30}%`;
  }
  function stickEnd(e) {
    if (e.pointerId !== stick.id) return;
    stick.id = null;
    stick.x = stick.y = 0;
    elKnob.style.translate = '0 0';
  }
  elStick.addEventListener('pointerdown', (e) => {
    if (dragging()) return;
    e.preventDefault();
    stick.id = e.pointerId;
    elStick.setPointerCapture(e.pointerId);
    stickMove(e);
  });
  elStick.addEventListener('pointermove', (e) => e.pointerId === stick.id && stickMove(e));
  elStick.addEventListener('pointerup', stickEnd);
  elStick.addEventListener('pointercancel', stickEnd);
  elMain.addEventListener('pointerdown', (e) => {
    if (dragging()) return;
    e.preventDefault();
    mainPress();
  });
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
    touch,
    // 搖桿目前的方向（-1～1；沒在推是 0）
    stick: () => stick,
    onMainPress(fn) {
      mainPress = fn;
    },
    // 觸控操作的顯示與主按鈕文字（label 為空字串＝隱藏）
    touchControls(label) {
      const show = touch && !!label;
      elStick.classList.toggle('show', show);
      elMain.classList.toggle('show', show);
      if (show && elMain.textContent !== label) elMain.textContent = label;
    },
    // list 為 null 時隱藏；maxKmh 有給的話每個球種顯示球速
    pitchMenu(list, sel, maxKmh) {
      elMenu.classList.toggle('show', !!list);
      if (!list) return;
      elMenu.innerHTML =
        '<div class="pm-head">球種<span>按 1–4 選擇　字母＝拿手程度（A 最強）</span></div>' +
        list
          .map(([name, g], i) => {
            const d = PITCHES[name];
            const tag = d.speed >= 0.95 ? '速球' : Math.abs(d.by) > 0.3 ? '下墜' : '橫移';
            const kmh = maxKmh ? `<small>${Math.round(maxKmh * d.speed)} km/h</small>` : '';
            return `<div class="pm-row ${i === sel ? 'on' : ''}" data-i="${i}"><kbd>${i + 1}</kbd><b>${name}</b><em>${tag}</em><i class="g g-${g}">${g}</i>${kmh}</div>`;
          })
          .join('');
    },
    hint(text) {
      elHint.textContent = text;
      elHint.classList.toggle('show', !!text);
    },
    // 打擊的操作說明（兩個步驟），打擊時固定顯示
    batHelp(show) {
      if (show && !elHelp.innerHTML) {
        elHelp.innerHTML = `
          <div class="bh-title">你的打擊</div>
          <div class="bh-step"><i>1</i><span><b>${touch ? '推左下搖桿' : '移動滑鼠'}</b>　把<em class="y">黃圈</em>對準<em class="o">橘色落點</em>，對到會變<em class="g">綠色</em></span></div>
          <div class="bh-step"><i>2</i><span>${touch ? '<b>按右下「揮棒」</b>' : '<b>點擊</b> 或 <kbd>空白鍵</kbd>'}　橘圈縮到最小、變<em class="g">綠色</em>時揮棒</span></div>`;
      }
      elHelp.classList.toggle('show', !!show);
    },
    // 「現在揮！」的提示
    swingNow(on) {
      elNow.classList.toggle('show', !!on);
    },
    // 揮棒後的回饋：時機與位置
    feedback(text, tone) {
      elFb.textContent = text;
      elFb.dataset.tone = tone || '';
      retrigger(elFb, 'show');
    },
    pitchInfo(text) {
      elInfo.textContent = text;
      retrigger(elInfo, 'show');
      clearTimeout(infoTimer);
      infoTimer = setTimeout(() => elInfo.classList.remove('show'), 1800);
    },
    call(text, kind) {
      // 判決用畫好的立體美術字（public/ui/call_*.webp）；「二壘出局」這種前面多一個壘名的，壘名用小字放在上面
      const art = CALL_ART[text] || (text.endsWith('出局') ? 'call_out' : null);
      if (art) {
        const pre = art === 'call_out' && text !== '出局' ? `<small>${text.replace('出局', '')}</small>` : '';
        elCall.innerHTML = `${pre}<img src="ui/${art}.webp" alt="${text}">`;
        elCall.querySelector('img').onerror = () => (elCall.textContent = text); // 圖載不到就退回文字
      } else elCall.textContent = text;
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
      elBanner.classList.toggle('hr', title === '全壘打');
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
          <div class="p-kicker">FINAL · 比賽結束${S.inning > S.regulation ? ` · 延長至第 ${S.inning} 局` : ''}</div>
          <h2>${verdict}</h2>
          ${row(away, 0)}${row(home, 1)}
          <button type="button" id="again">再來一場</button>
        </div>`;
      elFinal.classList.add('show');
      elFinal.querySelector('#again').addEventListener('click', () => location.reload());
    },
  };
}
