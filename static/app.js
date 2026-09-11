'use strict';

/* ------------------------------- helpers ---------------------------------- */

const $ = (sel) => document.querySelector(sel);
const nf = new Intl.NumberFormat('ru-RU');
const fmt = (n) => (n == null ? '—' : nf.format(n));
const pct = (n, d = 1) => (n == null ? '—' : n.toFixed(d) + '%');

function winRate(w, l, d) {
  const total = w + l + d;
  return total ? ((w + 0.5 * d) / total * 100) : 0;
}

function flagEmoji(cc) {
  if (!cc || cc.length !== 2) return '';
  return String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 127397 + c.charCodeAt(0)));
}

function countryFromUrl(countryUrl) {
  if (!countryUrl) return '';
  const seg = countryUrl.split('/').filter(Boolean).pop() || '';
  return seg.length === 2 ? seg : '';
}

function fmtDate(ts) {
  if (!ts) return '—';
  const d = ts > 1e12 ? new Date(ts) : new Date(ts * 1000);
  return d.toLocaleDateString('ru-RU', { year: 'numeric', month: 'long', day: 'numeric' });
}

function fmtDateShort(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function analysisLink(url) {
  if (!url) return '';
  const m = String(url).match(/chess\.com\/live\/game\/(\d+)/);
  if (m) return 'https://www.chess.com/analysis/game/live/' + m[1];
  return url;
}

function linearRegression(points) {
  const n = points.length;
  if (n < 2) return null;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (const p of points) { sx += p.x; sy += p.y; sxy += p.x * p.y; sxx += p.x * p.x; }
  const denom = n * sxx - sx * sx;
  if (!denom) return null;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  return { slope, intercept };
}

function getGoal(username) {
  try { const v = localStorage.getItem('chessstats:goal:' + username); return v ? parseInt(v, 10) : null; } catch (_) { return null; }
}

function setGoal(username, v) {
  try { localStorage.setItem('chessstats:goal:' + username, String(v)); } catch (_) {}
}

const MODE_NAMES = {
  chess_rapid: 'Рапид',
  chess_blitz: 'Блиц',
  chess_bullet: 'Пуля',
  chess_daily: 'Ежедневные',
  chess960_daily: 'Шахматы 960'
};

const TIME_CLASS_NAMES = {
  bullet: 'Пуля', blitz: 'Блиц', rapid: 'Рапид', daily: 'Ежедневные',
  chess960: 'Шахматы 960', other: 'Прочее'
};

const COLORS = { win: '#3fb950', loss: '#f85149', draw: '#8b949e', white: '#60a5fa', black: '#f59e0b' };

// тёмные дефолты для Chart.js (подписи, сетка, шрифт)
if (window.Chart) {
  Chart.defaults.color = '#8b949e';
  Chart.defaults.borderColor = 'rgba(255,255,255,0.08)';
  Chart.defaults.font.family = "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
  Chart.defaults.font.size = 12;
}

/* ------------------------------ chart state ------------------------------- */

let charts = [];
let lastProfile = null;
let lastAnalysis = null;
function destroyCharts() { charts.forEach((c) => c.destroy()); charts = []; }
function makeChart(id, config) {
  const el = document.getElementById(id);
  if (!el) return null;
  const chart = new Chart(el, config);
  charts.push(chart);
  return chart;
}

/* ------------------------------ ui helpers -------------------------------- */

function showStatus(text) {
  $('#statusText').textContent = text;
  $('#status').hidden = false;
}
function hideStatus() { $('#status').hidden = true; }
function showError(text) {
  $('#errorBox').textContent = text;
  $('#errorBox').hidden = false;
}
function hideError() { $('#errorBox').hidden = true; }
function showResults() { $('#results').hidden = false; }

function exportReport() {
  const data = {
    exportedAt: new Date().toISOString(),
    profile: lastProfile,
    analysis: lastAnalysis
  };
  const name = (lastAnalysis && lastAnalysis.username) || (lastProfile && lastProfile.username) || 'report';
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'chess-stats-' + name + '.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
}
function hideResults() {
  $('#results').hidden = true;
  ['profileSection', 'ratingSection', 'summarySection', 'compareSection', 'tacticsSection', 'overviewSection', 'formSection', 'volumeSection', 'bestTimeSection', 'weaknessSection', 'strongPointsSection', 'stagesSection', 'strengthSection', 'openingsSection', 'repertoireSection', 'adviceSection', 'timeSection', 'opponentsSection', 'lostSection', 'recentSection', 'bestGamesSection']
    .forEach((id) => { $('#' + id).innerHTML = ''; });
}

/* -------------------------------- render ---------------------------------- */

function renderProfile(data) {
  const p = data.profile || {};
  const cc = countryFromUrl(p.country);
  const flag = flagEmoji(cc);
  const joined = p.joined ? fmtDate(p.joined) : '—';
  const lastOnline = p.last_online ? fmtDate(p.last_online) : '—';
  const title = (p.title || '').toUpperCase();

  const badges = [];
  if (title) badges.push(`<span class="badge text-bg-warning title-badge">${esc(title)}</span>`);
  if (p.verified) badges.push('<span class="badge text-bg-info">verified</span>');
  if (p.is_streamer) badges.push('<span class="badge text-bg-danger">стример</span>');
  if (p.status && p.status !== 'basic') badges.push(`<span class="badge text-bg-secondary">${esc(p.status)}</span>`);
  if (p.league) badges.push(`<span class="badge text-bg-secondary">${esc(p.league)}</span>`);

  const avatar = p.avatar ? esc(p.avatar.replace(/\?.*$/, '')) : '';
  const profileUrl = p.url ? esc(p.url) : ('https://www.chess.com/member/' + encodeURIComponent(data.username));

  $('#profileSection').innerHTML = `
    <div class="card shadow-sm">
      <div class="card-body d-flex flex-wrap gap-3 align-items-center">
        ${avatar ? `<img class="avatar" src="${avatar}" alt="avatar">` : ''}
        <div class="flex-grow-1">
          <h2 class="h5 mb-1">
            ${flag} ${esc(p.name || data.username)}
            <span class="text-muted fw-normal">(${esc(p.username || data.username)})</span>
          </h2>
          <div class="mb-1">${badges.join(' ')}</div>
          <div class="small text-muted">
            ${p.location ? '📍 ' + esc(p.location) + ' · ' : ''}
            Зарегистрирован: ${joined} · Онлайн: ${lastOnline} ·
            Подписчики: ${fmt(p.followers)}
          </div>
        </div>
        <div class="d-flex gap-2">
          <a class="btn btn-outline-secondary btn-sm" href="${profileUrl}" target="_blank" rel="noopener">Открыть профиль ↗</a>
          <button type="button" class="btn btn-outline-primary btn-sm" id="exportBtn">Скачать JSON</button>
        </div>
      </div>
    </div>`;

  const exportBtn = document.getElementById('exportBtn');
  if (exportBtn) exportBtn.addEventListener('click', exportReport);
}

function renderRatings(data) {
  const stats = data.stats || {};
  const modes = Object.keys(stats).filter((k) => /^chess/.test(k) && stats[k] && stats[k].last);

  if (!modes.length) {
    $('#ratingSection').innerHTML = '';
    return;
  }

  const cards = modes.map((k) => {
    const s = stats[k];
    const last = s.last && s.last.rating;
    const best = s.best && s.best.rating;
    const rec = s.record || {};
    const name = MODE_NAMES[k] || k.replace('chess_', '').replace('_', ' ');
    return `
      <div class="col-6 col-md-4 col-lg-3">
        <div class="card h-100 mode-card shadow-sm">
          <div class="card-body">
            <div class="mode-name text-muted mb-1">${esc(name)}</div>
            <div class="stat-big">${last == null ? '—' : nf.format(last)}</div>
            <div class="small text-muted mb-2">лучший: ${best == null ? '—' : nf.format(best)}</div>
            <div class="small">
              <span class="win fw-semibold">${fmt(rec.win)}</span> /
              <span class="loss fw-semibold">${fmt(rec.loss)}</span> /
              <span class="draw fw-semibold">${fmt(rec.draw)}</span>
              <span class="text-muted ms-1">W/L/D</span>
            </div>
          </div>
        </div>
      </div>`;
  }).join('');

  $('#ratingSection').innerHTML = `
    <div class="card shadow-sm">
      <div class="card-body">
        <h3 class="h6 text-muted text-uppercase mb-3">Рейтинги по контролю времени</h3>
        <div class="row g-3">${cards}</div>
      </div>
    </div>`;
}

function renderOverview(analysis) {
  const a = analysis;
  if (!a.total) {
    $('#overviewSection').innerHTML = `
      <div class="alert alert-info mb-0">За выбранный период партии не найдены.</div>`;
    return;
  }

  const whiteRate = winRate(a.asWhite.win, a.asWhite.loss, a.asWhite.draw);
  const blackRate = winRate(a.asBlack.win, a.asBlack.loss, a.asBlack.draw);

  const summaryCard = (label, color, value, sub) => `
    <div class="col-6 col-md-3">
      <div class="card h-100 shadow-sm">
        <div class="card-body">
          <div class="stat-label">${label}</div>
          <div class="stat-big ${color}">${value}</div>
          <div class="small text-muted">${sub}</div>
        </div>
      </div>
    </div>`;

  const sideCard = (name, s) => `
    <div class="col-md-6">
      <div class="card h-100 shadow-sm">
        <div class="card-body">
          <div class="h6 mb-2">${name} <span class="text-muted fw-normal small">(${fmt(s.total)} партий)</span></div>
          <div class="small mb-1">
            <span class="win fw-semibold">${fmt(s.win)}</span> /
            <span class="loss fw-semibold">${fmt(s.loss)}</span> /
            <span class="draw fw-semibold">${fmt(s.draw)}</span>
            <span class="text-muted ms-1">W/L/D</span>
          </div>
          <div class="h5">${pct(winRate(s.win, s.loss, s.draw))} <span class="text-muted small">очков</span></div>
          <div class="mini-bar"><span style="width:${winRate(s.win, s.loss, s.draw).toFixed(1)}%;background:#0d6efd"></span></div>
        </div>
      </div>
    </div>`;

  $('#overviewSection').innerHTML = `
    <div class="card shadow-sm mb-4">
      <div class="card-body">
        <div class="d-flex justify-content-between align-items-center flex-wrap gap-2 mb-3">
          <h3 class="h6 text-muted text-uppercase mb-0">Общая статистика</h3>
          <span class="small text-muted">партий проанализировано: <strong>${fmt(a.total)}</strong></span>
        </div>
        <div class="row g-3 mb-3">
          ${summaryCard('Всего партий', '', fmt(a.total), 'за выбранный период')}
          ${summaryCard('Побед', 'win', fmt(a.wins), pct(a.total ? a.wins / a.total * 100 : 0))}
          ${summaryCard('Поражений', 'loss', fmt(a.losses), pct(a.total ? a.losses / a.total * 100 : 0))}
          ${summaryCard('Очков (score)', '', pct(a.total ? (a.wins + 0.5 * a.draws) / a.total * 100 : 0), 'win% + 0.5·draw%')}
        </div>
        <div class="row g-3">
          ${sideCard('⚪ За белых', a.asWhite)}
          ${sideCard('⚫ За чёрных', a.asBlack)}
        </div>
      </div>
    </div>

    <div class="row g-3 mb-4">
      <div class="col-md-6">
        <div class="card h-100 shadow-sm">
          <div class="card-body">
            <h3 class="h6 text-muted text-uppercase mb-3">Результат</h3>
            <div class="chart-box"><canvas id="donutChart"></canvas></div>
          </div>
        </div>
      </div>
      <div class="col-md-6">
        <div class="card h-100 shadow-sm">
          <div class="card-body">
            <h3 class="h6 text-muted text-uppercase mb-3">Результаты за цвет</h3>
            <div class="chart-box"><canvas id="colorChart"></canvas></div>
          </div>
        </div>
      </div>
    </div>

    <div class="card shadow-sm mb-4">
      <div class="card-body">
        <div class="d-flex justify-content-between align-items-center flex-wrap gap-2 mb-2">
          <h3 class="h6 text-muted text-uppercase mb-0">Рейтинг по месяцам</h3>
          <div class="d-flex align-items-center gap-2">
            <label class="small text-muted mb-0" for="goalInput">Цель:</label>
            <input type="number" id="goalInput" class="form-control form-control-sm" style="width:110px" placeholder="напр. 1500" min="1">
          </div>
        </div>
        <div id="goalSummary" class="small text-muted mb-2"></div>
        <div class="chart-box" style="height:360px"><canvas id="ratingChart"></canvas></div>
      </div>
    </div>

    <div class="card shadow-sm mb-4">
      <div class="card-body">
        <h3 class="h6 text-muted text-uppercase mb-3">Форма по месяцам (очки, %)</h3>
        <div class="chart-box" style="height:280px"><canvas id="perfChart"></canvas></div>
      </div>
    </div>`;

  makeChart('donutChart', {
    type: 'doughnut',
    data: {
      labels: ['Победы', 'Поражения', 'Ничьи'],
      datasets: [{
        data: [a.wins, a.losses, a.draws],
        backgroundColor: [COLORS.win, COLORS.loss, COLORS.draw],
        borderWidth: 1
      }]
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
  });

  makeChart('colorChart', {
    type: 'bar',
    data: {
      labels: ['За белых', 'За чёрных'],
      datasets: [
        { label: 'Победы', data: [a.asWhite.win, a.asBlack.win], backgroundColor: COLORS.win },
        { label: 'Ничьи', data: [a.asWhite.draw, a.asBlack.draw], backgroundColor: COLORS.draw },
        { label: 'Поражения', data: [a.asWhite.loss, a.asBlack.loss], backgroundColor: COLORS.loss }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { x: { stacked: true }, y: { stacked: true } },
      plugins: { legend: { position: 'bottom' } }
    }
  });

  const labels = a.ratingHistory.map((r) => r.month);
  const whiteData = a.ratingHistory.map((r) => r.white);
  const blackData = a.ratingHistory.map((r) => r.black);
  const combined = a.ratingHistory.map((r) => (r.white != null && r.black != null ? Math.round((r.white + r.black) / 2) : (r.white != null ? r.white : r.black)));

  const ratingChart = makeChart('ratingChart', {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'За белых', data: whiteData, borderColor: COLORS.white, backgroundColor: COLORS.white, spanGaps: true, tension: .25 },
        { label: 'За чёрных', data: blackData, borderColor: COLORS.black, backgroundColor: COLORS.black, spanGaps: true, tension: .25 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { y: { beginAtZero: false } },
      plugins: { legend: { position: 'bottom' } }
    }
  });

  const pts = combined.map((y, i) => ({ x: i, y })).filter((p) => p.y != null);
  const trend = linearRegression(pts);
  if (trend && pts.length >= 2) {
    const t0 = trend.slope * pts[0].x + trend.intercept;
    const t1 = trend.slope * pts[pts.length - 1].x + trend.intercept;
    ratingChart.data.datasets.push({
      label: 'Тренд',
      data: labels.map((_, i) => (i === 0 ? t0 : i === labels.length - 1 ? t1 : null)),
      borderColor: '#6c757d', borderDash: [3, 3], pointRadius: 0, fill: false, spanGaps: true, tension: 0
    });
    ratingChart.update();
  }

  const goal = getGoal(a.username);
  if (goal) {
    ratingChart.data.datasets.push({ label: 'Цель', data: labels.map(() => goal), borderColor: '#dc3545', borderDash: [6, 4], pointRadius: 0, fill: false });
    ratingChart.update();
  }

  const goalInput = document.getElementById('goalInput');
  const goalSummary = document.getElementById('goalSummary');
  if (goalInput && goalSummary) {
    if (goal) goalInput.value = goal;
    const updateGoalSummary = () => {
      const g = getGoal(a.username);
      const cur = combined.length ? combined[combined.length - 1] : null;
      if (g && cur != null) {
        const diff = g - cur;
        goalSummary.textContent = 'Текущий: ~' + nf.format(cur) + ' · до цели: ' + (diff > 0 ? '+' + nf.format(diff) : 'достигнута ✅');
      } else if (trend) {
        goalSummary.textContent = 'Тренд: ' + (trend.slope >= 0 ? '+' : '') + trend.slope.toFixed(1) + ' очков/мес';
      } else {
        goalSummary.textContent = '';
      }
    };
    updateGoalSummary();
    goalInput.addEventListener('change', () => {
      const v = parseInt(goalInput.value, 10);
      setGoal(a.username, v > 0 ? v : '');
      let ds = ratingChart.data.datasets.find((d) => d.label === 'Цель');
      if (v > 0) {
        if (!ds) {
          ds = { label: 'Цель', data: labels.map(() => v), borderColor: '#dc3545', borderDash: [6, 4], pointRadius: 0, fill: false };
          ratingChart.data.datasets.push(ds);
        } else {
          ds.data = labels.map(() => v);
        }
      } else if (ds) {
        ratingChart.data.datasets = ratingChart.data.datasets.filter((d) => d !== ds);
      }
      ratingChart.update();
      updateGoalSummary();
    });
  }

  const perf = a.performanceByMonth || [];
  makeChart('perfChart', {
    type: 'bar',
    data: {
      labels: perf.map((p) => p.month),
      datasets: [
        { type: 'bar', label: 'Очки (%)', data: perf.map((p) => p.score), backgroundColor: perf.map((p) => p.score >= 50 ? COLORS.win : COLORS.loss) },
        { type: 'line', label: '50%', data: perf.map(() => 50), borderColor: '#8b949e', borderDash: [4, 4], pointRadius: 0, fill: false }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { y: { min: 0, max: 100 } },
      plugins: { legend: { display: false } }
    }
  });
}

function renderOpenings(analysis) {
  const openings = analysis.openings || [];
  if (!openings.length) {
    $('#openingsSection').innerHTML = '';
    return;
  }

  const top = openings.slice(0, 20);
  const rows = top.map((o, i) => {
    const rate = winRate(o.white.win + o.black.win, o.white.loss + o.black.loss, o.white.draw + o.black.draw);
    return `
      <tr>
        <td><a href="#" class="opening-link text-decoration-none" data-i="${i}"><span class="fw-semibold">${esc(o.name)}</span>${o.eco ? ` <span class="text-muted small">(${esc(o.eco)})</span>` : ''}</a></td>
        <td class="text-end">${fmt(o.total)}</td>
        <td class="text-end"><span class="win">${fmt(o.white.win + o.black.win)}</span></td>
        <td class="text-end"><span class="loss">${fmt(o.white.loss + o.black.loss)}</span></td>
        <td class="text-end"><span class="draw">${fmt(o.white.draw + o.black.draw)}</span></td>
        <td class="text-end fw-semibold">${pct(rate)}</td>
      </tr>`;
  }).join('');

  $('#openingsSection').innerHTML = `
    <div class="card shadow-sm">
      <div class="card-body">
        <h3 class="h6 text-muted text-uppercase mb-3">Дебюты (топ-${Math.min(20, openings.length)}) <span class="text-muted fw-normal small text-lowercase">— клик по дебюту для деталей</span></h3>
        <div class="chart-box mb-3" style="height:380px"><canvas id="openingsChart"></canvas></div>
        <div class="table-responsive">
          <table class="table table-sm table-hover align-middle mb-0">
            <thead class="table-light">
              <tr><th>Дебют</th><th class="text-end">Партий</th><th class="text-end win">Побед</th><th class="text-end loss">Пораж.</th><th class="text-end draw">Ничьи</th><th class="text-end">Очки</th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    </div>`;

  document.querySelectorAll('#openingsSection .opening-link').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      openOpeningModal(top[parseInt(a.dataset.i, 10)]);
    });
  });

  const chartTop = openings.slice(0, 15).reverse();
  makeChart('openingsChart', {
    type: 'bar',
    data: {
      labels: chartTop.map((o) => o.name),
      datasets: [
        { label: 'Белыми', data: chartTop.map((o) => o.white.total), backgroundColor: COLORS.white },
        { label: 'Чёрными', data: chartTop.map((o) => o.black.total), backgroundColor: COLORS.black }
      ]
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      scales: { x: { stacked: true }, y: { stacked: true } },
      plugins: { legend: { position: 'bottom' } }
    }
  });
}

