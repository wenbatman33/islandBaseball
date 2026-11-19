import { emblemHTML } from './data.js';

// 比賽畫面的 HUD：記分條、投手資訊、打者資訊卡（由比賽狀態即時更新）
export function buildHud(root) {
  root.insertAdjacentHTML(
    'beforeend',
    // 外面多包兩層：電腦與手機橫向時這兩層不佔版面（display: contents），三塊各自定位；
    // 手機直式時變成頂端的一整塊面板（上排記分、下排打者對投手）
    `<div class="hud-top">
       <div class="scorebug" data-lay="scorebug"></div>
       <div class="hud-duel">
         <div class="batter-card" data-lay="batterCard"></div>
         <i class="hud-vs">VS</i>
         <div class="pitcher-chip" data-lay="pitcherChip"></div>
       </div>
     </div>`,
  );
  const elBug = root.querySelector('.scorebug');
  const elPit = root.querySelector('.pitcher-chip');
  const elBat = root.querySelector('.batter-card');
  const chip = (t) => emblemHTML(t, 'sm');
  const dots = (n, on) => Array.from({ length: n }, (_, i) => `<i class="${i < on ? 'on' : ''}"></i>`).join('');

  function render({ S, away, home, batter, batTeam, order, today, pitcher, fldTeam, pitchCount, lastPitch, energy = 100, rattle = 0 }) {
    elBug.innerHTML = `
      <div class="sb-teams">
        <div class="sb-team ${S.half === 0 ? 'bat' : ''}">${chip(away)}<b>${away.short}</b><em>${S.score[0]}</em></div>
        <div class="sb-team ${S.half === 1 ? 'bat' : ''}">${chip(home)}<b>${home.short}</b><em>${S.score[1]}</em></div>
      </div>
      <div class="sb-inn"><span>${S.half === 0 ? '▲' : '▼'}</span><b>${S.inning}</b><small>局</small></div>
      <div class="sb-bases"><i class="b2 ${S.bases[1] ? 'on' : ''}"></i><i class="b3 ${S.bases[2] ? 'on' : ''}"></i><i class="b1 ${S.bases[0] ? 'on' : ''}"></i></div>
      <div class="sb-count">
        <div><span>B</span>${dots(3, S.balls)}</div>
        <div><span>S</span>${dots(2, S.strikes)}</div>
        <div><span>O</span>${dots(2, S.outs)}</div>
      </div>`;

    // 投手資訊：名字下面一條體力條（一半以下變橘、四分之一以下變紅），混亂時整塊閃、掛上「混亂」
    const en = Math.round(energy);
    elPit.classList.toggle('rattled', !!rattle);
    elPit.innerHTML = `
      <span class="face sm" style="--c1:${fldTeam.c1};--c2:${fldTeam.c2}"><img src="${pitcher.face}" alt=""></span>
      <div class="pc-main"><small>投手 · ${pitcher.hand}${rattle ? '<i class="pc-rattle">混亂</i>' : ''}</small><b>${pitcher.name}</b>
        <span class="pc-en ${en < 25 ? 'low' : en < 50 ? 'mid' : ''}" title="體力 ${en}"><u><s style="width:${en}%"></s></u><em>${en}</em></span></div>
      <div class="pc-num"><b>${pitchCount}</b><small>球數</small></div>
      <div class="pc-last">${lastPitch || '—'}</div>`;

    elBat.style.visibility = batter ? 'visible' : 'hidden';
    if (batter) {
      elBat.innerHTML = `
        <span class="face lg" style="--c1:${batTeam.c1};--c2:${batTeam.c2}"><img src="${batter.face}" alt=""><i>${batter.no}</i></span>
        <div class="bc-name">
          <small>NOW BATTING · 第 ${order} 棒</small>
          <b>${batter.name}</b>
          <span>${batter.pos} · ${batter.bats}打 · ${batTeam.name}</span>
        </div>
        <div class="bc-stat"><small>打擊率</small><b>${batter.avg}</b></div>
        <div class="bc-stat"><small>全壘打</small><b>${batter.hr}</b></div>
        <div class="bc-stat"><small>打點</small><b>${batter.rbi}</b></div>
        <div class="bc-stat today"><small>今日</small><b>${today.ab}-${today.h}</b></div>`;
    }
  }
  return { render };
}
