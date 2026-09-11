'use strict';
/*
 * Chess Stats — локальный сервер аналитики chess.com
 * Стек: только стандартная библиотека Node.js (http, https, fs, path, url).
 * Без npm-зависимостей. "База данных" — JSON-файлы в ./data.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const ROOT = __dirname;
const STATIC_DIR = path.join(ROOT, 'static');
const DATA_DIR = path.join(ROOT, 'data');
const PLAYERS_DIR = path.join(DATA_DIR, 'players');
const GAMES_DIR = path.join(DATA_DIR, 'games');
const OPPONENTS_DIR = path.join(DATA_DIR, 'opponents');
const OPPONENTS_FORM_DIR = path.join(DATA_DIR, 'opponents-form');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

const PORT = parseInt(process.env.PORT, 10) || 8000;
const HOST = process.env.HOST || '127.0.0.1';
const UA = 'chess-stats-local/1.0 (+local analysis tool)';

const PROFILE_TTL_MS = 6 * 60 * 60 * 1000;   // 6 часов (профиль/рейтинги)
const MAX_ARCHIVE_MONTHS = 300;              // потолок для "вся история"
// Кэш игр НЕ сбрасывается по времени — живёт, пока не запросят refresh=1 (не трогаем API без нужды)
const FETCH_DELAY_MS = 250;                  // пауза между архивами (вежливость к API)
const SCHEMA_VERSION = 8;                    // версия схемы JSON-кэша игр (менять при изменении структуры)

for (const d of [DATA_DIR, PLAYERS_DIR, GAMES_DIR, OPPONENTS_DIR, OPPONENTS_FORM_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------- HTTP клиент ------------------------------- */