function renderTimeControls(analysis) {
  const tc = analysis.byTimeClass || {};
  const keys = Object.keys(tc);
  if (!keys.length) {
    $('#timeSection').innerHTML = '';
    return;
  }

  const rows = keys.map((k) => {
    const t = tc[k];
    const rate = winRate(t.win, t.loss, t.draw);
    return `
      <tr>
        <td class="fw-semibold">${esc(TIME_CLASS_NAMES[k] || k)}</td>
        <td class="text-end">${fmt(t.total)}</td>
        <td class="text-end">${fmt(t.white)}</td>
        <td class="text-end">${fmt(t.black)}</td>
        <td class="text-end"><span class="win">${fmt(t.win)}</span></td>
        <td class="text-end"><span class="loss">${fmt(t.loss)}</span></td>
        <td class="text-end"><span class="draw">${fmt(t.draw)}</span></td>
        <td class="text-end fw-semibold">${pct(rate)}</td>
      </tr>`;
  }).join('');

  $('#timeSection').innerHTML = `
    <div class="card shadow-sm">
      <div class="card-body">
        <h3 class="h6 text-muted text-uppercase mb-3">По контролю времени</h3>
        <div class="table-responsive">
          <table class="table table-sm table-hover align-middle mb-0">
            <thead class="table-light">
              <tr><th>Контроль</th><th class="text-end">Партий</th><th class="text-end">Белыми</th><th class="text-end">Чёрными</th><th class="text-end win">W</th><th class="text-end loss">L</th><th class="text-end draw">D</th><th class="text-end">Очки</th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    </div>`;
}

