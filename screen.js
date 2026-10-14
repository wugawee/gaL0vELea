// ============================================================
// 收盤技術篩選（GitHub Actions 每日自動執行）
// 讀 index.html 的 STOCKS 清單 → 透過 Worker 抓 1 年日線 + 法人
// → 算指標、跑篩選 → 寫 data/latest.json、data/bars.json、data/history/YYYY-MM-DD.json
// 不需要任何密鑰：FinMind token 在 Worker 裡。
// ============================================================
const fs = require('fs');
const path = require('path');

const WORKER = 'https://gentle-mountain-7c00.wugawee.workers.dev';
const ROOT = path.resolve(__dirname, '..');
const MOCK = process.env.SCREEN_MOCK === '1';

// ── 1. 從 index.html 讀股票清單（只維護一份清單）──
function loadStocks() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const a = html.indexOf('const STOCKS=['); const b = html.indexOf('];', a);
  if (a < 0 || b < 0) throw new Error('index.html 找不到 STOCKS');
  const blk = html.slice(a, b);
  const re = /\{sym:"([^"]+)",name:"([^"]+)",mkt:"([^"]+)",cur:"([^"]+)"(?:,tag:"([^"]*)")?\}/g;
  const out = []; let m;
  while ((m = re.exec(blk))) out.push({ sym: m[1], name: m[2], mkt: m[3], cur: m[4], tag: m[5] || '' });
  if (out.length < 10) throw new Error('STOCKS 解析失敗，只有 ' + out.length + ' 檔');
  return out;
}

// ── 2. 抓資料（重試 3 次，指數退避）──
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJSON(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (screen-bot)' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { last = e; await sleep(1500 * (i + 1) * (i + 1)); }
  }
  throw last;
}
const ymd = (ts, off) => new Date((ts + off) * 1000).toISOString().slice(0, 10);

async function fetchChart(sym) {
  const urls = [
    `${WORKER}/?symbol=${encodeURIComponent(sym)}&range=1y&interval=1d`,
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1y&interval=1d`, // 備援
  ];
  let last;
  for (const u of urls) {
    try {
      const j = await getJSON(u);
      const r = j.chart && j.chart.result && j.chart.result[0];
      if (!r || !r.timestamp) throw new Error('chart 無資料');
      const off = r.meta.gmtoffset || 0, q = r.indicators.quote[0];
      const bars = [];
      for (let i = 0; i < r.timestamp.length; i++) {
        if (q.close[i] == null || q.volume[i] == null) continue; // 跳過 Yahoo 空白日
        bars.push({ d: ymd(r.timestamp[i], off), o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] });
      }
      if (bars.length < 70) throw new Error('bars 不足 ' + bars.length);
      return bars;
    } catch (e) { last = e; }
  }
  throw last;
}

// 法人：FinMind（經 Worker）→ 每日 {date:{f,t}}，單位：股
async function fetchInstFinMind(id, start) {
  const j = await getJSON(`${WORKER}/?type=inst&id=${id}&start=${start}&_t=${Date.now()}`);
  if (!j || !Array.isArray(j.data)) throw new Error('inst 格式錯誤');
  const m = {};
  for (const x of j.data) {
    const o = (m[x.date] = m[x.date] || { f: 0, t: 0 });
    if (x.name === 'Foreign_Investor' || x.name === 'Foreign_Dealer_Self') o.f += x.buy - x.sell;
    if (x.name === 'Investment_Trust') o.t += x.buy - x.sell;
  }
  return m;
}

// 當日法人：證交所 T86（上市）／櫃買中心（上櫃）官方資料，約 16:30 後公布
// 回傳 {id:{f,t}}；失敗回傳 null（不中斷，改用 FinMind）
function pickCol(fields, ...keys) {
  return fields.findIndex(f => keys.every(k => String(f).includes(k)));
}
async function fetchTWSEToday(dateYMD) {
  try {
    const d8 = dateYMD.replace(/-/g, '');
    const j = await getJSON(`https://www.twse.com.tw/rwd/zh/fund/T86?date=${d8}&selectType=ALLBUT0999&response=json`, 2);
    if (!j || !j.fields || !j.data || j.stat !== 'OK') return null;
    const f = j.fields;
    const iId = pickCol(f, '證券代號'), iF = pickCol(f, '外陸資買賣超'), iFD = pickCol(f, '外資自營商買賣超'), iT = pickCol(f, '投信買賣超');
    if (iId < 0 || iF < 0 || iT < 0) return null;
    const num = s => Number(String(s).replace(/,/g, '')) || 0;
    const out = {};
    for (const row of j.data) out[String(row[iId]).trim()] = { f: num(row[iF]) + (iFD >= 0 ? num(row[iFD]) : 0), t: num(row[iT]) };
    return out;
  } catch (e) { return null; }
}
async function fetchTPExToday(dateYMD) {
  try {
    const ds = dateYMD.replace(/-/g, '/');
    const j = await getJSON(`https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?type=Daily&sect=EW&date=${ds}&response=json`, 2);
    const t = j && j.tables && j.tables[0];
    if (!t || !t.fields || !t.data) return null;
    const f = t.fields;
    const iId = pickCol(f, '代號'), iF = pickCol(f, '外資', '買賣超'), iFD = pickCol(f, '外資自營', '買賣超'), iT = pickCol(f, '投信', '買賣超');
    if (iId < 0 || iF < 0 || iT < 0) return null;
    const num = s => Number(String(s).replace(/,/g, '')) || 0;
    const out = {};
    for (const row of t.data) out[String(row[iId]).trim()] = { f: num(row[iF]) + (iFD >= 0 && iFD !== iF ? num(row[iFD]) : 0), t: num(row[iT]) };
    return out;
  } catch (e) { return null; }
}

