import { emblemHTML } from './data.js';

import { PITCHES } from './data.js';

// 玩法相關的畫面元件：球種選單、操作提示、判決文字、結果橫幅、終場畫面
// 判決文字 → 美術字素材
const CALL_ART = { 好球: 'call_strike', 壞球: 'call_ball', 揮棒落空: 'call_swing', 界外球: 'call_foul', 三振: 'call_k', 保送: 'call_bb', 安全上壘: 'call_safe', 出局: 'call_out', 全壘打: 'call_hr', 投手亂了: 'call_rattled' };

export function buildGameUI(root) {
  root.insertAdjacentHTML(
    'beforeend',
    `<div class="tc-stick" data-lay="stick"><i></i></div>
     <button type="button" class="tc-main" data-lay="mainBtn"></button>
     <div class="pitch-menu" data-lay="pitchMenu"></div>
     <button type="button" class="pen-btn" data-lay="penBtn"></button>
     <div class="bullpen"></div>
     <div class="arm-warn" data-lay="armWarn"></div>
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
  const elPen = root.querySelector('.pen-btn');
  const elBullpen = root.querySelector('.bullpen');
  const elWarn = root.querySelector('.arm-warn');
  let penOpen = () => {};
  let penPick = () => {};
  elPen.addEventListener('pointerdown', (e) => {
    if (document.body.classList.contains('dev-drag')) return;
    e.preventDefault();
    penOpen();
  });
  elBullpen.addEventListener('click', (e) => {
    const c = e.target.closest('[data-k]');
    if (c) penPick(c.dataset.k === 'x' ? null : +c.dataset.k);
  });
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
    // 投手狀態警示（輪到玩家投球時才顯示）：kind＝'' 不顯示、'tired' 體力過半、'spent' 快沒力、'rattled' 混亂
    armWarn(kind, canChange) {
      if (elWarn.dataset.kind === kind && elWarn.dataset.c === String(!!canChange)) return;
      elWarn.dataset.kind = kind;
      elWarn.dataset.c = String(!!canChange);
      elWarn.classList.toggle('show', !!kind);
      if (!kind) return;
      const msg = {
        tired: ['投手累了', '球速變慢、控球變差'],
        spent: ['投手快沒力了', '球速大幅下降，隨時可能亂掉'],
        rattled: ['投手混亂中', '準星會亂晃、球不受控制，拿到出局數才會恢復'],
      }[kind];
      elWarn.innerHTML = `<b>${msg[0]}</b><span>${msg[1]}</span>${canChange ? `<em>${touch ? '點右邊「換投手」' : '按 P 換投手'}</em>` : ''}`;
    },
    onPenOpen(fn) {
      penOpen = fn;
    },
    // 「換投手」按鈕：n＝牛棚還有幾個人（0＝不顯示）
    penButton(n) {
      const show = n > 0;
      if (elPen.classList.contains('show') !== show) elPen.classList.toggle('show', show);
      if (show && elPen.dataset.n !== String(n)) {
        elPen.dataset.n = n;
        elPen.innerHTML = `換投手<small>牛棚 ${n} 人${touch ? '' : '　按 P'}</small>`;
      }
    },
    // 牛棚選單：list 為 null 時關閉。cur＝目前投手的狀態（顯示他還剩多少體力）
    bullpen(list, cur, cb) {
      elBullpen.classList.toggle('show', !!list);
      if (!list) return;
      penPick = cb;
      const pct = Math.round(cur.energy);
      elBullpen.innerHTML = `
        <div class="bp-box">
          <img class="seg-head" src="ui/head_bullpen.webp" alt="更換投手" onerror="this.remove()">
          <div class="bp-cur">目前投手　<b>${cur.p.name}</b><span class="bp-en ${pct < 25 ? 'low' : pct < 50 ? 'mid' : ''}"><u><s style="width:${pct}%"></s></u>體力 ${pct}</span>${cur.rattle ? '<i>混亂中</i>' : ''}</div>
          <div class="bp-list">${list.map((p, i) => `
            <button type="button" class="bp-card" data-k="${i}">
              <span class="face lg"><img src="${p.face}" alt=""><i>${p.no}</i></span>
              <b>${p.name}</b>
              <small>${p.hand}　OVR <em>${p.ovr}</em></small>
              <dl><div><dt>體力</dt><dd>${p.stamina}</dd></div><div><dt>控球</dt><dd>${p.control}</dd></div><div><dt>球威</dt><dd>${p.stuff}</dd></div><div><dt>最快</dt><dd>${p.maxKmh}</dd></div></dl>
              <span class="bp-pitches">${p.pitches.map(([n, g]) => `<span>${n}<b class="g g-${g}">${g}</b></span>`).join('')}</span>
            </button>`).join('')}</div>
          <button type="button" class="bp-cancel" data-k="x">先不換</button>
        </div>`;
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
    // 賽後畫面：依玩家那一隊（user：0 客隊、1 主隊）贏、輸或平手，放那一隊的賽後插畫、結果的美術字與逐局比分
    final({ S, away, home, user = 1 }) {
      const teams = [away, home];
      const mine = teams[user];
      const d = S.score[user] - S.score[1 - user];
      const outcome = d > 0 ? 'win' : d < 0 ? 'lose' : 'tie';
      const art = outcome === 'tie' ? 'teams/result/tie.jpg' : `teams/result/${outcome}_${mine.id}.jpg`;
      const word = { win: '勝利！', lose: '惜敗', tie: '平手' }[outcome];
      const say = {
        win: `${mine.name}拿下這場勝利！`,
        lose: `${teams[1 - user].name}帶走勝利，下一場討回來。`,
        tie: '雙方握手言和，勝負留到下次再分。',
      }[outcome];
      const n = Math.max(S.regulation || 0, S.lines[0].length, S.lines[1].length);
      const cells = (i) => Array.from({ length: n }, (_, k) => `<td>${S.lines[i][k] ?? (k < S.inning ? 0 : '')}</td>`).join('');
      const row = (t, i) => `
        <tr class="${S.score[i] > S.score[1 - i] ? 'win' : ''} ${i === user ? 'me' : ''}">
          <th>${emblemHTML(t)}<b>${t.name}</b>${i === user ? '<i>你</i>' : ''}</th>${cells(i)}<td class="r">${S.score[i]}</td><td>${S.hits[i]}</td>
        </tr>`;
      elFinal.innerHTML = `
        <div class="result ${outcome}" style="--c1:${mine.c1};--c2:${mine.c2}">
          <img class="rs-art" src="${art}" alt="">
          <i class="rs-fx"></i>
          <img class="rs-word" src="ui/result_${outcome}.webp" alt="${word}">
          <div class="rs-board">
            <div class="rs-kicker">FINAL　比賽結束${S.inning > (S.regulation || n) ? `　延長至第 ${S.inning} 局` : ''}</div>
            <table>
              <thead><tr><th></th>${Array.from({ length: n }, (_, k) => `<td>${k + 1}</td>`).join('')}<td class="r">R</td><td>H</td></tr></thead>
              <tbody>${row(away, 0)}${row(home, 1)}</tbody>
            </table>
            <p>${say}</p>
          </div>
          <div class="rs-btns"><button type="button" id="again">再戰一場</button><button type="button" id="reselect">重選球隊</button></div>
        </div>`;
      // 這一隊的賽後插畫還沒有的話，退回用對決畫面那張故事插畫
      const img = elFinal.querySelector('.rs-art');
      img.onerror = () => {
        img.onerror = null;
        img.src = mine.art;
      };
      const wordImg = elFinal.querySelector('.rs-word');
      wordImg.onerror = () => wordImg.replaceWith(Object.assign(document.createElement('h2'), { className: 'rs-word', textContent: word }));
      elFinal.classList.add('show');
      const go = (keepTeams) => {
        const q = new URLSearchParams(location.search);
        q.delete('end');
        q.delete('home');
        q.delete('away');
        if (keepTeams) {
          q.set('home', home.id);
          q.set('away', away.id);
        }
        location.search = q.toString();
      };
      elFinal.querySelector('#again').addEventListener('click', () => go(true));
      elFinal.querySelector('#reselect').addEventListener('click', () => go(false));
    },
  };
}