function renderOpponents(analysis) {
  const opps = (analysis.opponents || []).slice(0, 15);
  if (!opps.length) {
    $('#opponentsSection').innerHTML = '';
    return;
  }

  const rows = opps.map((o, i) => `
    <tr>
      <td><a href="#" class="opp-link text-decoration-none fw-semibold" data-i="${i}">${esc(o.name)}</a></td>
      <td class="text-end">${fmt(o.total)}</td>
      <td class="text-end"><span class="win">${fmt(o.win)}</span></td>
      <td class="text-end"><span class="loss">${fmt(o.loss)}</span></td>
      <td class="text-end"><span class="draw">${fmt(o.draw)}</span></td>
      <td class="text-end fw-semibold">${pct(o.score * 100)}</td>
      <td class="text-end small text-muted opp-rating" data-i="${i}">…</td>
    </tr>`).join('');

  $('#opponentsSection').innerHTML = `
    <div class="card shadow-sm">
      <div class="card-body">
        <h3 class="h6 text-muted text-uppercase mb-3">Частые соперники (топ-15)</h3>
        <div class="table-responsive">
          <table class="table table-sm table-hover align-middle mb-0">
            <thead class="table-light">
              <tr><th>Соперник</th><th class="text-end">Партий</th><th class="text-end win">W</th><th class="text-end loss">L</th><th class="text-end draw">D</th><th class="text-end">Очки</th><th class="text-end">Рейтинг сейчас</th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    </div>`;

  fetch('/api/opponents?username=' + encodeURIComponent(analysis.username) + '&limit=15')
    .then((r) => r.json())
    .then((data) => {
      const cells = document.querySelectorAll('#opponentsSection .opp-rating');
      cells.forEach((td) => {
        const o = data.opponents && data.opponents[parseInt(td.dataset.i, 10)];
        if (o) td.textContent = o.rating ? nf.format(o.rating) + (o.mode ? ' (' + o.mode + ')' : '') : '—';
      });
    })
    .catch(() => {});

  document.querySelectorAll('#opponentsSection .opp-link').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      openOpponentModal(opps[parseInt(a.dataset.i, 10)]);
    });
  });
}

function renderForm(analysis) {
  const form = analysis.form || {};
  const cs = analysis.currentStreak || {};
  const streakText = cs.type === 'win' ? ('🔥 ' + cs.len + ' побед подряд')
    : cs.type === 'loss' ? ('❄ ' + cs.len + ' поражений подряд')
    : '—';

  const recent = (analysis.recentGames || []).slice(0, 20).reverse();
  const bars = recent.map((g) => {
    const color = g.outcome === 'win' ? COLORS.win : g.outcome === 'loss' ? COLORS.loss : COLORS.draw;
    const title = (g.outcome === 'win' ? 'Победа' : g.outcome === 'loss' ? 'Поражение' : 'Ничья') + ' · ' + (g.opening || '—');
    return '<span class="form-dot" style="background:' + color + '" title="' + esc(title) + '"></span>';
  }).join('');

  $('#formSection').innerHTML = `
    <div class="card shadow-sm">
      <div class="card-body">
        <h3 class="h6 text-muted text-uppercase mb-3">Форма</h3>
        <div class="row g-3 align-items-center">
          <div class="col-md-3">
            <div class="stat-label">Текущая серия</div>
            <div class="h5 mb-0">${streakText}</div>
          </div>
          <div class="col-md-3">
            <div class="stat-label">Лучшая серия побед</div>
            <div class="h5 mb-0 text-success">${analysis.bestWinStreak || 0}</div>
          </div>
          <div class="col-md-3">
            <div class="stat-label">Худшая серия поражений</div>
            <div class="h5 mb-0 text-danger">${analysis.bestLossStreak || 0}</div>
          </div>
          <div class="col-md-3">
            <div class="stat-label">Последние ${form.games} партий</div>
            <div class="h5 mb-0">${fmt(form.wins)}W / ${fmt(form.losses)}L / ${fmt(form.draws)}D <span class="text-muted small">(${pct(form.winRate)})</span></div>
          </div>
        </div>
        ${bars ? '<div class="mt-3 d-flex flex-wrap gap-1">' + bars + '</div>' : ''}
      </div>
    </div>`;
}

