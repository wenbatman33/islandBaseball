// 開場：標題畫面（主視覺插畫）→ 對決畫面（選自己的球隊與對手）→ 開賽。
// 對決畫面左格是你的球隊（主隊、後攻）、右格是對手（客隊），兩格各放那一隊的故事插畫。
// 下方選隊：先點「你的球隊」或「對手」決定要換哪一邊，再點球隊。
// 網址帶 ?home=<id>&away=<id> 會直接開賽、兩個畫面都不顯示（測試或分享連結用）。
import { TEAMS, emblemHTML } from './data.js';
import storyManifest from '../scripts/story_manifest.json';

// 球隊故事（文字與圖卡共用同一份清單）
const STORIES = Object.fromEntries(storyManifest.items.map((x) => [x.id, x]));

const KEY = 'island.matchup';

function titleScreen() {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.id = 'title-screen';
    el.innerHTML = `
      <img class="tt-art" src="title.jpg" alt="">
      <i class="tt-flare"></i><i class="tt-dust"></i><i class="tt-shade"></i>
      <div class="tt-logo">
        <img class="tt-mark" src="logo.webp" alt="島嶼職棒 ISLAND LEAGUE BASEBALL">
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
      <header class="vs-top"><span class="vs-title">選擇對戰組合</span></header>
      <section class="vs-side you" data-side="home"></section>
      <section class="vs-side foe" data-side="away"></section>
      <div class="vs-mark"><img src="ui/vs.webp" alt="VS"></div>
      <div class="vs-dock">
        <div class="vs-cmp"><span class="vs-cmp-title">戰力對決</span><div class="vs-rows"></div></div>
        <footer class="vs-foot">
          <div class="vs-tabs"><button data-side="home">你的球隊</button><button data-side="away">對手</button></div>
          <div class="vs-chips"></div>
          <button class="vs-go"><img src="ui/playball.webp" alt="PLAY BALL"><small>開賽</small></button>
        </footer>
      </div>`;
    document.body.appendChild(el);

    // 每一隊的資訊收成一塊名牌：隊徽、身分、隊名、戰績與整體評價；台詞貼在名牌下面
    const sideHTML = (t, who) => `
      <div class="vs-plate">
        ${emblemHTML(t, 'big')}
        <div class="vs-plate-txt">
          <span class="vs-role">${who === 'home' ? '你的球隊　HOME' : '對手　AWAY'}</span>
          <h2>${t.name}</h2>
          <div class="vs-meta"><span>${t.record}</span><i>OVR<b>${t.ovr}</b></i></div>
        </div>
      </div>
      <p class="vs-line">「${t.line}」</p>
      <button type="button" class="vs-story" data-story="${t.id}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5c3-1.4 6-1.4 9 .4 3-1.8 6-1.8 9-.4v13.5c-3-1.3-6-1.3-9 .5-3-1.8-6-1.8-9-.5z M12 5.4v13.6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"/></svg>看球隊故事<i>›</i></button>`;
    // 拉鋸條：兩隊在同一條上互推，差距越大推得越過去；交界處有火花。scale＝差多少算壓倒性
    const bar = (label, a, b, fa, fb, scale) => {
      const pct = Math.min(86, Math.max(14, 50 + ((a - b) / scale) * 36));
      return `<div class="vs-row"><em class="l ${a >= b ? 'win' : ''}">${fa}</em>
        <div class="vs-tug"><i class="l" style="width:${pct}%"></i><i class="r"></i><u style="left:${pct}%"></u><b>${label}</b></div>
        <em class="r ${b >= a ? 'win' : ''}">${fb}</em></div>`;
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
      el.querySelector('.vs-rows').innerHTML =
        bar('整體', h.ovr, a.ovr, h.ovr, a.ovr, 10) +
        bar('打擊', +h.teamAvg, +a.teamAvg, h.teamAvg, a.teamAvg, 0.02) +
        bar('王牌', h.sp.ovr, a.sp.ovr, h.sp.ovr, a.sp.ovr, 10);
      el.querySelectorAll('.vs-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.side === side));
      el.querySelector('.vs-chips').innerHTML = TEAMS.map((t) => {
        const cls = t.id === pick.home ? 'you' : t.id === pick.away ? 'foe' : '';
        return `<button class="vs-chip ${cls}" data-id="${t.id}" style="--c1:${t.c1};--c2:${t.c2}"><span class="vs-chip-win">${emblemHTML(t)}<em>${t.record.replace(' 勝 ', '-').replace(' 敗', '')}</em></span><b>${t.short}</b></button>`;
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
      const st = e.target.closest('[data-story]');
      if (st) return storyScreen(st.dataset.story);
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

// 球隊故事頁：左邊（手機在上面）是故事插畫，右邊是隊徽、隊名、故事與重點人物；可以左右切換八隊
function storyScreen(id) {
  const el = document.createElement('div');
  el.className = 'team-story';
  const show = (tid) => {
    const t = TEAMS.find((x) => x.id === tid);
    const m = STORIES[tid];
    const [pos, star] = m.star.split(' ');
    el.dataset.id = tid;
    el.style.setProperty('--c1', t.c1);
    el.style.setProperty('--c2', t.c2);
    el.innerHTML = `
      <div class="ts-art"><img src="teams/story/${tid}.jpg" alt="${t.name}的球隊故事"></div>
      <div class="ts-text">
        <header class="ts-head">${emblemHTML(t, 'big')}<div><small>TEAM STORY　球隊故事</small><h2>${t.name}</h2><span>${m.place}</span></div></header>
        <b class="ts-tag">${m.style_tag}</b>
        <p class="ts-story">${m.story}</p>
        <p class="ts-line">「${t.line}」</p>
        <div class="ts-people">
          <div><span>招牌球員</span><b>${star}</b><i>${pos}</i></div>
          <div><span>王牌投手</span><b>${m.ace}</b><i>本季 ${t.record}</i></div>
        </div>
        <nav class="ts-nav"><button type="button" data-go="-1">‹ 上一隊</button><button type="button" data-go="1">下一隊 ›</button></nav>
      </div>
      <button type="button" class="ts-close" aria-label="關閉">✕</button>`;
  };
  const close = () => {
    window.removeEventListener('keydown', onKey, true);
    el.classList.add('out');
    setTimeout(() => el.remove(), 250);
  };
  const step = (d) => {
    const i = TEAMS.findIndex((x) => x.id === el.dataset.id);
    show(TEAMS[(i + d + TEAMS.length) % TEAMS.length].id);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
    else return;
    e.stopPropagation();
    e.preventDefault();
  };
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    const go = e.target.closest('[data-go]');
    if (go) step(+go.dataset.go);
    else if (e.target.closest('.ts-close')) close();
  });
  window.addEventListener('keydown', onKey, true);
  show(id);
  document.body.appendChild(el);
}

export async function chooseTeams() {
  const q = new URLSearchParams(location.search);
  const has = (id) => TEAMS.some((t) => t.id === id);
  if (has(q.get('home')) || has(q.get('away'))) return { home: q.get('home'), away: q.get('away') };
  await titleScreen();
  return versusScreen();
}