function fetchBuffer(targetUrl, redirects = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(targetUrl);
    } catch (e) {
      return reject(e);
    }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(u, {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json,text/plain,*/*',
        'Accept-Encoding': 'identity'
      }
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
        res.resume();
        return resolve(fetchBuffer(new URL(res.headers.location, u).toString(), redirects + 1));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode === 404) {
          const err = new Error('NotFound');
          err.status = 404;
          return reject(err);
        }
        if (res.statusCode !== 200) {
          const err = new Error('HTTP ' + res.statusCode + ' — ' + targetUrl);
          err.status = res.statusCode;
          return reject(err);
        }
        resolve(buf);
      });
    });
    req.on('error', reject);
    req.setTimeout(25000, () => req.destroy(new Error('Таймаут запроса к ' + targetUrl)));
  });
}

async function fetchJson(u) {
  const buf = await fetchBuffer(u);
  return JSON.parse(buf.toString('utf8'));
}

/* --------------------------- Извлечение username --------------------------- */

function extractUsername(input) {
  if (!input) return null;
  let s = String(input).trim();
  if (s.startsWith('@')) s = s.slice(1);
  s = s.replace(/\/+$/, '');

  // URL вида chess.com/member/..., /player/..., /games/..., /stats/overview/...
  const urlMatch = s.match(
    /chess\.com\/(?:member|player|games|stats(?:\/[a-z-]+)?)\/([A-Za-z0-9_][A-Za-z0-9_-]{0,253})/i
  );
  if (urlMatch) return urlMatch[1].toLowerCase();

  // Голый ник
  const bare = s.split(/[/?#]/)[0];
  if (/^[A-Za-z0-9_][A-Za-z0-9_-]{0,253}$/.test(bare)) return bare.toLowerCase();
  return null;
}

/* -------------------------------- PGN / игры ------------------------------- */

function parsePgnHeaders(pgn) {
  const h = {};
  const lines = String(pgn || '').split(/\r?\n/);
  for (const line of lines) {
    if (line.trim() === '') break;
    const m = line.match(/^\[(\w+)\s+"(.*)"\]\s*$/);
    if (m) h[m[1]] = m[2];
  }
  return h;
}

// Из ECOUrl вида ".../openings/Sicilian-Defense-Najdorf-Variation-6.Be3" берём имя дебюта.
const SAN_RE = /^(?:[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?|O-O(?:-O)?)$/;

function openingFromUrl(ecoUrl) {
  if (!ecoUrl) return '';
  const last = ecoUrl.split('/').filter(Boolean).pop() || '';
  const nameParts = [];
  for (const p of last.split('-')) {
    if (!p) continue;
    if (/^\d/.test(p) || SAN_RE.test(p)) break; // началась запись ходов — это уже не имя дебюта
    const sep = p.indexOf('...');
    if (sep !== -1) {
      const head = p.slice(0, sep);
      if (head) nameParts.push(head);
      break; // "...N.dX" — начало ходов
    }
    nameParts.push(p);
  }
  return nameParts.join(' ').trim();
}

function toDate(ts) {
  if (!ts) return null;
  // chess.com отдаёт end_time в секундах
  return ts > 1e12 ? new Date(ts) : new Date(ts * 1000);
}

function stripPgnNoise(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '{') { while (i < s.length && s[i] !== '}') i++; i++; continue; }
    if (c === '[') { while (i < s.length && s[i] !== ']') i++; i++; continue; }
    if (c === ';') { while (i < s.length && s[i] !== '\n') i++; continue; }
    out += c;
    i++;
  }
  return out;
}

function countPlies(pgn) {
  const text = String(pgn || '');
  const idx = text.search(/\r?\n\s*\r?\n/);
  const moveText = idx === -1 ? '' : text.slice(idx);
  const cleaned = stripPgnNoise(moveText)
    .replace(/\d+\.+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  let plies = 0;
  for (const t of cleaned.split(' ')) {
    if (t === '*' || t === '1-0' || t === '0-1' || t === '1/2-1/2') continue;
    if (t === 'O-O' || t === 'O-O-O' || t === '0-0' || t === '0-0-0' || /^[KQRBNa-h]/.test(t)) plies++;
  }
  return plies;
}

function processGame(game, username) {
  const h = parsePgnHeaders(game.pgn);
  const wName = (game.white && game.white.username) || h.White || '';
  const bName = (game.black && game.black.username) || h.Black || '';

  let side = null;
  if (wName.toLowerCase() === username) side = 'white';
  else if (bName.toLowerCase() === username) side = 'black';
  if (!side) return null;

  const result = h.Result || '*';
  let outcome;
  if (result === '1-0') outcome = side === 'white' ? 'win' : 'loss';
  else if (result === '0-1') outcome = side === 'white' ? 'loss' : 'win';
  else if (result === '1/2-1/2') outcome = 'draw';
  else outcome = 'unknown';

  const rating = side === 'white'
    ? (game.white && game.white.rating) || parseInt(h.WhiteElo, 10) || null
    : (game.black && game.black.rating) || parseInt(h.BlackElo, 10) || null;
  const oppRating = side === 'white'
    ? (game.black && game.black.rating) || parseInt(h.BlackElo, 10) || null
    : (game.white && game.white.rating) || parseInt(h.WhiteElo, 10) || null;

  return {
    side,
    outcome,
    timeClass: String(game.time_class || '').toLowerCase(),
    eco: h.ECO || '',
    opening: openingFromUrl(h.ECOUrl) || h.Opening || '',
    rating,
    oppRating,
    opponent: side === 'white' ? bName : wName,
    endTime: game.end_time || null,
    url: game.url || '',
    plies: countPlies(game.pgn)
  };
}

function aggregate(games, username) {
  const a = {
    total: 0, wins: 0, losses: 0, draws: 0, unknown: 0,
    asWhite: { win: 0, loss: 0, draw: 0, total: 0 },
    asBlack: { win: 0, loss: 0, draw: 0, total: 0 },
    byTimeClass: {},
    openings: {},
    opponents: {},
    byOpponentStrength: {},
    pliesTotal: 0,
    meta: []
  };
  const ratingByMonth = {}; // 'YYYY-MM' -> { white, black }

  for (const g of games) {
    const p = processGame(g, username);
    if (!p) continue;
    a.total++;
    if (p.outcome === 'win') a.wins++;
    else if (p.outcome === 'loss') a.losses++;
    else if (p.outcome === 'draw') a.draws++;
    else a.unknown++;

    const sideAgg = p.side === 'white' ? a.asWhite : a.asBlack;
    sideAgg.total++;
    if (p.outcome === 'win') sideAgg.win++;
    else if (p.outcome === 'loss') sideAgg.loss++;
    else if (p.outcome === 'draw') sideAgg.draw++;

    const tc = p.timeClass || 'other';
    if (!a.byTimeClass[tc]) a.byTimeClass[tc] = { win: 0, loss: 0, draw: 0, total: 0, white: 0, black: 0 };
    const t = a.byTimeClass[tc];
    t.total++;
    if (p.side === 'white') t.white++; else t.black++;
    if (p.outcome === 'win') t.win++;
    else if (p.outcome === 'loss') t.loss++;
    else if (p.outcome === 'draw') t.draw++;

    if (p.opening || p.eco) {
      const key = p.opening || ('ECO ' + p.eco);
      if (!a.openings[key]) {
        a.openings[key] = {
          name: p.opening || '', eco: p.eco || '',
          white: { win: 0, loss: 0, draw: 0, total: 0 },
          black: { win: 0, loss: 0, draw: 0, total: 0 },
          pliesTotal: 0,
          byMonth: {},
          opponents: {}
        };
      }
      const o = a.openings[key];
      const s = p.side === 'white' ? o.white : o.black;
      s.total++;
      if (p.outcome === 'win') s.win++;
      else if (p.outcome === 'loss') s.loss++;
      else if (p.outcome === 'draw') s.draw++;

      if (p.plies) o.pliesTotal += p.plies;

      if (p.endTime) {
        const dm = toDate(p.endTime);
        if (dm) {
          const mth = dm.toISOString().slice(0, 7);
          if (!o.byMonth[mth]) o.byMonth[mth] = { win: 0, loss: 0, draw: 0, total: 0 };
          const bm = o.byMonth[mth];
          bm.total++;
          if (p.outcome === 'win') bm.win++;
          else if (p.outcome === 'loss') bm.loss++;
          else if (p.outcome === 'draw') bm.draw++;
        }
      }

      if (p.opponent) {
        const ok = p.opponent.toLowerCase();
        if (!o.opponents[ok]) o.opponents[ok] = { name: p.opponent, win: 0, loss: 0, draw: 0, total: 0 };
        const op = o.opponents[ok];
        op.total++;
        if (p.outcome === 'win') op.win++;
        else if (p.outcome === 'loss') op.loss++;
        else if (p.outcome === 'draw') op.draw++;
      }
    }

    if (p.opponent) {
      const ok = p.opponent.toLowerCase();
      if (!a.opponents[ok]) a.opponents[ok] = { name: p.opponent, win: 0, loss: 0, draw: 0, total: 0, openings: {}, recent: [] };
      const op = a.opponents[ok];
      op.total++;
      if (p.outcome === 'win') op.win++;
      else if (p.outcome === 'loss') op.loss++;
      else if (p.outcome === 'draw') op.draw++;

      if (p.opening || p.eco) {
        const k2 = p.opening || ('ECO ' + p.eco);
        if (!op.openings[k2]) op.openings[k2] = { name: p.opening || '', eco: p.eco || '', win: 0, loss: 0, draw: 0, total: 0 };
        const oo = op.openings[k2];
        oo.total++;
        if (p.outcome === 'win') oo.win++;
        else if (p.outcome === 'loss') oo.loss++;
        else if (p.outcome === 'draw') oo.draw++;
      }

      op.recent.push({ date: p.endTime ? toDate(p.endTime).toISOString() : null, outcome: p.outcome, opening: p.opening, eco: p.eco, url: p.url });
    }

    if (p.endTime && p.rating) {
      const d = toDate(p.endTime);
      if (d) {
        const month = d.toISOString().slice(0, 7);
        if (!ratingByMonth[month]) ratingByMonth[month] = { white: null, black: null };
        ratingByMonth[month][p.side] = p.rating;
      }
    }

    // сила соперника: сильнее/равные/слабее относительно рейтинга игрока (+/-50)
    if (p.rating != null && p.oppRating != null) {
      const diff = p.oppRating - p.rating;
      const band = diff > 50 ? 'stronger' : (diff < -50 ? 'weaker' : 'equal');
      if (!a.byOpponentStrength[band]) a.byOpponentStrength[band] = { win: 0, loss: 0, draw: 0, total: 0 };
      const bs = a.byOpponentStrength[band];
      bs.total++;
      if (p.outcome === 'win') bs.win++;
      else if (p.outcome === 'loss') bs.loss++;
      else if (p.outcome === 'draw') bs.draw++;
    }

    if (p.plies) a.pliesTotal += p.plies;

    a.meta.push({
      date: p.endTime ? toDate(p.endTime).toISOString() : null,
      side: p.side,
      outcome: p.outcome,
      opening: p.opening,
      eco: p.eco,
      opponent: p.opponent,
      rating: p.rating,
      oppRating: p.oppRating,
      plies: p.plies,
      url: p.url,
      timeClass: p.timeClass
    });
  }

  const openings = Object.values(a.openings)
    .map((o) => ({
      name: o.name || ('ECO ' + o.eco),
      eco: o.eco,
      white: o.white,
      black: o.black,
      total: o.white.total + o.black.total,
      score: +(o.white.total + o.black.total ? (o.white.win + o.black.win + 0.5 * (o.white.draw + o.black.draw)) / (o.white.total + o.black.total) : 0).toFixed(2),
      avgPlies: o.white.total + o.black.total ? Math.round(o.pliesTotal / (o.white.total + o.black.total)) : 0,
      byMonth: Object.keys(o.byMonth).sort().map((m) => ({ month: m, win: o.byMonth[m].win, loss: o.byMonth[m].loss, draw: o.byMonth[m].draw, total: o.byMonth[m].total })),
      opponents: Object.values(o.opponents).sort((x, y) => y.total - x.total).slice(0, 5)
    }))
    .sort((x, y) => y.total - x.total);

  const opponents = Object.values(a.opponents)
    .sort((x, y) => y.total - x.total)
    .slice(0, 20)
    .map((o) => ({
      name: o.name,
      win: o.win, loss: o.loss, draw: o.draw, total: o.total,
      score: +(o.total ? (o.win + 0.5 * o.draw) / o.total : 0).toFixed(2),
      openings: Object.values(o.openings).sort((x, y) => y.total - x.total).slice(0, 5),
      recent: o.recent.slice().sort((x, y) => (x.date < y.date ? 1 : -1)).slice(0, 3)
    }));

  const ratingHistory = Object.keys(ratingByMonth).sort().map((month) => ({
    month,
    white: ratingByMonth[month].white,
    black: ratingByMonth[month].black
  }));

  const perfByMonth = {};
  for (const m of a.meta) {
    if (!m.date) continue;
    const month = m.date.slice(0, 7);
    if (!perfByMonth[month]) perfByMonth[month] = { win: 0, loss: 0, draw: 0, total: 0 };
    const pm = perfByMonth[month];
    pm.total++;
    if (m.outcome === 'win') pm.win++;
    else if (m.outcome === 'loss') pm.loss++;
    else if (m.outcome === 'draw') pm.draw++;
  }
  const performanceByMonth = Object.keys(perfByMonth).sort().map((month) => ({
    month,
    win: perfByMonth[month].win,
    loss: perfByMonth[month].loss,
    draw: perfByMonth[month].draw,
    total: perfByMonth[month].total,
    score: +((perfByMonth[month].win + 0.5 * perfByMonth[month].draw) / perfByMonth[month].total * 100).toFixed(1)
  }));

  // последние партии (свежие первыми)
  const recentGames = a.meta.slice(-40).reverse();

  // форма за последние 20 партий
  const f20 = a.meta.slice(-20);
  const form = { games: f20.length, wins: 0, losses: 0, draws: 0, winRate: 0 };
  for (const m of f20) {
    if (m.outcome === 'win') form.wins++;
    else if (m.outcome === 'loss') form.losses++;
    else if (m.outcome === 'draw') form.draws++;
  }
  form.winRate = +(form.games ? (form.wins / form.games) * 100 : 0).toFixed(1);

  // серии побед/поражений
  let bestWinStreak = 0, bestLossStreak = 0, curType = null, curLen = 0;
  for (const m of a.meta) {
    const t = (m.outcome === 'win' || m.outcome === 'loss') ? m.outcome : null;
    if (t === curType) { curLen++; }
    else { curType = t; curLen = t ? 1 : 0; }
    if (t === 'win' && curLen > bestWinStreak) bestWinStreak = curLen;
    if (t === 'loss' && curLen > bestLossStreak) bestLossStreak = curLen;
  }
  let currentStreak = { type: 'none', len: 0 };
  if (a.meta.length) {
    const last = a.meta[a.meta.length - 1].outcome;
    if (last === 'win' || last === 'loss') {
      let len = 0;
      for (let i = a.meta.length - 1; i >= 0 && a.meta[i].outcome === last; i--) len++;
      currentStreak = { type: last, len };
    }
  }

  // быстрые поражения (<=15 ходов)
  const fastLossesAll = a.meta.filter((m) => m.outcome === 'loss' && m.plies && m.plies <= 30);
  const fastLosses = {
    count: fastLossesAll.length,
    games: fastLossesAll.slice(-20).reverse()
  };

  // быстрые победы (<=15 ходов)
  const fastWinsAll = a.meta.filter((m) => m.outcome === 'win' && m.plies && m.plies <= 30);
  const fastWins = {
    count: fastWinsAll.length,
    games: fastWinsAll.slice(-20).reverse()
  };

  // длинные партии (>=40 ходов) — индикатор эндшпиля
  const longAll = a.meta.filter((m) => m.plies && m.plies >= 80);
  const longGames = { count: longAll.length, win: 0, loss: 0, draw: 0 };
  for (const m of longAll) {
    if (m.outcome === 'win') longGames.win++;
    else if (m.outcome === 'loss') longGames.loss++;
    else if (m.outcome === 'draw') longGames.draw++;
  }

  const avgPlies = a.total ? Math.round(a.pliesTotal / a.total) : 0;

  // скачки рейтинга внутри одного контроля времени (детектор тильта/прогресса)
  const byTC = {};
  for (const m of a.meta) {
    if (m.rating == null || !m.date) continue;
    const tc = m.timeClass || 'other';
    if (tc === 'daily') continue; // ежедневные партии дают ложные скачки рейтинга
    if (!byTC[tc]) byTC[tc] = [];
    byTC[tc].push(m);
  }
  const swings = [];
  for (const tc of Object.keys(byTC)) {
    const list = byTC[tc];
    for (let i = 1; i < list.length; i++) {
      const delta = list[i].rating - list[i - 1].rating;
      if (delta) {
        swings.push({ date: list[i].date, rating: list[i].rating, delta, timeClass: tc, url: list[i].url, opponent: list[i].opponent });
      }
    }
  }
  swings.sort((a, b) => b.delta - a.delta);
  const ratingSwings = {
    gains: swings.filter((s) => s.delta > 0).slice(0, 5),
    drops: swings.filter((s) => s.delta < 0).slice(-5).reverse()
  };

  // стадии партии: дебют (<=15 ходов), миттельшпиль (16-40), эндшпиль (>40)
  const byStage = {
    opening: { win: 0, loss: 0, draw: 0, total: 0 },
    middlegame: { win: 0, loss: 0, draw: 0, total: 0 },
    endgame: { win: 0, loss: 0, draw: 0, total: 0 }
  };
  for (const m of a.meta) {
    if (!m.plies) continue;
    let stage;
    if (m.plies <= 30) stage = 'opening';
    else if (m.plies <= 80) stage = 'middlegame';
    else stage = 'endgame';
    const st = byStage[stage];
    st.total++;
    if (m.outcome === 'win') st.win++;
    else if (m.outcome === 'loss') st.loss++;
    else if (m.outcome === 'draw') st.draw++;
  }

  // лучшие партии — победы над соперниками на 100+ очков сильнее (только живые партии, не боты)
  const bestGames = a.meta
    .filter((m) => m.outcome === 'win' && m.rating != null && m.oppRating != null && m.oppRating - m.rating >= 100
      && m.timeClass !== 'daily'
      && !/^coach-/i.test(m.opponent || ''))
    .map((m) => ({ date: m.date, opponent: m.opponent, rating: m.rating, oppRating: m.oppRating, upset: m.oppRating - m.rating, opening: m.opening, eco: m.eco, plies: m.plies, url: m.url }))
    .sort((a, b) => b.upset - a.upset)
    .slice(0, 10);

  // последний соперник, которому проиграл
  let lastLoss = null;
  for (let i = a.meta.length - 1; i >= 0; i--) {
    const m = a.meta[i];
    if (m.outcome === 'loss') {
      lastLoss = { date: m.date, opponent: m.opponent, opening: m.opening, eco: m.eco, rating: m.rating, oppRating: m.oppRating, url: m.url, side: m.side };
      break;
    }
  }

  // сколько партий подряд за день — устаёшь ли (win-rate по номеру партии в дне)
  const dayGames = {};
  for (const m of a.meta) {
    if (!m.date) continue;
    if (m.timeClass === 'daily') continue;
    const day = m.date.slice(0, 10);
    if (!dayGames[day]) dayGames[day] = [];
    dayGames[day].push(m);
  }
  const pos = {};
  for (const day of Object.keys(dayGames)) {
    const list = dayGames[day].sort((a, b) => (a.date < b.date ? -1 : 1));
    list.forEach((m, i) => {
      const p = i >= 5 ? '6+' : String(i + 1);
      if (!pos[p]) pos[p] = { win: 0, loss: 0, draw: 0, total: 0 };
      const e = pos[p];
      e.total++;
      if (m.outcome === 'win') e.win++;
      else if (m.outcome === 'loss') e.loss++;
      else if (m.outcome === 'draw') e.draw++;
    });
  }
  const byGameOfDay = Object.keys(pos)
    .sort((a, b) => (a === '6+' ? 1 : b === '6+' ? -1 : parseInt(a, 10) - parseInt(b, 10)))
    .map((p) => ({
      position: p,
      win: pos[p].win, loss: pos[p].loss, draw: pos[p].draw, total: pos[p].total,
      score: +((pos[p].win + 0.5 * pos[p].draw) / pos[p].total * 100).toFixed(1)
    }));

  // win-rate по часам (UTC) — лучшее время для игры
  const hourStats = {};
  for (const m of a.meta) {
    if (!m.date) continue;
    if (m.timeClass === 'daily') continue;
    const h = new Date(m.date).getUTCHours();
    if (!hourStats[h]) hourStats[h] = { win: 0, loss: 0, draw: 0, total: 0 };
    const e = hourStats[h];
    e.total++;
    if (m.outcome === 'win') e.win++;
    else if (m.outcome === 'loss') e.loss++;
    else if (m.outcome === 'draw') e.draw++;
  }
  const byHour = [];
  for (let h = 0; h < 24; h++) {
    const e = hourStats[h];
    if (!e) { byHour.push({ hour: h, win: 0, loss: 0, draw: 0, total: 0, score: null }); continue; }
    byHour.push({ hour: h, win: e.win, loss: e.loss, draw: e.draw, total: e.total, score: +((e.win + 0.5 * e.draw) / e.total * 100).toFixed(1) });
  }

  return {
    total: a.total,
    wins: a.wins, losses: a.losses, draws: a.draws, unknown: a.unknown,
    winRate: +(a.total ? (a.wins / a.total) * 100 : 0).toFixed(1),
    asWhite: a.asWhite,
    asBlack: a.asBlack,
    byTimeClass: a.byTimeClass,
    byOpponentStrength: a.byOpponentStrength,
    openings,
    opponents,
    ratingHistory,
    performanceByMonth,
    recentGames,
    form,
    currentStreak,
    bestWinStreak,
    bestLossStreak,
    fastLosses,
    fastWins,
    longGames,
    avgPlies,
    ratingSwings,
    byStage,
    bestGames,
    byGameOfDay,
    byHour,
    lastLoss
  };
}

/* ------------------------------ Данные / кэш ------------------------------- */

function loadHistory() {
  try {
    const h = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    return Array.isArray(h) ? h : [];
  } catch (_) { return []; }
}

function saveHistory(list) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(list, null, 2));
}

async function getOpponentRating(username) {
  const cacheFile = path.join(OPPONENTS_DIR, username + '.json');
  if (fs.existsSync(cacheFile)) {
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (Date.now() - new Date(c.fetchedAt).getTime() < 7 * 24 * 3600 * 1000) {
        return { rating: c.rating, mode: c.mode };
      }
    } catch (_) {}
  }
  let result = { rating: null, mode: null };
  const stats = await fetchJson('https://api.chess.com/pub/player/' + username + '/stats').catch(() => null);
  if (stats) {
    const modes = ['chess_rapid', 'chess_blitz', 'chess_bullet'];
    for (const m of modes) {
      if (stats[m] && stats[m].last && stats[m].last.rating) {
        result = { rating: stats[m].last.rating, mode: m.replace('chess_', '') };
        break;
      }
    }
  }
  try {
    fs.writeFileSync(cacheFile, JSON.stringify({ rating: result.rating, mode: result.mode, fetchedAt: new Date().toISOString() }));
  } catch (_) {}
  return result;
}

function computeFormFromGames(games, username) {
  const sorted = games.slice().sort((a, b) => (b.end_time || 0) - (a.end_time || 0)).slice(0, 12);
  const form = { games: 0, wins: 0, losses: 0, draws: 0, winRate: 0, streak: { type: 'none', len: 0 } };
  const outcomes = [];
  const lower = username.toLowerCase();
  for (const g of sorted) {
    const w = g.white, b = g.black;
    if (!w || !b) continue;
    const isWhite = (w.username || '').toLowerCase() === lower;
    const res = isWhite ? w.result : b.result;
    let o;
    if (res === 'win') o = 'win';
    else if (res === 'checkmated' || res === 'resigned' || res === 'timeout' || res === 'abandoned') o = 'loss';
    else o = 'draw';
    outcomes.push(o);
    form.games++;
    if (o === 'win') form.wins++;
    else if (o === 'loss') form.losses++;
    else form.draws++;
  }
  form.winRate = form.games ? +((form.wins + 0.5 * form.draws) / form.games * 100).toFixed(1) : 0;
  if (outcomes.length && (outcomes[0] === 'win' || outcomes[0] === 'loss')) {
    let len = 0;
    for (const o of outcomes) { if (o === outcomes[0]) len++; else break; }
    form.streak = { type: outcomes[0], len };
  }
  return form;
}

async function getOpponentForm(username) {
  const cacheFile = path.join(OPPONENTS_FORM_DIR, username + '.json');
  if (fs.existsSync(cacheFile)) {
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (Date.now() - new Date(c.fetchedAt).getTime() < 24 * 3600 * 1000) {
        return c.form;
      }
    } catch (_) {}
  }
  let form = { games: 0, wins: 0, losses: 0, draws: 0, winRate: 0, streak: { type: 'none', len: 0 } };
  try {
    const archRes = await fetchJson('https://api.chess.com/pub/player/' + username + '/games/archives');
    const archives = (archRes.archives || []).slice(-2);
    const games = [];
    for (const aUrl of archives) {
      try {
        const r = await fetchJson(aUrl);
        if (r && Array.isArray(r.games)) games.push(...r.games);
      } catch (_) {}
      await sleep(100);
    }
    form = computeFormFromGames(games, username);
  } catch (_) {}
  try {
    fs.writeFileSync(cacheFile, JSON.stringify({ form, fetchedAt: new Date().toISOString() }));
  } catch (_) {}
  return form;
}