// ── 3. 指標與篩選 ──
const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
const r2 = x => (x == null ? null : Math.round(x * 100) / 100);
const ma = (bars, n, i) => (i + 1 >= n ? avg(bars.slice(i - n + 1, i + 1).map(b => b.c)) : null);

function analyze(s, bars, inst) {
  const i = bars.length - 1, x = bars[i], p = bars[i - 1];
  const prev20 = bars.slice(i - 20, i);
  const av20 = avg(prev20.map(b => b.v));
  const hi20 = Math.max(...prev20.map(b => b.c));
  const hi60 = Math.max(...bars.slice(Math.max(0, i - 59), i + 1).map(b => b.h));
  const ma5 = ma(bars, 5, i), ma20 = ma(bars, 20, i), ma60 = ma(bars, 60, i);
  const ma20p5 = ma(bars, 20, i - 5), ma20p = ma(bars, 20, i - 1);
  const ret20 = x.c / bars[i - 20].c - 1;
  const chg = x.c / p.c - 1;
  const limitUps = [0, 1, 2].every(k => bars[i - k].c / bars[i - k - 1].c - 1 >= 0.095);

  // 法人（單位換成張）
  const g = d => (inst && inst[d]) ? inst[d] : null;
  const today = g(x.d);
  const last10 = bars.slice(i - 9, i + 1).map(b => g(b.d)).filter(Boolean);
  const f10 = last10.reduce((a, b) => a + b.f, 0) / 1000, t10 = last10.reduce((a, b) => a + b.t, 0) / 1000;
  const streak = key => { let n = 0; for (let k = i; k >= 0; k--) { const o = g(bars[k].d); if (!o || o[key] <= 0) break; n++; } return n; };
  const instOut = today ? { date: x.d, f: Math.round(today.f / 1000), t: Math.round(today.t / 1000), f10: Math.round(f10), t10: Math.round(t10), tStreak: streak('t'), fStreak: streak('f'), fPct: r2(today.f / x.v * 100) } : { date: null, pending: true, f10: Math.round(f10), t10: Math.round(t10) };

  const volRatio = x.v / av20;
  const breakout = x.c > hi20;
  // 短線 S1：爆量 3 倍 + 突破 20 日高 + 投信當日買超 + 近 20 日未漲超過 30% + 非連 3 根漲停
  const S1 = s.mkt === 'TW' ? (volRatio >= 3 && breakout && !!today && today.t > 0 && ret20 <= 0.30 && !limitUps) : false;
  // 美股／無法人版：只看量價（供參考，報告標示「無法人」）
  const S1v = volRatio >= 3 && breakout && ret20 <= 0.30 && !limitUps;
  // 波段 W1（候選，上線前需回測）：均線多頭且月線向上、價在月線 ±3% 或剛站回、法人 10 日淨買為正、近 20 日漲幅 <20%
  const nearMa20 = ma20 && Math.abs(x.c / ma20 - 1) <= 0.03;
  const reclaim = ma20 && ma20p && x.c > ma20 && p.c <= ma20p;
  const W1 = !!(ma5 && ma20 && ma60 && ma20p5 && ma5 > ma20 && ma20 > ma60 && ma20 > ma20p5 && (nearMa20 || reclaim) && (f10 > 0 || t10 > 0) && ret20 < 0.20);

  return {
    sym: s.sym, name: s.name, tag: s.tag, mkt: s.mkt, status: 'ok', asOf: x.d,
    close: x.c, chgPct: r2(chg * 100), vol: Math.round(x.v / 1000), volRatio: r2(volRatio),
    ret20Pct: r2(ret20 * 100), distHi60Pct: r2((x.c / hi60 - 1) * 100), hi20: r2(hi20), hi60: r2(hi60),
    ma5: r2(ma5), ma20: r2(ma20), ma60: r2(ma60), aboveMa20: ma20 ? x.c > ma20 : null,
    low: x.l, inst: instOut,
    signals: { S1, S1v, W1, breakout, volSpike: volRatio >= 3 },
    entry: { limitLow: r2(x.c * 0.98), limitHigh: r2(x.c * 1.01), gapSkipAbove: r2(x.c * 1.03), invalidBelow: x.l },
  };
}