function renderWeakness(analysis) {
  const openings = analysis.openings || [];
  const weak = openings.filter((o) => o.total >= 5 && o.score < 0.4).sort((a, b) => a.score - b.score).slice(0, 8);

  const fast = analysis.fastLosses || {};
  const long = analysis.longGames || {};
  const longRate = long.count ? ((long.win + 0.5 * long.draw) / long.count * 100) : 0;

  const weakRows = weak.length ? weak.map((o) => `
    <tr>
      <td><span class="fw-semibold">${esc(o.name)}</span>${o.eco ? ' <span class="text-muted small">(' + esc(o.eco) + ')</span>' : ''}</td>
      <td class="text-end">${fmt(o.total)}</td>
      <td class="text-end text-danger fw-semibold">${pct(o.score * 100)}</td>
      <td class="text-end small text-muted">б. ${fmt(o.white.total)} / ч. ${fmt(o.black.total)}</td>
    </tr>`).join('')
    : '<tr><td colspan="4" class="text-muted">Явно слабых дебютов нет (score &lt; 40% при ≥5 партиях) — отлично!</td></tr>';

  const fastList = (fast.games || []).slice(0, 5).map((g) => `
    <li class="list-group-item d-flex justify-content-between align-items-center flex-wrap gap-1">
      <span>${esc(g.opening || ('ECO ' + (g.eco || '?')))} <span class="text-muted small">vs ${esc(g.opponent)} · ${Math.round((g.plies || 0) / 2)} ходов</span></span>
      ${g.url ? '<a class="btn btn-sm btn-outline-secondary" href="' + esc(g.url) + '" target="_blank" rel="noopener">разбор ↗</a>' : ''}
    </li>`).join('');

  const drops = (analysis.ratingSwings && analysis.ratingSwings.drops) || [];
  const dropList = drops.map((s) => `
    <li class="list-group-item d-flex justify-content-between align-items-center flex-wrap gap-1">
      <span><span class="text-danger fw-semibold">${nf.format(s.delta)}</span> <span class="text-muted small">${TIME_CLASS_NAMES[s.timeClass] || s.timeClass || ''} · ${fmtDateShort(s.date)}</span></span>
      ${s.url ? '<a class="btn btn-sm btn-outline-secondary" href="' + esc(s.url) + '" target="_blank" rel="noopener">разбор ↗</a>' : ''}
    </li>`).join('');

  $('#weaknessSection').innerHTML = `
    <div class="card shadow-sm">
      <div class="card-body">
        <h3 class="h6 text-muted text-uppercase mb-3">🎯 Слабые места</h3>
        <div class="row g-3">
          <div class="col-lg-6">
            <div class="h6 mb-2">Дебюты, где теряешь очки</div>
            <div class="table-responsive">
              <table class="table table-sm align-middle mb-0">
                <thead class="table-light">
                  <tr><th>Дебют</th><th class="text-end">Партий</th><th class="text-end">Очки</th><th class="text-end">Б/Ч</th></tr>
                </thead>
                <tbody>${weakRows}</tbody>
              </table>
            </div>
          </div>
          <div class="col-lg-6">
            <div class="h6 mb-2">Быстрые поражения (≤15 ходов): <span class="text-danger">${fmt(fast.count)}</span></div>
            ${fastList ? '<ul class="list-group list-group-flush">' + fastList + '</ul>' : '<div class="text-muted small">Быстрых поражений нет — хорошо.</div>'}
            <div class="h6 mt-3 mb-1">Эндшпиль (партии ≥40 ходов)</div>
            <div class="small">
              ${long.count ? fmt(long.count) + ' партий: <span class="win">' + fmt(long.win) + 'W</span> / <span class="loss">' + fmt(long.loss) + 'L</span> / <span class="draw">' + fmt(long.draw) + 'D</span> · очки ' + pct(longRate) : 'Длинных партий не найдено.'}
            </div>
            <div class="small text-muted mt-1">Средняя длина партии: ${fmt(analysis.avgPlies)} полуходов (≈${Math.round((analysis.avgPlies || 0) / 2)} ходов)</div>
            <div class="h6 mt-3 mb-1">Крупнейшие просадки рейтинга</div>
            ${dropList ? '<ul class="list-group list-group-flush">' + dropList + '</ul>' : '<div class="text-muted small">Нет данных.</div>'}
          </div>
        </div>
      </div>
    </div>`;
}

function renderStrength(analysis) {
  const bs = analysis.byOpponentStrength || {};
  const order = ['stronger', 'equal', 'weaker'];
  const labels = { stronger: 'Сильнее тебя (+50)', equal: 'Равные (±50)', weaker: 'Слабее (−50)' };

  const cards = order.map((k) => {
    const b = bs[k];
    if (!b) return '';
    const rate = winRate(b.win, b.loss, b.draw);
    return `
      <div class="col-md-4">
        <div class="card h-100 shadow-sm">
          <div class="card-body">
            <div class="stat-label">${labels[k]}</div>
            <div class="stat-big">${pct(rate)}</div>
            <div class="small text-muted">${fmt(b.total)} партий</div>
            <div class="small mt-1">
              <span class="win">${fmt(b.win)}W</span> / <span class="loss">${fmt(b.loss)}L</span> / <span class="draw">${fmt(b.draw)}D</span>
            </div>
          </div>
        </div>
      </div>`;
  }).join('');

  if (!cards) { $('#strengthSection').innerHTML = ''; return; }

  $('#strengthSection').innerHTML = `
    <div class="card shadow-sm">
      <div class="card-body">
        <h3 class="h6 text-muted text-uppercase mb-3">Результаты по силе соперника</h3>
        <div class="row g-3">${cards}</div>
      </div>
    </div>`;
}

function renderRecent(analysis) {
  const games = (analysis.recentGames || []).slice(0, 15);
  if (!games.length) { $('#recentSection').innerHTML = ''; return; }

  const rows = games.map((g) => {
    const resBadge = g.outcome === 'win' ? '<span class="badge text-bg-success">1-0</span>'
      : g.outcome === 'loss' ? '<span class="badge text-bg-danger">0-1</span>'
      : '<span class="badge text-bg-secondary">½-½</span>';
    const side = g.side === 'white' ? '⚪' : '⚫';
    const moves = g.plies ? Math.round(g.plies / 2) : '—';
    const link = analysisLink(g.url);
    return `
      <tr>
        <td>${resBadge}</td>
        <td class="text-muted small">${fmtDateShort(g.date)}</td>
        <td>${side} <span class="fw-semibold">${esc(g.opening || ('ECO ' + (g.eco || '?')))}</span></td>
        <td class="text-muted">vs ${esc(g.opponent || '—')}</td>
        <td class="text-end text-muted small">${moves} х.</td>
        <td class="text-end">${link ? '<a class="btn btn-sm btn-outline-primary" href="' + esc(link) + '" target="_blank" rel="noopener">разбор ↗</a>' : ''}</td>
      </tr>`;
  }).join('');

  $('#recentSection').innerHTML = `
    <div class="card shadow-sm">
      <div class="card-body">
        <h3 class="h6 text-muted text-uppercase mb-3">Последние партии</h3>
        <div class="table-responsive">
          <table class="table table-sm table-hover align-middle mb-0">
            <thead class="table-light">
              <tr><th>Результат</th><th>Дата</th><th>Дебют</th><th>Соперник</th><th class="text-end">Ходов</th><th class="text-end"></th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    </div>`;
}