function recordAnalysis(username, result) {
  const list = loadHistory();
  const now = new Date().toISOString();
  const name = (result.profile && result.profile.name) || username;
  const existing = list.find((e) => e.username === username);
  if (existing) {
    existing.name = name;
    existing.lastSeen = now;
    existing.analyzedCount = (existing.analyzedCount || 0) + 1;
    existing.gamesTotal = result.total;
    existing.monthsFetched = result.monthsFetched;
    existing.winRate = result.winRate;
  } else {
    list.unshift({
      username,
      name,
      firstSeen: now,
      lastSeen: now,
      analyzedCount: 1,
      gamesTotal: result.total,
      monthsFetched: result.monthsFetched,
      winRate: result.winRate
    });
  }
  list.sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1));
  saveHistory(list);
  return list;
}

async function getProfile(username) {
  const cacheFile = path.join(PLAYERS_DIR, username + '.json');
  if (fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (Date.now() - new Date(cached.fetchedAt).getTime() < PROFILE_TTL_MS) {
        return cached;
      }
    } catch (_) { /* повреждённый кэш — перечитаем */ }
  }

  const profile = await fetchJson('https://api.chess.com/pub/player/' + username);
  const stats = await fetchJson('https://api.chess.com/pub/player/' + username + '/stats').catch(() => null);

  const obj = {
    username: profile.username || username,
    profile,
    stats,
    fetchedAt: new Date().toISOString()
  };
  fs.writeFileSync(cacheFile, JSON.stringify(obj, null, 2));
  return obj;
}

