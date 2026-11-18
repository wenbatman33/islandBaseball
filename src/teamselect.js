// 開場：標題畫面（主視覺插畫）→ 對決畫面（選自己的球隊與對手）→ 開賽。
// 對決畫面左格是你的球隊（主隊、後攻）、右格是對手（客隊），兩格各放那一隊的故事插畫。
// 下方選隊：先點「你的球隊」或「對手」決定要換哪一邊，再點球隊。
// 網址帶 ?home=<id>&away=<id> 會直接開賽、兩個畫面都不顯示（測試或分享連結用）。
import { TEAMS, emblemHTML } from './data.js';

const KEY = 'island.matchup';

function titleScreen() {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.id = 'title-screen';
    el.innerHTML = `
      <img class="tt-art" src="title.jpg" alt="">
      <i class="tt-flare"></i><i class="tt-dust"></i><i class="tt-shade"></i>
      <div class="tt-logo">
        <img class="tt-mark" src="logo.png" alt="島嶼職棒 ISLAND LEAGUE BASEBALL">
        <span class="tt-year">2026　例行賽開打</span>
      </div>
      <button class="tt-start">點一下開始<small>PRESS START</small></button>`;
    document.body.appendChild(el);
    const go = () => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 450);
      resolve();
    };
    el.addEventListener('click', go, { once: true });
    window.addEventListener('keydown', function onKey(e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      window.removeEventListener('keydown', onKey);
      if (el.isConnected && !el.classList.contains('out')) go();
    });
  });
}

function versusScreen() {
  const has = (id) => TEAMS.some((t) => t.id === id);
  let last = {};
  try {
    last = JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch (e) {
    /* 沒有上次的選擇 */
  }
  return new Promise((resolve) => {
    const pick = { home: has(last.home) ? last.home : 'leopards', away: has(last.away) ? last.away : 'whales' };
    if (pick.home === pick.away) pick.away = TEAMS.find((t) => t.id !== pick.home).id;
    let side = 'home'; // 現在點球隊會換掉哪一邊
    const team = (id) => TEAMS.find((t) => t.id === id);
    const el = document.createElement('div');
    el.id = 'team-select';
    el.innerHTML = `
      <div class="vs-panel you" data-side="home"><div class="vs-art"><img alt=""></div></div>
      <div class="vs-panel foe" data-side="away"><div class="vs-art"><img alt=""></div></div>
      <header class="vs-top"><span class="ts-league">◆ ISLAND <b>LEAGUE</b></span><span class="vs-title">選擇對戰組合</span><span class="vs-game">例行賽　GAME 22</span></header>
      <section class="vs-side you" data-side="home"></section>
      <section class="vs-side foe" data-side="away"></section>
      <div class="vs-mark"><b>VS</b></div>
      <div class="vs-cmp"></div>
      <footer class="vs-foot">
        <div class="vs-tabs"><button data-side="home">你的球隊</button><button data-side="away">對手</button></div>
        <div class="vs-chips"></div>
        <button class="vs-go">PLAY BALL<small>開賽</small></button>
      </footer>`;
    document.body.appendChild(el);

    const sideHTML = (t, who) => `
      <div class="vs-info">
        <span class="vs-tag">${who === 'home' ? 'HOME　你的球隊' : 'AWAY　對手'}</span>
        <div class="vs-name">${emblemHTML(t, 'big')}<h2>${t.name}</h2></div>
        <div class="vs-rec">${t.record}<i>OVR <b>${t.ovr}</b></i></div>
      </div>
      <p class="vs-line">「${t.line}」</p>`;
    const bar = (label, a, b, fa, fb) => {
      const lo = Math.min(a, b) * 0.86;
      const w = (v) => Math.max(8, ((v - lo) / (Math.max(a, b) - lo)) * 100);
      return `<div class="vs-row"><em class="${a >= b ? 'win' : ''}">${fa}</em><span class="l"><i style="width:${w(a)}%"></i></span><b>${label}</b><span class="r"><i style="width:${w(b)}%"></i></span><em class="${b >= a ? 'win' : ''}">${fb}</em></div>`;
    };
    const render = (changed) => {
      const h = team(pick.home);
      const a = team(pick.away);
      el.style.setProperty('--you1', h.c1);
      el.style.setProperty('--you2', h.c2);
      el.style.setProperty('--foe1', a.c1);
      el.style.setProperty('--foe2', a.c2);
      for (const [who, t] of [['home', h], ['away', a]]) {
        const box = el.querySelector(`.vs-side[data-side="${who}"]`);
        if (changed && changed !== 'both' && changed !== who && box.innerHTML) continue; // 沒換的那一邊不重播進場動畫
        box.innerHTML = sideHTML(t, who);
        const img = el.querySelector(`.vs-panel[data-side="${who}"] img`);
        img.src = t.art;
        img.classList.remove('in');
        void img.offsetWidth;
        img.classList.add('in');
      }
      el.querySelectorAll('.vs-side, .vs-panel').forEach((s) => s.classList.toggle('on', s.dataset.side === side));
      el.querySelector('.vs-cmp').innerHTML =
        bar('整體', h.ovr, a.ovr, h.ovr, a.ovr) +
        bar('打擊率', +h.teamAvg, +a.teamAvg, h.teamAvg, a.teamAvg) +
        bar(`王牌`, h.sp.ovr, a.sp.ovr, `${h.sp.name} ${h.sp.ovr}`, `${a.sp.ovr} ${a.sp.name}`) +
        bar('第四棒', h.lineup[3].ovr, a.lineup[3].ovr, `${h.lineup[3].name} ${h.lineup[3].ovr}`, `${a.lineup[3].ovr} ${a.lineup[3].name}`);
      el.querySelectorAll('.vs-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.side === side));
      el.querySelector('.vs-chips').innerHTML = TEAMS.map((t) => {
        const cls = t.id === pick.home ? 'you' : t.id === pick.away ? 'foe' : '';
        return `<button class="vs-chip ${cls}" data-id="${t.id}" style="--c1:${t.c1};--c2:${t.c2}">${emblemHTML(t)}<b>${t.short}</b><em>${t.record.replace(' 勝 ', '-').replace(' 敗', '')}</em></button>`;
      }).join('');
      if (changed) {
        // VS 再撞一次
        const m = el.querySelector('.vs-mark');
        m.classList.remove('hit');
        void m.offsetWidth;
        m.classList.add('hit');
      }
    };
    el.addEventListener('click', (e) => {
      const chip = e.target.closest('.vs-chip');
      if (chip) {
        const id = chip.dataset.id;
        const other = side === 'home' ? 'away' : 'home';
        if (pick[side] === id) return;
        let changed = side;
        if (pick[other] === id) {
          pick[other] = pick[side]; // 點到另一邊的球隊：兩邊對調
          changed = 'both';
        }
        pick[side] = id;
        render(changed);
        return;
      }
      if (e.target.closest('.vs-go')) {
        try {
          localStorage.setItem(KEY, JSON.stringify(pick));
        } catch (err) {
          /* 存不了就算了 */
        }
        el.classList.add('out');
        setTimeout(() => el.remove(), 380);
        resolve(pick);
        return;
      }
      const s = e.target.closest('[data-side]');
      if (s) {
        side = s.dataset.side;
        render();
      }
    });
    render();
    el.querySelector('.vs-mark').classList.add('hit');
  });
}

export async function chooseTeams() {
  const q = new URLSearchParams(location.search);
  const has = (id) => TEAMS.some((t) => t.id === id);
  if (has(q.get('home')) || has(q.get('away'))) return { home: q.get('home'), away: q.get('away') };
  await titleScreen();
  return versusScreen();
}