function renderRepertoire(analysis) {
  const openings = analysis.openings || [];

  const sideData = (color) => openings
    .filter((o) => o[color] && o[color].total >= 3)
    .map((o) => {
      const s = o[color];
      return { name: o.name, eco: o.eco, total: s.total, win: s.win, loss: s.loss, draw: s.draw, score: (s.win + 0.5 * s.draw) / s.total };
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, 8);

  const badge = (score, total) => {
    if (total < 5) return '<span class="badge text-bg-secondary">мало данных</span>';
    if (score >= 0.55) return '<span class="badge text-bg-success">✅ основа</span>';
    if (score >= 0.4) return '<span class="badge text-bg-warning">⚠️ поработать</span>';
    return '<span class="badge text-bg-danger">🚫 заменить</span>';
  };

  const renderSide = (color, title) => {
    const list = sideData(color);
    if (!list.length) return '';
    const rows = list.map((o) => `
      <tr>
        <td><span class="fw-semibold">${esc(o.name)}</span>${o.eco ? ' <span class="text-muted small">(' + esc(o.eco) + ')</span>' : ''}</td>
        <td class="text-end">${fmt(o.total)}</td>
        <td class="text-end fw-semibold">${pct(o.score * 100)}</td>
        <td class="text-end">${badge(o.score, o.total)}</td>
      </tr>`).join('');
    return `
      <div class="col-lg-6">
        <div class="h6 mb-2">${title}</div>
        <div class="table-responsive">
          <table class="table table-sm table-hover align-middle mb-0">
            <thead class="table-light">
              <tr><th>Дебют</th><th class="text-end">Партий</th><th class="text-end">Очки</th><th class="text-end">Вердикт</th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
  };

  const white = renderSide('white', '⚪ За белых');
  const black = renderSide('black', '⚫ За чёрных');
  if (!white && !black) { $('#repertoireSection').innerHTML = ''; return; }

  $('#repertoireSection').innerHTML = `
    <div class="card shadow-sm">
      <div class="card-body">
        <h3 class="h6 text-muted text-uppercase mb-1">Дебютный репертуар</h3>
        <p class="small text-muted mb-3">Что играешь чаще всего и насколько успешно. Вердикт: «основа» — score ≥55%, «поработать» — 40–55%, «заменить» — &lt;40%.</p>
        <div class="row g-3">${white}${black}</div>
      </div>
    </div>`;
}

function renderTactics(analysis) {
  const stats = analysis.stats || {};
  const tactics = stats.tactics;
  const rush = stats.puzzle_rush;
  if (!tactics && !rush) { $('#tacticsSection').innerHTML = ''; return; }

  const tHigh = tactics && tactics.highest ? tactics.highest.rating : null;
  const tLow = tactics && tactics.lowest ? tactics.lowest.rating : null;
  const rushBest = rush && rush.best ? rush.best.score : null;
  const rushAttempts = rush && rush.best ? rush.best.total_attempts : null;

  let advice = 'Нет данных для совета.';
  if (tHigh != null) {
    advice = 'Тактика (макс. ' + nf.format(tHigh) + ') ' + (tHigh > 1600 ? 'заметно выше игрового рейтинга — тренируй расчёт вариантов и доводи перевес в партиях.' : 'близка к игровому уровню — работай над дебютом и стратегией.') + ' Решай puzzle rush регулярно.';
  }

  $('#tacticsSection').innerHTML = `
    <div class="card shadow-sm">
      <div class="card-body">
        <h3 class="h6 text-muted text-uppercase mb-3">🧩 Тактика и тренировка</h3>
        <div class="row g-3">
          <div class="col-md-3">
            <div class="stat-label">Тактика (макс.)</div>
            <div class="stat-big">${tHigh != null ? nf.format(tHigh) : '—'}</div>
            ${tLow != null ? '<div class="small text-muted">мин. ' + nf.format(tLow) + '</div>' : ''}
          </div>
          <div class="col-md-3">
            <div class="stat-label">Puzzle Rush (лучший)</div>
            <div class="stat-big">${rushBest != null ? nf.format(rushBest) : '—'}</div>
            ${rushAttempts != null ? '<div class="small text-muted">' + nf.format(rushAttempts) + ' попыток</div>' : ''}
          </div>
          <div class="col-md-6">
            <div class="stat-label">Совет</div>
            <div class="small">${esc(advice)}</div>
          </div>
        </div>
      </div>
    </div>`;
}

function renderStrengths(analysis) {
  const openings = analysis.openings || [];
  const strong = openings.filter((o) => o.total >= 5 && o.score >= 0.55).sort((a, b) => b.score - a.score).slice(0, 6);

  const fastWins = analysis.fastWins || {};
  const gains = (analysis.ratingSwings && analysis.ratingSwings.gains) || [];

  const strongRows = strong.length ? strong.map((o) => `
    <tr>
      <td><span class="fw-semibold">${esc(o.name)}</span>${o.eco ? ' <span class="text-muted small">(' + esc(o.eco) + ')</span>' : ''}</td>
      <td class="text-end">${fmt(o.total)}</td>
      <td class="text-end text-success fw-semibold">${pct(o.score * 100)}</td>
    </tr>`).join('')
    : '<tr><td colspan="3" class="text-muted">Пока нет стабильно сильных дебютов (score ≥55% при ≥5 партиях).</td></tr>';

  const winList = (fastWins.games || []).slice(0, 5).map((g) => `
    <li class="list-group-item d-flex justify-content-between align-items-center flex-wrap gap-1">
      <span>${esc(g.opening || ('ECO ' + (g.eco || '?')))} <span class="text-muted small">vs ${esc(g.opponent)} · ${Math.round((g.plies || 0) / 2)} ходов</span></span>
      ${g.url ? '<a class="btn btn-sm btn-outline-secondary" href="' + esc(g.url) + '" target="_blank" rel="noopener">разбор ↗</a>' : ''}
    </li>`).join('');

  const gainList = gains.map((s) => `
    <li class="list-group-item d-flex justify-content-between align-items-center flex-wrap gap-1">
      <span><span class="text-success fw-semibold">+${nf.format(s.delta)}</span> <span class="text-muted small">${TIME_CLASS_NAMES[s.timeClass] || s.timeClass || ''} · ${fmtDateShort(s.date)}</span></span>
      ${s.url ? '<a class="btn btn-sm btn-outline-secondary" href="' + esc(s.url) + '" target="_blank" rel="noopener">разбор ↗</a>' : ''}
    </li>`).join('');

  $('#strongPointsSection').innerHTML = `
    <div class="card shadow-sm">
      <div class="card-body">
        <h3 class="h6 text-muted text-uppercase mb-3">💪 Сильные стороны</h3>
        <div class="row g-3">
          <div class="col-lg-5">
            <div class="h6 mb-2">Сильные дебюты (score ≥55%)</div>
            <div class="table-responsive">
              <table class="table table-sm align-middle mb-0">
                <thead class="table-light"><tr><th>Дебют</th><th class="text-end">Партий</th><th class="text-end">Очки</th></tr></thead>
                <tbody>${strongRows}</tbody>
              </table>
            </div>
          </div>
          <div class="col-lg-4">
            <div class="h6 mb-2">Быстрые победы (≤15 ходов): <span class="text-success">${fmt(fastWins.count)}</span></div>
            ${winList ? '<ul class="list-group list-group-flush">' + winList + '</ul>' : '<div class="text-muted small">Быстрых побед нет.</div>'}
          </div>
          <div class="col-lg-3">
            <div class="h6 mb-2">Крупнейший прирост рейтинга</div>
            ${gainList ? '<ul class="list-group list-group-flush">' + gainList + '</ul>' : '<div class="text-muted small">Нет данных.</div>'}
          </div>
        </div>
      </div>
    </div>`;
}

function renderAdvice(analysis) {
  const openings = analysis.openings || [];
  const scoreOf = (o, color) => {
    const s = o[color];
    return s && s.total ? (s.win + 0.5 * s.draw) / s.total : 0;
  };

  const lines = [];
  for (const color of ['white', 'black']) {
    const emoji = color === 'white' ? '⚪' : '⚫';
    const label = color === 'white' ? 'белых' : 'чёрных';
    const played = openings.filter((o) => o[color] && o[color].total >= 5);
    if (!played.length) continue;
    const best = played.reduce((a, b) => scoreOf(a, color) >= scoreOf(b, color) ? a : b);
    const worst = played.reduce((a, b) => scoreOf(a, color) <= scoreOf(b, color) ? a : b);
    const underplayed = openings.filter((o) => o[color] && o[color].total >= 1 && o[color].total < 5 && scoreOf(o, color) >= 0.6)
      .sort((a, b) => scoreOf(b, color) - scoreOf(a, color))[0];

    lines.push('<li class="list-group-item d-flex justify-content-between align-items-center flex-wrap gap-1"><span>' + emoji + ' Сильнейший за ' + label + ': <span class="fw-semibold">' + esc(best.name) + '</span> <span class="text-muted small">(' + pct(scoreOf(best, color) * 100) + ')</span></span></li>');
    lines.push('<li class="list-group-item d-flex justify-content-between align-items-center flex-wrap gap-1"><span>' + emoji + ' Слабейший за ' + label + ': <span class="fw-semibold">' + esc(worst.name) + '</span> <span class="text-muted small">(' + pct(scoreOf(worst, color) * 100) + ')</span></span></li>');
    if (underplayed) {
      lines.push('<li class="list-group-item d-flex justify-content-between align-items-center flex-wrap gap-1"><span>' + emoji + ' Недооценённый за ' + label + ': <span class="fw-semibold">' + esc(underplayed.name) + '</span> <span class="text-muted small">(' + pct(scoreOf(underplayed, color) * 100) + ')</span></span></li>');
    }
  }

  if (!lines.length) { $('#adviceSection').innerHTML = ''; return; }

  $('#adviceSection').innerHTML = `
    <div class="card shadow-sm">
      <div class="card-body">
        <h3 class="h6 text-muted text-uppercase mb-1">🧭 Рекомендации</h3>
        <p class="small text-muted mb-3">Автосоветы по твоему репертуару: что сильное, что тянет вниз, что стоит играть чаще.</p>
        <ul class="list-group list-group-flush">${lines.join('')}</ul>
      </div>
    </div>`;
}

function renderStages(analysis) {
  const bs = analysis.byStage || {};
  const stages = [
    { key: 'opening', label: 'Дебют', desc: '≤15 ходов' },
    { key: 'middlegame', label: 'Миттельшпиль', desc: '16–40 ходов' },
    { key: 'endgame', label: 'Эндшпиль', desc: '>40 ходов' }
  ];

  const cards = stages.map((s) => {
    const b = bs[s.key];
    if (!b || !b.total) return '';
    const rate = winRate(b.win, b.loss, b.draw);
    return `
      <div class="col-md-4">
        <div class="card h-100 shadow-sm">
          <div class="card-body">
            <div class="stat-label">${s.label} <span class="text-lowercase">(${s.desc})</span></div>
            <div class="stat-big">${pct(rate)}</div>
            <div class="small text-muted">${fmt(b.total)} партий</div>
            <div class="small mt-1">
              <span class="win">${fmt(b.win)}W</span> / <span class="loss">${fmt(b.loss)}L</span> / <span class="draw">${fmt(b.draw)}D</span>
            </div>
          </div>
        </div>
      </div>`;
  }).join('');

  if (!cards) { $('#stagesSection').innerHTML = ''; return; }

  let weakest = null;
  for (const s of stages) {
    const b = bs[s.key];
    if (b && b.total >= 5) {
      const r = winRate(b.win, b.loss, b.draw);
      if (!weakest || r < weakest.rate) weakest = { label: s.label, rate: r };
    }
  }

  $('#stagesSection').innerHTML = `
    <div class="card shadow-sm">
      <div class="card-body">
        <h3 class="h6 text-muted text-uppercase mb-3">📊 Стадии партии</h3>
        <div class="row g-3">${cards}</div>
        ${weakest ? '<div class="small text-muted mt-3">Слабейшая стадия — <strong>' + weakest.label + '</strong> (' + pct(weakest.rate) + '). Сфокусируй тренировки на ней.</div>' : ''}
      </div>
    </div>`;
}

function renderBestGames(analysis) {
  const games = analysis.bestGames || [];
  if (!games.length) { $('#bestGamesSection').innerHTML = ''; return; }

  const rows = games.map((g) => `
    <tr>
      <td class="text-muted small">${fmtDateShort(g.date)}</td>
      <td><span class="text-success fw-semibold">+${nf.format(g.upset)}</span> <span class="text-muted small">против ${nf.format(g.oppRating)}</span></td>
      <td><span class="fw-semibold">${esc(g.opening || ('ECO ' + (g.eco || '?')))}</span></td>
      <td class="text-muted">vs ${esc(g.opponent)}</td>
      <td class="text-end">${g.url ? '<a class="btn btn-sm btn-outline-primary" href="' + esc(g.url) + '" target="_blank" rel="noopener">разбор ↗</a>' : ''}</td>
    </tr>`).join('');

  $('#bestGamesSection').innerHTML = `
    <div class="card shadow-sm">
      <div class="card-body">
        <h3 class="h6 text-muted text-uppercase mb-3">🏆 Лучшие партии (апсеты)</h3>
        <p class="small text-muted mb-3">Твои победы над соперниками на 100+ очков сильнее.</p>
        <div class="table-responsive">
          <table class="table table-sm table-hover align-middle mb-0">
            <thead class="table-light"><tr><th>Дата</th><th>Апсет</th><th>Дебют</th><th>Соперник</th><th class="text-end"></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    </div>`;
}

function renderVolume(analysis) {
  const data = analysis.byGameOfDay || [];
  if (!data.length) { $('#volumeSection').innerHTML = ''; return; }

  const first = data[0] ? data[0].score : null;
  const last = data[data.length - 1] ? data[data.length - 1].score : null;

  let advice = 'Пока мало данных по сериям за день.';
  if (data.length >= 3 && first != null && last != null) {
    const diff = last - first;
    if (diff <= -8) advice = 'К концу сессии играешь заметно хуже (падение на ' + Math.abs(Math.round(diff)) + ' п.п.). Играй меньше партий за раз и делай перерывы.';
    else if (diff <= -3) advice = 'Есть лёгкое падение к концу сессии — ограничь длинные серии, делай паузы.';
    else advice = 'Качество почти не падает от количества партий — можешь играть много, это ок.';
  }

  const labels = data.map((d) => d.position + ' партия');
  const scores = data.map((d) => d.score);

  $('#volumeSection').innerHTML = `
    <div class="card shadow-sm">
      <div class="card-body">
        <h3 class="h6 text-muted text-uppercase mb-3">🎮 Сколько играть <span class="fw-normal small text-lowercase">(живые партии)</span></h3>
        <div class="chart-box mb-2" style="height:220px"><canvas id="volumeChart"></canvas></div>
        <div class="small text-muted">${esc(advice)}</div>
      </div>
    </div>`;

  makeChart('volumeChart', {
    type: 'bar',
    data: {
      labels,
      datasets: [{ label: 'Очки (%)', data: scores, backgroundColor: scores.map((s) => s >= 50 ? COLORS.win : COLORS.loss) }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { y: { min: 0, max: 100 } },
      plugins: { legend: { display: false } }
    }
  });
}

function renderBestTime(analysis) {
  const data = analysis.byHour || [];
  if (!data.length) { $('#bestTimeSection').innerHTML = ''; return; }

  const tzShift = Math.round(-new Date().getTimezoneOffset() / 60);
  const localHour = (utc) => ((utc + tzShift) % 24 + 24) % 24;

  const withGames = data.filter((d) => d.total >= 3 && d.score != null);
  let best = null;
  if (withGames.length) best = withGames.reduce((a, b) => (a.score >= b.score ? a : b));

  const labels = data.map((d) => String(localHour(d.hour)).padStart(2, '0') + ':00');
  const scores = data.map((d) => d.score);

  let advice = 'Недостаточно данных по времени суток.';
  if (best) {
    const h = localHour(best.hour);
    advice = 'Лучшее время: ~' + String(h).padStart(2, '0') + ':00 (' + best.score + '% очков, ' + best.total + ' партий).';
  }

  $('#bestTimeSection').innerHTML = `
    <div class="card shadow-sm">
      <div class="card-body">
        <h3 class="h6 text-muted text-uppercase mb-3">🕐 Лучшее время для игры <span class="fw-normal small text-lowercase">(живые партии)</span></h3>
        <div class="chart-box mb-2" style="height:220px"><canvas id="bestTimeChart"></canvas></div>
        <div class="small text-muted">${esc(advice)} <span class="text-muted">(по твоему локальному времени)</span></div>
      </div>
    </div>`;

  makeChart('bestTimeChart', {
    type: 'bar',
    data: {
      labels,
      datasets: [{ label: 'Очки (%)', data: scores, backgroundColor: scores.map((s) => s == null ? 'rgba(128,128,128,.3)' : (s >= 50 ? COLORS.win : COLORS.loss)) }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { y: { min: 0, max: 100 } },
      plugins: { legend: { display: false } }
    }
  });
}

function renderSummary(analysis) {
  const a = analysis;
  const s = [];
  const scoreOf = (w, l, d) => {
    const t = w + l + d;
    return t ? ((w + 0.5 * d) / t * 100).toFixed(1) : null;
  };

  // общий итог
  const totalScore = scoreOf(a.wins, a.losses, a.draws);
  s.push('За всё время ' + nf.format(a.total) + ' партий — ' + nf.format(a.wins) + ' побед, ' + nf.format(a.losses) + ' поражений и ' + nf.format(a.draws) + ' ничьих (' + (totalScore || '—') + '% очков).');

  // цвет
  const wScore = scoreOf(a.asWhite.win, a.asWhite.loss, a.asWhite.draw);
  const bScore = scoreOf(a.asBlack.win, a.asBlack.loss, a.asBlack.draw);
  if (wScore && bScore) {
    s.push('Белыми играешь ' + (parseFloat(wScore) >= parseFloat(bScore) ? 'сильнее' : 'слабее') + ' — ' + wScore + '% против ' + bScore + '% чёрными.');
  }

  // рейтинг + тренд
  const rapid = a.stats && a.stats.chess_rapid;
  if (rapid && rapid.last && rapid.last.rating) {
    const cur = rapid.last.rating;
    const best = rapid.best && rapid.best.rating;
    s.push('Текущий рейтинг в рапиде — ' + nf.format(cur) + (best ? ' (лучший ' + nf.format(best) + ')' : '') + '.');
  }
  const combined = (a.ratingHistory || []).map((r) => (r.white != null && r.black != null ? (r.white + r.black) / 2 : (r.white != null ? r.white : r.black))).filter((v) => v != null);
  if (combined.length >= 2) {
    const trend = linearRegression(combined.map((y, i) => ({ x: i, y })));
    if (trend) {
      s.push('Рейтинг ' + (trend.slope >= 0 ? 'растёт' : 'падает') + ' примерно на ' + (trend.slope >= 0 ? '+' : '') + trend.slope.toFixed(1) + ' очков в месяц.');
    }
  }

  // форма
  const cs = a.currentStreak || {};
  const form = a.form || {};
  if (cs.type === 'win') s.push('Сейчас у тебя серия из ' + cs.len + ' побед подряд.');
  else if (cs.type === 'loss') s.push('Сейчас серия из ' + cs.len + ' поражений подряд.');
  if (form.games) s.push('В последних ' + form.games + ' партиях ты набираешь ' + form.winRate + '% очков.');

  // стадии
  const bs = a.byStage || {};
  const stageNames = { opening: 'дебюте', middlegame: 'миттельшпиле', endgame: 'эндшпиле' };
  let bestStage = null, worstStage = null;
  for (const k of ['opening', 'middlegame', 'endgame']) {
    const b = bs[k];
    if (!b || b.total < 5) continue;
    const r = parseFloat(scoreOf(b.win, b.loss, b.draw));
    if (!bestStage || r > bestStage.r) bestStage = { name: stageNames[k], r };
    if (!worstStage || r < worstStage.r) worstStage = { name: stageNames[k], r };
  }
  if (bestStage && worstStage) {
    s.push('Сильнее всего ты в ' + bestStage.name + ' (' + bestStage.r.toFixed(1) + '%), а ' + worstStage.name + ' — твоё слабое место (' + worstStage.r.toFixed(1) + '%): на нём и стоит сфокусироваться.');
  }

  // дебюты
  const played = (a.openings || []).filter((o) => o.total >= 5);
  if (played.length) {
    const bestO = played.reduce((x, y) => (x.score >= y.score ? x : y));
    const worstO = played.reduce((x, y) => (x.score <= y.score ? x : y));
    s.push('Лучший дебют — ' + esc(bestO.name) + ' (' + (bestO.score * 100).toFixed(1) + '%), худший — ' + esc(worstO.name) + ' (' + (worstO.score * 100).toFixed(1) + '%).');
  }

  // соперники
  const os = a.byOpponentStrength || {};
  const sStrong = os.stronger ? scoreOf(os.stronger.win, os.stronger.loss, os.stronger.draw) : null;
  const sEqual = os.equal ? scoreOf(os.equal.win, os.equal.loss, os.equal.draw) : null;
  const sWeak = os.weaker ? scoreOf(os.weaker.win, os.weaker.loss, os.weaker.draw) : null;
  if (sStrong && sEqual && sWeak) {
    s.push('Против соперников сильнее себя ты набираешь ' + sStrong + '% очков, против равных — ' + sEqual + '%, против слабее — ' + sWeak + '%.');
  }

  // быстрые
  const fw = a.fastWins ? a.fastWins.count : 0;
  const fl = a.fastLosses ? a.fastLosses.count : 0;
  if (fw || fl) s.push('Быстрых партий (≤15 ходов): ' + fw + ' побед и ' + fl + ' поражений.');

  // время + объём
  const withGames = (a.byHour || []).filter((h) => h.total >= 3 && h.score != null);
  if (withGames.length) {
    const bestH = withGames.reduce((x, y) => (x.score >= y.score ? x : y));
    const tzShift = Math.round(-new Date().getTimezoneOffset() / 60);
    const local = ((bestH.hour + tzShift) % 24 + 24) % 24;
    s.push('Лучшее время для игры — около ' + String(local).padStart(2, '0') + ':00 (' + bestH.score + '%).');
  }
  const vol = a.byGameOfDay || [];
  if (vol.length >= 3 && vol[0].score != null && vol[vol.length - 1].score != null) {
    const diff = vol[vol.length - 1].score - vol[0].score;
    s.push(diff <= -8 ? 'К концу сессии ты играешь хуже, так что стоит играть меньше партий за раз.' : 'Качество почти не падает от количества партий — можно играть много.');
  }

  if (!s.length) { $('#summarySection').innerHTML = ''; return; }

  $('#summarySection').innerHTML = `
    <div class="card shadow-sm border-start border-4 border-success">
      <div class="card-body">
        <h3 class="h6 text-muted text-uppercase mb-2">📋 Сводка</h3>
        <p class="mb-0" style="line-height:1.75; font-size:.92rem">${s.join(' ')}</p>
      </div>
    </div>`;
}

function renderLostOpponents(analysis) {
  $('#lostSection').innerHTML = `
    <div class="card shadow-sm">
      <div class="card-body">
        <h3 class="h6 text-muted text-uppercase mb-3">📉 Кому проигрывал</h3>
        <div class="small text-muted">Загружаем форму соперников…</div>
      </div>
    </div>`;

  fetch('/api/opponents-form?username=' + encodeURIComponent(analysis.username) + '&limit=10')
    .then((r) => r.json())
    .then((data) => {
      const opps = data.opponents || [];
      if (!opps.length) { $('#lostSection').innerHTML = ''; return; }
      const rows = opps.map((o) => {
        const f = o.form || {};
        const streak = f.streak || {};
        const streakTxt = streak.type === 'win' ? '🔥 ' + streak.len + ' побед подряд'
          : streak.type === 'loss' ? '❄ ' + streak.len + ' поражений подряд'
          : '—';
        return `
          <tr>
            <td><span class="fw-semibold">${esc(o.name)}</span></td>
            <td class="text-end"><span class="loss fw-semibold">${fmt(o.loss)}</span> <span class="text-muted small">из ${fmt(o.total)}</span></td>
            <td class="text-end">${o.rating ? nf.format(o.rating) + (o.mode ? ' (' + o.mode + ')' : '') : '—'}</td>
            <td class="text-end">${f.games ? f.winRate + '%' : '—'}</td>
            <td class="text-end">${f.games ? nf.format(f.wins) + 'W / ' + nf.format(f.losses) + 'L / ' + nf.format(f.draws) + 'D' : '—'}</td>
            <td>${streakTxt}</td>
          </tr>`;
      }).join('');
      $('#lostSection').innerHTML = `
        <div class="card shadow-sm">
          <div class="card-body">
            <h3 class="h6 text-muted text-uppercase mb-3">📉 Кому проигрывал</h3>
            <p class="small text-muted mb-3">Соперники, которым ты чаще всего проигрывал, и их текущая форма.</p>
            <div class="table-responsive">
              <table class="table table-sm table-hover align-middle mb-0">
                <thead class="table-light"><tr><th>Соперник</th><th class="text-end">Поражений</th><th class="text-end">Рейтинг</th><th class="text-end">Форма</th><th class="text-end">W/L/D (их)</th><th>Серия</th></tr></thead>
                <tbody>${rows}</tbody>
              </table>
            </div>
          </div>
        </div>`;
    })
    .catch(() => { $('#lostSection').innerHTML = ''; });
}

function renderCompare(analysis) {
  $('#compareSection').innerHTML = `
    <div class="card shadow-sm">
      <div class="card-body">
        <h3 class="h6 text-muted text-uppercase mb-3">⚔️ Сравнение с последним соперником</h3>
        <div class="small text-muted">Загружаем соперника…</div>
      </div>
    </div>`;

  fetch('/api/compare?username=' + encodeURIComponent(analysis.username))
    .then((r) => r.json())
    .then((data) => {
      if (!data.opponent) { $('#compareSection').innerHTML = ''; return; }
      const me = data.user;
      const op = data.opponent;
      const ll = data.lastLoss;

      const scoreOf = (w, l, d) => { const t = w + l + d; return t ? ((w + 0.5 * d) / t * 100).toFixed(1) : null; };
      const p = (v) => (v == null ? '—' : v + '%');
      const rapidOf = (a) => (a.stats && a.stats.chess_rapid && a.stats.chess_rapid.last && a.stats.chess_rapid.last.rating) || null;
      const stageOf = (a) => {
        const bs = a.byStage || {};
        const names = { opening: 'Дебют', middlegame: 'Миттельшпиль', endgame: 'Эндшпиль' };
        let best = null, worst = null;
        for (const k of ['opening', 'middlegame', 'endgame']) {
          const b = bs[k];
          if (!b || b.total < 5) continue;
          const r = parseFloat(scoreOf(b.win, b.loss, b.draw));
          if (!best || r > best.r) best = { n: names[k], r };
          if (!worst || r < worst.r) worst = { n: names[k], r };
        }
        return { best, worst };
      };
      const bestOpening = (a) => {
        const played = (a.openings || []).filter((o) => o.total >= 5);
        return played.length ? played.reduce((x, y) => (x.score >= y.score ? x : y)) : null;
      };
      const streakTxt = (a) => {
        const cs = a.currentStreak || {};
        return cs.type === 'win' ? cs.len + ' побед' : cs.type === 'loss' ? cs.len + ' поражений' : '—';
      };

      const meStage = stageOf(me), opStage = stageOf(op);
      const meBest = bestOpening(me), opBest = bestOpening(op);
      const meForm = me.form || {}, opForm = op.form || {};

      const rows = [
        ['Рейтинг (рапид)', rapidOf(me) != null ? nf.format(rapidOf(me)) : '—', rapidOf(op) != null ? nf.format(rapidOf(op)) : '—'],
        ['Всего партий', nf.format(me.total), nf.format(op.total)],
        ['Очки', p(scoreOf(me.wins, me.losses, me.draws)), p(scoreOf(op.wins, op.losses, op.draws))],
        ['Белыми', p(scoreOf(me.asWhite.win, me.asWhite.loss, me.asWhite.draw)), p(scoreOf(op.asWhite.win, op.asWhite.loss, op.asWhite.draw))],
        ['Чёрными', p(scoreOf(me.asBlack.win, me.asBlack.loss, me.asBlack.draw)), p(scoreOf(op.asBlack.win, op.asBlack.loss, op.asBlack.draw))],
        ['Сильнейшая стадия', meStage.best ? meStage.best.n + ' ' + meStage.best.r.toFixed(1) + '%' : '—', opStage.best ? opStage.best.n + ' ' + opStage.best.r.toFixed(1) + '%' : '—'],
        ['Слабейшая стадия', meStage.worst ? meStage.worst.n + ' ' + meStage.worst.r.toFixed(1) + '%' : '—', opStage.worst ? opStage.worst.n + ' ' + opStage.worst.r.toFixed(1) + '%' : '—'],
        ['Лучший дебют', meBest ? esc(meBest.name) : '—', opBest ? esc(opBest.name) : '—'],
        ['Форма (посл. 20)', meForm.winRate != null ? meForm.winRate + '%' : '—', opForm.winRate != null ? opForm.winRate + '%' : '—'],
        ['Серия', streakTxt(me), streakTxt(op)]
      ];

      const rowsHtml = rows.map((r) => `
        <tr>
          <td class="text-muted">${r[0]}</td>
          <td class="text-end fw-semibold">${r[1]}</td>
          <td class="text-end">${r[2]}</td>
        </tr>`).join('');

      $('#compareSection').innerHTML = `
        <div class="card shadow-sm">
          <div class="card-body">
            <h3 class="h6 text-muted text-uppercase mb-1">⚔️ Сравнение с последним соперником</h3>
            <p class="small text-muted mb-3">Ты против <strong>${esc(ll.opponent)}</strong> — последний, кому проиграл${ll.date ? ' (' + fmtDateShort(ll.date) + ')' : ''}${ll.opening ? ' · ' + esc(ll.opening) : ''}.</p>
            <div class="table-responsive">
              <table class="table table-sm align-middle mb-0">
                <thead class="table-light"><tr><th>Показатель</th><th class="text-end">Ты</th><th class="text-end">${esc(ll.opponent)}</th></tr></thead>
                <tbody>${rowsHtml}</tbody>
              </table>
            </div>
          </div>
        </div>`;
    })
    .catch(() => { $('#compareSection').innerHTML = ''; });
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* -------------------------------- submit ---------------------------------- */

async function onSubmit(e) {
  e.preventDefault();
  const input = $('#playerInput').value.trim();
  if (!input) return;

  hideError();
  hideResults();
  destroyCharts();
  showStatus('Загружаем профиль…');

  try {
    const playerRes = await fetch('/api/player?input=' + encodeURIComponent(input));
    const playerData = await playerRes.json();
    if (!playerRes.ok) throw new Error(playerData.error || 'Ошибка загрузки профиля');

    showResults();
    lastProfile = playerData;
    renderProfile(playerData);
    renderRatings(playerData);

    const months = $('#monthsSelect').value;
    const refresh = $('#refreshCheck').checked ? '&refresh=1' : '';
    showStatus('Скачиваем и анализируем партии… (для большого периода это может занять время)');

    const analyzeRes = await fetch(
      '/api/analyze?username=' + encodeURIComponent(playerData.username) + '&months=' + months + refresh
    );
    const analysis = await analyzeRes.json();
    if (!analyzeRes.ok) throw new Error(analysis.error || 'Ошибка анализа');

    lastAnalysis = analysis;
    renderAnalysisSections(analysis);
    hideStatus();
  } catch (err) {
    hideStatus();
    showError(err.message || String(err));
  }
}

async function loadHistory() {
  try {
    const res = await fetch('/api/history');
    const data = await res.json();
    const players = (data.players || []).slice(0, 12);
    const el = $('#historyChips');
    if (!el) return;
    if (!players.length) { el.innerHTML = ''; return; }
    el.innerHTML = '<span class="small text-muted">Недавно анализировали:</span>' +
      players.map((p) =>
        '<button type="button" class="btn btn-sm btn-outline-secondary" data-user="' + esc(p.username) + '">' +
        esc(p.name || p.username) + ' <span class="text-muted small">' + nf.format(p.gamesTotal || 0) + ' парт.</span>' +
        '</button>'
      ).join('');
    el.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => {
        $('#playerInput').value = b.dataset.user;
        $('#searchForm').requestSubmit();
      });
    });
  } catch (_) {}
}

function renderAnalysisSections(analysis) {
  renderSummary(analysis);
  renderCompare(analysis);
  renderTactics(analysis);
  renderOverview(analysis);
  renderForm(analysis);
  renderVolume(analysis);
  renderBestTime(analysis);
  renderWeakness(analysis);
  renderStrengths(analysis);
  renderStages(analysis);
  renderStrength(analysis);
  renderOpenings(analysis);
  renderRepertoire(analysis);
  renderAdvice(analysis);
  renderTimeControls(analysis);
  renderOpponents(analysis);
  renderLostOpponents(analysis);
  renderRecent(analysis);
  renderBestGames(analysis);
}

function openOpeningModal(o) {
  if (!o) return;
  $('#openingModalTitle').textContent = o.name + (o.eco ? ' (' + o.eco + ')' : '');
  const total = o.total;
  const score = o.score * 100;
  const wTotal = o.white.total;
  const bTotal = o.black.total;

  const oppRows = (o.opponents || []).map((op) => `
    <tr>
      <td class="fw-semibold">${esc(op.name)}</td>
      <td class="text-end">${fmt(op.total)}</td>
      <td class="text-end"><span class="win">${fmt(op.win)}</span> / <span class="loss">${fmt(op.loss)}</span> / <span class="draw">${fmt(op.draw)}</span></td>
    </tr>`).join('') || '<tr><td colspan="3" class="text-muted">Нет данных</td></tr>';

  $('#openingModalBody').innerHTML = `
    <div class="row g-3 mb-3">
      <div class="col-6 col-md-3"><div class="stat-label">Партий</div><div class="stat-big">${fmt(total)}</div></div>
      <div class="col-6 col-md-3"><div class="stat-label">Очки</div><div class="stat-big">${pct(score)}</div></div>
      <div class="col-6 col-md-3"><div class="stat-label">Средняя длина</div><div class="stat-big">${o.avgPlies ? Math.round(o.avgPlies / 2) : '—'}<span class="fs-6 text-muted"> ход.</span></div></div>
      <div class="col-6 col-md-3"><div class="stat-label">Белыми / чёрными</div><div class="stat-big">${fmt(wTotal)}<span class="fs-6 text-muted"> / </span>${fmt(bTotal)}</div></div>
    </div>
    <div class="row g-3">
      <div class="col-lg-7">
        <div class="h6 mb-2">Очки по месяцам</div>
        <div class="chart-box" style="height:240px"><canvas id="openingChart"></canvas></div>
      </div>
      <div class="col-lg-5">
        <div class="h6 mb-2">Частые соперники в этом дебюте</div>
        <div class="table-responsive">
          <table class="table table-sm align-middle mb-0">
            <thead class="table-light"><tr><th>Соперник</th><th class="text-end">Партий</th><th class="text-end">W/L/D</th></tr></thead>
            <tbody>${oppRows}</tbody>
          </table>
        </div>
      </div>
    </div>`;

  const modalEl = document.getElementById('openingModal');
  modalEl.addEventListener('shown.bs.modal', function onShown() {
    modalEl.removeEventListener('shown.bs.modal', onShown);
    const labels = (o.byMonth || []).map((m) => m.month);
    const scores = (o.byMonth || []).map((m) => m.total ? +((m.win + 0.5 * m.draw) / m.total * 100).toFixed(1) : 0);
    const existing = window.Chart && Chart.getChart('openingChart');
    if (existing) existing.destroy();
    new Chart(document.getElementById('openingChart'), {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { type: 'bar', label: 'Очки (%)', data: scores, backgroundColor: scores.map((s) => s >= 50 ? COLORS.win : COLORS.loss) },
          { type: 'line', label: '50%', data: labels.map(() => 50), borderColor: '#8b949e', borderDash: [4, 4], pointRadius: 0, fill: false }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: { y: { min: 0, max: 100 } },
        plugins: { legend: { display: false } }
      }
    });
  });
  const modal = bootstrap.Modal.getInstance(modalEl) || new bootstrap.Modal(modalEl);
  modal.show();
}

function openOpponentModal(o) {
  if (!o) return;
  $('#opponentModalTitle').textContent = o.name;
  const score = (o.score || 0) * 100;

  const openRows = (o.openings || []).map((op) => `
    <tr>
      <td><span class="fw-semibold">${esc(op.name)}</span>${op.eco ? ' <span class="text-muted small">(' + esc(op.eco) + ')</span>' : ''}</td>
      <td class="text-end">${fmt(op.total)}</td>
      <td class="text-end"><span class="win">${fmt(op.win)}</span> / <span class="loss">${fmt(op.loss)}</span> / <span class="draw">${fmt(op.draw)}</span></td>
    </tr>`).join('') || '<tr><td colspan="3" class="text-muted">Нет данных</td></tr>';

  const recentRows = (o.recent || []).map((g) => `
    <tr>
      <td class="text-muted small">${fmtDateShort(g.date)}</td>
      <td>${g.outcome === 'win' ? '<span class="badge text-bg-success">победа</span>' : g.outcome === 'loss' ? '<span class="badge text-bg-danger">поражение</span>' : '<span class="badge text-bg-secondary">ничья</span>'}</td>
      <td><span class="fw-semibold">${esc(g.opening || ('ECO ' + (g.eco || '?')))}</span></td>
      <td class="text-end">${g.url ? '<a class="btn btn-sm btn-outline-primary" href="' + esc(g.url) + '" target="_blank" rel="noopener">разбор ↗</a>' : ''}</td>
    </tr>`).join('') || '<tr><td colspan="4" class="text-muted">Нет данных</td></tr>';

  $('#opponentModalBody').innerHTML = `
    <div class="row g-3 mb-3">
      <div class="col-6 col-md-3"><div class="stat-label">Партий</div><div class="stat-big">${fmt(o.total)}</div></div>
      <div class="col-6 col-md-3"><div class="stat-label">Твой счёт</div><div class="stat-big">${pct(score)}</div></div>
      <div class="col-6 col-md-3"><div class="stat-label">Побед</div><div class="stat-big text-success">${fmt(o.win)}</div></div>
      <div class="col-6 col-md-3"><div class="stat-label">Поражений</div><div class="stat-big text-danger">${fmt(o.loss)}</div></div>
    </div>
    <div class="row g-3">
      <div class="col-lg-6">
        <div class="h6 mb-2">Дебюты против него</div>
        <div class="table-responsive">
          <table class="table table-sm align-middle mb-0">
            <thead class="table-light"><tr><th>Дебют</th><th class="text-end">Партий</th><th class="text-end">W/L/D</th></tr></thead>
            <tbody>${openRows}</tbody>
          </table>
        </div>
      </div>
      <div class="col-lg-6">
        <div class="h6 mb-2">Последние партии с ним</div>
        <div class="table-responsive">
          <table class="table table-sm align-middle mb-0">
            <thead class="table-light"><tr><th>Дата</th><th>Итог</th><th>Дебют</th><th class="text-end"></th></tr></thead>
            <tbody>${recentRows}</tbody>
          </table>
        </div>
      </div>
    </div>`;

  const modalEl = document.getElementById('opponentModal');
  const modal = bootstrap.Modal.getInstance(modalEl) || new bootstrap.Modal(modalEl);
  modal.show();
}

function applyTheme(theme) {
  const isDark = theme !== 'light';
  document.documentElement.setAttribute('data-bs-theme', isDark ? 'dark' : 'light');
  try { localStorage.setItem('chessstats:theme', theme); } catch (_) {}
  if (window.Chart) {
    Chart.defaults.color = isDark ? '#8b949e' : '#57606a';
    Chart.defaults.borderColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  }
  const btn = document.getElementById('themeToggle');
  if (btn) btn.textContent = isDark ? '☀️' : '🌙';
  if (lastProfile) { renderProfile(lastProfile); renderRatings(lastProfile); }
  if (lastAnalysis) { destroyCharts(); renderAnalysisSections(lastAnalysis); }
}

function initTheme() {
  let theme = 'dark';
  try { theme = localStorage.getItem('chessstats:theme') || 'dark'; } catch (_) {}
  applyTheme(theme);
}

function initFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const u = params.get('user');
  if (u) {
    $('#playerInput').value = u;
    $('#searchForm').requestSubmit();
  }
}

$('#searchForm').addEventListener('submit', onSubmit);
document.getElementById('themeToggle').addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-bs-theme');
  applyTheme(current === 'dark' ? 'light' : 'dark');
});

loadHistory();
initTheme();
initFromUrl();