async function analyzePlayer(username, months, refresh) {
  username = String(username || '').toLowerCase();
  const cacheFile = path.join(GAMES_DIR, username + '.json');
  if (!refresh && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      const covered = cached.monthsFetched || 0;
      const allAvailable = cached.archivesCount || 0;
      const asked = months === 'all' ? Infinity : (parseInt(months, 10) || 12);
      const coveredEnough = covered >= asked || (allAvailable > 0 && covered >= allAvailable);
      if (coveredEnough && cached.schemaVersion === SCHEMA_VERSION) {
        return cached;
      }
    } catch (_) { /* игнор — пересчитаем */ }
  }

  const profile = await getProfile(username);

  const archivesRes = await fetchJson('https://api.chess.com/pub/player/' + username + '/games/archives');
  const archives = archivesRes.archives || [];

  let selected = archives;
  if (months !== 'all') {
    const n = Math.max(1, parseInt(months, 10) || 12);
    selected = archives.slice(-n);
  } else {
    selected = archives.slice(-MAX_ARCHIVE_MONTHS);
  }

  const games = [];
  let failed = 0;
  for (const archiveUrl of selected) {
    try {
      const res = await fetchJson(archiveUrl);
      if (res && Array.isArray(res.games)) games.push(...res.games);
    } catch (e) {
      failed++;
    }
    await sleep(FETCH_DELAY_MS);
  }

  const analysis = aggregate(games, username);

  const result = {
    username,
    schemaVersion: SCHEMA_VERSION,
    profile: profile.profile,
    stats: profile.stats,
    fetchedAt: new Date().toISOString(),
    archivesCount: archives.length,
    monthsFetched: selected.length,
    monthsFailed: failed,
    ...analysis
  };
  fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2));
  return result;
}