// ── 4. 主流程 ──
(async () => {
  const stocks = loadStocks();
  const tw = stocks.filter(s => s.mkt === 'TW');
  const start = new Date(Date.now() - 370 * 86400e3).toISOString().slice(0, 10);
  const results = [], errors = [], bars = {};

  // 當日官方法人（先抓一次，所有股票共用）
  const nowTW = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  let twseToday = null, tpexToday = null;
  if (!MOCK) { twseToday = await fetchTWSEToday(nowTW); tpexToday = await fetchTPExToday(nowTW); }

  for (const s of stocks) {
    try {
      let b, inst = null;
      if (MOCK) { b = mockBars(s); inst = s.mkt === 'TW' ? mockInst(b) : null; }
      else {
        b = await fetchChart(s.sym);
        if (s.mkt === 'TW' && !s.sym.startsWith('^')) {
          const id = s.sym.replace(/\.TWO?$/, '');
          try { inst = await fetchInstFinMind(id, start); } catch (e) { inst = {}; errors.push({ sym: s.sym, stage: 'inst', msg: String(e.message || e) }); }
          // 官方當日資料優先覆蓋（FinMind 可能較晚更新）
          const off = (s.sym.endsWith('.TWO') ? tpexToday : twseToday);
          const lastD = b[b.length - 1].d;
          if (off && off[id] && lastD === nowTW) inst[lastD] = off[id];
        }
      }
      bars[s.sym] = { bars: b, inst };
      if (s.sym.startsWith('^')) { results.push({ sym: s.sym, name: s.name, mkt: s.mkt, status: 'ok', index: true, asOf: b[b.length - 1].d, close: b[b.length - 1].c, chgPct: r2((b[b.length - 1].c / b[b.length - 2].c - 1) * 100) }); continue; }
      results.push(analyze(s, b, inst));
    } catch (e) {
      errors.push({ sym: s.sym, stage: 'chart', msg: String(e.message || e) });
      results.push({ sym: s.sym, name: s.name, tag: s.tag, mkt: s.mkt, status: 'fail' });
    }
    await sleep(MOCK ? 0 : 250);
  }

  // 族群強度：同標籤裡「站上月線且量 ≥1.5 倍」的檔數
  const byTag = {};
  for (const r of results) if (r.status === 'ok' && !r.index && r.tag) {
    const o = (byTag[r.tag] = byTag[r.tag] || { total: 0, strong: 0 });
    o.total++; if (r.aboveMa20 && r.volRatio >= 1.5) o.strong++;
  }
  for (const r of results) if (r.tag && byTag[r.tag]) r.group = byTag[r.tag];

  const asOfTW = results.filter(r => r.mkt === 'TW' && r.asOf).map(r => r.asOf).sort().pop() || null;
  const instDates = results.filter(r => r.inst && r.inst.date).map(r => r.inst.date);
  const out = {
    generatedAt: new Date().toISOString(), asOfTW,
    instCoverage: { twStocks: tw.filter(s => !s.sym.startsWith('^')).length, withTodayInst: instDates.filter(d => d === asOfTW).length, source: { twse: !!twseToday, tpex: !!tpexToday } },
    lists: {
      short: results.filter(r => r.signals && r.signals.S1).map(r => r.sym),
      shortNoInst: results.filter(r => r.signals && r.signals.S1v && !r.signals.S1).map(r => r.sym),
      swingCandidate: results.filter(r => r.signals && r.signals.W1).map(r => r.sym),
    },
    groups: byTag, ok: results.filter(r => r.status === 'ok').length, failed: errors.filter(e => e.stage === 'chart').length,
    errors, stocks: results,
  };
  fs.mkdirSync(path.join(ROOT, 'data', 'history'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'data', 'latest.json'), JSON.stringify(out, null, 1));
  fs.writeFileSync(path.join(ROOT, 'data', 'bars.json'), JSON.stringify(bars));
  if (asOfTW) fs.writeFileSync(path.join(ROOT, 'data', 'history', asOfTW + '.json'), JSON.stringify({ ...out, stocks: out.stocks }, null, 1));
  console.log(`asOf=${asOfTW} ok=${out.ok} failed=${out.failed} todayInst=${out.instCoverage.withTodayInst}/${out.instCoverage.twStocks} short=${out.lists.short.join(',')||'-'} swing=${out.lists.swingCandidate.join(',')||'-'}`);
  if (errors.length) console.log('errors:', JSON.stringify(errors));
  if (out.ok < stocks.length * 0.9) { console.error('抓取成功率低於 90%，標記失敗'); process.exit(1); }
})();

// ── 測試用假資料 ──
function mockBars(s) {
  let seed = [...s.sym].reduce((a, c) => a + c.charCodeAt(0), 7); const R = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  const bars = []; let p = 100; const t0 = Date.UTC(2025, 9, 1);
  for (let i = 0; i < 250; i++) { const d = new Date(t0 + i * 86400e3); if (d.getUTCDay() % 6 === 0) continue; const o = p, c = p * (1 + (R() - 0.5) * 0.06); bars.push({ d: d.toISOString().slice(0, 10), o, h: Math.max(o, c) * (1 + R() * 0.01), l: Math.min(o, c) * (1 - R() * 0.01), c, v: Math.round(1e6 + R() * 3e6) }); p = c; }
  if (s.sym === '2330.TW') { const l = bars[bars.length - 1]; l.c = Math.max(...bars.slice(-21, -1).map(b => b.c)) * 1.02; l.v = 2e7; l.h = Math.max(l.h, l.c); }
  return bars;
}
function mockInst(bars) { const m = {}; bars.forEach((b, i) => { m[b.d] = { f: (i % 3 - 1) * 500000, t: i % 2 ? 200000 : -100000 }; }); m[bars[bars.length - 1].d] = { f: 800000, t: 300000 }; return m; }