/* ------------------------------ HTTP-сервер ------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8'
};

function sendJson(res, obj, status = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.normalize(path.join(STATIC_DIR, rel));
  if (filePath !== STATIC_DIR && !filePath.startsWith(STATIC_DIR + path.sep)) {
    return sendJson(res, { error: 'Forbidden' }, 403);
  }
  fs.readFile(filePath, (err, data) => {
    if (err) return sendJson(res, { error: 'Not found: ' + rel }, 404);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

async function handleApi(parsed, res) {
  const { pathname, query } = parsed;

  if (pathname === '/api/health') {
    return sendJson(res, { ok: true, time: new Date().toISOString() });
  }

  if (pathname === '/api/history') {
    return sendJson(res, { players: loadHistory() });
  }

  if (pathname === '/api/opponents') {
    const username = extractUsername(query.username || query.input || '');
    if (!username) return sendJson(res, { error: 'Не удалось извлечь username' }, 400);
    let opponents = [];
    const gf = path.join(GAMES_DIR, username + '.json');
    if (fs.existsSync(gf)) {
      try { opponents = JSON.parse(fs.readFileSync(gf, 'utf8')).opponents || []; } catch (_) {}
    }
    const limit = Math.min(parseInt(query.limit, 10) || 15, 30);
    const out = [];
    for (const o of opponents.slice(0, limit)) {
      const r = await getOpponentRating(o.name);
      out.push({ name: o.name, win: o.win, loss: o.loss, draw: o.draw, total: o.total, score: o.score, rating: r.rating, mode: r.mode });
      await sleep(150);
    }
    return sendJson(res, { opponents: out });
  }

  if (pathname === '/api/opponents-form') {
    const username = extractUsername(query.username || query.input || '');
    if (!username) return sendJson(res, { error: 'Не удалось извлечь username' }, 400);
    let opponents = [];
    const gf = path.join(GAMES_DIR, username + '.json');
    if (fs.existsSync(gf)) {
      try { opponents = JSON.parse(fs.readFileSync(gf, 'utf8')).opponents || []; } catch (_) {}
    }
    const lost = opponents.filter((o) => o.loss > 0).sort((a, b) => b.loss - a.loss);
    const limit = Math.min(parseInt(query.limit, 10) || 10, 20);
    const out = [];
    for (const o of lost.slice(0, limit)) {
      const [rating, form] = await Promise.all([getOpponentRating(o.name), getOpponentForm(o.name)]);
      out.push({ name: o.name, loss: o.loss, win: o.win, draw: o.draw, total: o.total, score: o.score, rating: rating.rating, mode: rating.mode, form });
      await sleep(150);
    }
    return sendJson(res, { opponents: out });
  }

  if (pathname === '/api/compare') {
    const username = extractUsername(query.username || query.input || '');
    if (!username) return sendJson(res, { error: 'Не удалось извлечь username' }, 400);
    const userFile = path.join(GAMES_DIR, username + '.json');
    if (!fs.existsSync(userFile)) {
      return sendJson(res, { error: 'Сначала проанализируй игрока ' + username }, 404);
    }
    let userData;
    try { userData = JSON.parse(fs.readFileSync(userFile, 'utf8')); } catch (_) { return sendJson(res, { error: 'Кэш повреждён' }, 500); }
    const lastLoss = userData.lastLoss;
    if (!lastLoss || !lastLoss.opponent) {
      return sendJson(res, { error: 'Не найдено поражений' }, 404);
    }
    const opponent = await analyzePlayer(lastLoss.opponent, 'all', false);
    return sendJson(res, { user: userData, opponent, lastLoss });
  }

  if (pathname === '/api/player' || pathname === '/api/analyze') {
    const input = query.input || query.username || '';
    const username = extractUsername(input);
    if (!username) {
      return sendJson(res, { error: 'Не удалось извлечь username из введённых данных' }, 400);
    }
    try {
      if (pathname === '/api/player') {
        const data = await getProfile(username);
        return sendJson(res, data);
      }
      const months = query.months === 'all' ? 'all' : (parseInt(query.months, 10) || 12);
      const refresh = query.refresh === '1' || query.refresh === 'true';
      const data = await analyzePlayer(username, months, refresh);
      recordAnalysis(username, data);
      return sendJson(res, data);
    } catch (e) {
      if (e.status === 404) {
        return sendJson(res, { error: 'Игрок "' + username + '" не найден на chess.com' }, 404);
      }
      throw e;
    }
  }

  return sendJson(res, { error: 'Unknown endpoint' }, 404);
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  let pathname;
  try {
    pathname = decodeURIComponent(parsed.pathname || '/');
  } catch (_) {
    pathname = '/';
  }

  (async () => {
    try {
      if (req.method === 'GET' && pathname.startsWith('/api/')) {
        await handleApi(parsed, res);
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        serveStatic(pathname, res);
      } else {
        sendJson(res, { error: 'Method not allowed' }, 405);
      }
    } catch (e) {
      if (!res.headersSent) {
        sendJson(res, { error: e.message || 'Внутренняя ошибка сервера' }, e.status || 500);
      } else {
        res.end();
      }
    }
  })();
});

server.listen(PORT, HOST, () => {
  console.log('==============================================');
  console.log('  Chess Stats — сервер запущен');
  console.log('  Адрес:  http://localhost:' + PORT);
  console.log('  Остановить: Ctrl+C');
  console.log('==============================================');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('Порт ' + PORT + ' уже занят. Освободите порт или запустите с PORT=<другой>.');
  } else {
    console.error('Ошибка сервера:', e.message);
  }
  process.exit(1);
});
