// ============================================================
// 收盤技術篩選 v3（GitHub Actions 每日自動執行）
// 讀 index.html 的 STOCKS 清單 → Worker 抓 1 年日線 + 法人
// → 用證交所／櫃買中心官方資料補 Yahoo 缺的日線（最新一天常是空的）；櫃買被擋就改走 Worker 或 FinMind
// → 算指標、跑篩選 → 寫 data/latest.json、data/bars.json、data/history/YYYY-MM-DD.json
// 不需要任何密鑰：FinMind token 在 Worker 裡。
// ============================================================
const fs = require('fs');
const path = require('path');

const WORKER = 'https://gentle-mountain-7c00.wugawee.workers.dev';
const ROOT = fs.existsSync(path.join(__dirname, 'index.html')) ? __dirname : path.resolve(__dirname, '..');
const MOCK = process.env.SCREEN_MOCK === '1';
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36' };

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

// ── 2. 工具 ──
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJSON(url, tries = 3, check = null) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: UA });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (check && !check(j)) throw new Error('格式不符');
      return j;
    } catch (e) { last = e; if (i < tries - 1) await sleep(2000 * (i + 1)); }
  }
  throw last;
}
const ymd = (ts, off) => new Date((ts + off) * 1000).toISOString().slice(0, 10);
const num = s => { const v = Number(String(s).replace(/,/g, '').trim()); return Number.isFinite(v) ? v : null; };
const pickCol = (fields, ...keys) => fields.findIndex(f => keys.every(k => String(f).includes(k)));
const r2 = x => (x == null ? null : Math.round(x * 100) / 100);
const avg = a => a.reduce((x, y) => x + y, 0) / a.length;

// 台北時間；14:00 以後才算「今天已收盤」
function taipeiNow() { return new Date(Date.now() + 8 * 3600e3); }
function recentTradeDates(n) {
  const t = taipeiNow(); let d = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
  if (t.getUTCHours() < 14) d = new Date(d.getTime() - 86400e3);
  const out = [];
  while (out.length < n) { const wd = d.getUTCDay(); if (wd !== 0 && wd !== 6) out.push(d.toISOString().slice(0, 10)); d = new Date(d.getTime() - 86400e3); }
  return out; // 新→舊，平日（含假日，官方沒資料就自然跳過）
}

// ── 3. Yahoo 日線（經 Worker，備援直連）──
async function fetchChart(sym) {
  const urls = [
    `${WORKER}/?symbol=${encodeURIComponent(sym)}&range=1y&interval=1d&_t=${Date.now()}`,
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1y&interval=1d`,
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
        if (q.close[i] == null || q.volume[i] == null) continue; // Yahoo 空白日先跳過，之後用官方資料補
        bars.push({ d: ymd(r.timestamp[i], off), o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i], src: 'yahoo' });
      }
      if (bars.length < 25) throw new Error('bars 不足 ' + bars.length);
      return bars;
    } catch (e) { last = e; }
  }
  throw last;
}
// Yahoo 小時線 → 當日估計 K 棒（最後手段；成交量不可靠，標 est）
async function fetchEstBar(sym, dateYMD) {
  try {
    const j = await getJSON(`${WORKER}/?symbol=${encodeURIComponent(sym)}&range=5d&interval=1h&_t=${Date.now()}`, 2);
    const r = j.chart && j.chart.result && j.chart.result[0]; if (!r || !r.timestamp) return null;
    const off = r.meta.gmtoffset || 0, q = r.indicators.quote[0]; let o = null, h = -Infinity, l = Infinity, c = null, v = 0;
    for (let i = 0; i < r.timestamp.length; i++) {
      if (ymd(r.timestamp[i], off) !== dateYMD || q.close[i] == null) continue;
      if (o == null) o = q.open[i]; h = Math.max(h, q.high[i]); l = Math.min(l, q.low[i]); c = q.close[i]; v += q.volume[i] || 0;
    }
    return o == null ? null : { d: dateYMD, o, h, l, c, v, src: 'est' };
  } catch (e) { return null; }
}

// ── 4. 官方日線：證交所 MI_INDEX（上市）／櫃買 afterTrading/otc（上櫃）──
// 回傳 {代號:{o,h,l,c,v}}；當天沒資料（假日）或抓不到回傳 null
async function fetchTWSEDay(dateYMD) {
  try {
    const j = await getJSON(`https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${dateYMD.replace(/-/g, '')}&type=ALLBUT0999&response=json`, 2);
    const tables = j.tables || (j.fields ? [j] : []);
    const t = tables.find(x => x.fields && pickCol(x.fields, '證券代號') >= 0 && pickCol(x.fields, '收盤價') >= 0);
    if (!t || !t.data || !t.data.length) return null;
    const f = t.fields, iId = pickCol(f, '證券代號'), iV = pickCol(f, '成交股數'), iO = pickCol(f, '開盤價'), iH = pickCol(f, '最高價'), iL = pickCol(f, '最低價'), iC = pickCol(f, '收盤價');
    const out = {};
    for (const row of t.data) { const c = num(row[iC]); if (c == null) continue; out[String(row[iId]).trim()] = { o: num(row[iO]) ?? c, h: num(row[iH]) ?? c, l: num(row[iL]) ?? c, c, v: num(row[iV]) ?? 0 }; }
    return Object.keys(out).length ? out : null;
  } catch (e) { return null; }
}
function parseTPExQuotes(j) {
  const tables = j && (j.tables || (j.fields ? [j] : [])) || [];
  const t = tables.find(x => x.fields && pickCol(x.fields, '代號') >= 0 && pickCol(x.fields, '收盤') >= 0);
  if (!t || !t.data || !t.data.length) return null;
  const f = t.fields, iId = pickCol(f, '代號'), iV = pickCol(f, '成交股數'), iO = pickCol(f, '開盤'), iH = pickCol(f, '最高'), iL = pickCol(f, '最低'), iC = pickCol(f, '收盤');
  const out = {};
  for (const row of t.data) { const c = num(row[iC]); if (c == null) continue; out[String(row[iId]).trim()] = { o: num(row[iO]) ?? c, h: num(row[iH]) ?? c, l: num(row[iL]) ?? c, c, v: num(row[iV]) ?? 0 }; }
  return Object.keys(out).length ? out : null;
}
// 櫃買中心常擋 GitHub 的 IP：先直連，失敗改經 Worker 轉接
async function tpexJSON(p, dateYMD, extra) {
  const ds = dateYMD.replace(/-/g, '/');
  const direct = `https://www.tpex.org.tw/www/zh-tw/${p}?date=${ds}&${extra}&response=json`;
  const viaWorker = `${WORKER}/?type=tpex&path=${encodeURIComponent(p)}&date=${ds}&extra=${encodeURIComponent(extra)}&_t=${Date.now()}`;
  for (const [u, tries] of [[direct, 1], [viaWorker, 2]]) { try { const j = await getJSON(u, tries); if (j && (j.tables || j.fields)) return j; } catch (e) { } }
  return null;
}
async function fetchTPExDay(dateYMD) {
  for (const [p, extra] of [['afterTrading/dailyQuotes', 'type=EW'], ['afterTrading/otc', 'type=EW']]) {
    const o = parseTPExQuotes(await tpexJSON(p, dateYMD, extra)); if (o) return o;
  }
  return null;
}
// FinMind 日線（經 Worker）：{date:{o,h,l,c,v}}，官方抓不到時用
async function fetchFinMindPrice(id, start) {
  const j = await getJSON(`${WORKER}/?type=fm&dataset=TaiwanStockPrice&id=${id}&start=${start}&_t=${Date.now()}`, 2, x => x && Array.isArray(x.data));
  const m = {};
  for (const x of j.data) { if (x.close == null) continue; m[x.date] = { o: x.open ?? x.close, h: x.max ?? x.close, l: x.min ?? x.close, c: x.close, v: x.Trading_Volume ?? 0 }; }
  return m;
}
// 官方當日法人：證交所 T86／櫃買 insti
async function fetchTWSEInst(dateYMD) {
  try {
    const j = await getJSON(`https://www.twse.com.tw/rwd/zh/fund/T86?date=${dateYMD.replace(/-/g, '')}&selectType=ALLBUT0999&response=json`, 2);
    if (!j || !j.fields || !j.data || !j.data.length) return null;
    const f = j.fields, iId = pickCol(f, '證券代號'), iF = pickCol(f, '外陸資買賣超'), iFD = pickCol(f, '外資自營商買賣超'), iT = pickCol(f, '投信買賣超');
    if (iId < 0 || iF < 0 || iT < 0) return null;
    const out = {};
    for (const row of j.data) out[String(row[iId]).trim()] = { f: (num(row[iF]) || 0) + (iFD >= 0 ? (num(row[iFD]) || 0) : 0), t: num(row[iT]) || 0 };
    return out;
  } catch (e) { return null; }
}
async function fetchTPExInst(dateYMD) {
  try {
    const j = await tpexJSON('insti/dailyTrade', dateYMD, 'type=Daily&sect=EW');
    const t = j && j.tables && j.tables.find(x => x.fields && pickCol(x.fields, '代號') >= 0 && pickCol(x.fields, '投信', '買賣超') >= 0); if (!t || !t.data || !t.data.length) return null;
    const f = t.fields, iId = pickCol(f, '代號'), iF = pickCol(f, '外資', '買賣超'), iFD = pickCol(f, '外資自營', '買賣超'), iT = pickCol(f, '投信', '買賣超');
    if (iId < 0 || iF < 0 || iT < 0) return null;
    const out = {};
    for (const row of t.data) out[String(row[iId]).trim()] = { f: (num(row[iF]) || 0) + (iFD >= 0 && iFD !== iF ? (num(row[iFD]) || 0) : 0), t: num(row[iT]) || 0 };
    return out;
  } catch (e) { return null; }
}
// FinMind 法人歷史（經 Worker）→ {date:{f,t}}，單位：股
async function fetchInstFinMind(id, start) {
  const j = await getJSON(`${WORKER}/?type=inst&id=${id}&start=${start}&_t=${Date.now()}`, 3, x => x && Array.isArray(x.data));
  const m = {};
  for (const x of j.data) {
    const o = (m[x.date] = m[x.date] || { f: 0, t: 0 });
    if (x.name === 'Foreign_Investor' || x.name === 'Foreign_Dealer_Self') o.f += x.buy - x.sell;
    if (x.name === 'Investment_Trust') o.t += x.buy - x.sell;
  }
  return m;
}

// ── 5. 指標與篩選 ──
const ma = (bars, n, i) => (i + 1 >= n && i >= 0 ? avg(bars.slice(i - n + 1, i + 1).map(b => b.c)) : null);
function analyze(s, bars, inst) {
  const i = bars.length - 1, x = bars[i], p = bars[i - 1];
  const prev20 = bars.slice(Math.max(0, i - 20), i);
  const av20 = avg(prev20.map(b => b.v));
  const hi20 = Math.max(...prev20.map(b => b.c));
  const hi60 = Math.max(...bars.slice(Math.max(0, i - 59), i + 1).map(b => b.h));
  const ma5 = ma(bars, 5, i), ma20 = ma(bars, 20, i), ma60 = ma(bars, 60, i);
  const ma20p5 = ma(bars, 20, i - 5), ma20p = ma(bars, 20, i - 1);
  const ret20 = i >= 20 ? x.c / bars[i - 20].c - 1 : null;
  const chg = x.c / p.c - 1;
  const limitUps = i >= 3 && [0, 1, 2].every(k => bars[i - k].c / bars[i - k - 1].c - 1 >= 0.095);
  // 平均一天動幾％（近 60 日收盤日報酬的標準差）
  const rets = []; for (let k = Math.max(1, i - 59); k <= i; k++) rets.push(Math.log(bars[k].c / bars[k - 1].c));
  const mean = avg(rets), dailyVol = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1)) * 100;

  const g = d => (inst && inst[d]) ? inst[d] : null;
  const today = g(x.d);
  const last10 = bars.slice(Math.max(0, i - 9), i + 1).map(b => g(b.d)).filter(Boolean);
  const f10 = last10.reduce((a, b) => a + b.f, 0) / 1000, t10 = last10.reduce((a, b) => a + b.t, 0) / 1000;
  const streak = key => { let n = 0; for (let k = i; k >= 0; k--) { const o = g(bars[k].d); if (!o || o[key] <= 0) break; n++; } return n; };
  const instOut = today
    ? { date: x.d, f: Math.round(today.f / 1000), t: Math.round(today.t / 1000), f10: Math.round(f10), t10: Math.round(t10), tStreak: streak('t'), fStreak: streak('f'), fPct: x.v ? r2(today.f / x.v * 100) : null }
    : { date: null, pending: true, f10: Math.round(f10), t10: Math.round(t10) };

  const volReliable = x.src !== 'est';
  const volRatio = av20 ? x.v / av20 : null;
  const breakout = x.c > hi20;
  // 短線 S1（回測：20 日中位數 +6.8%，上漲機率 80%，n=10）：爆量 3 倍 + 突破 20 日高 + 投信當日買超 + 近 20 日未漲超過 30% + 非連 3 根漲停
  const S1 = s.mkt === 'TW' && volReliable && volRatio >= 3 && breakout && !!today && today.t > 0 && ret20 != null && ret20 <= 0.30 && !limitUps;
  // 量價版（無法人，美股用；僅供參考）
  const S1v = volReliable && volRatio >= 3 && breakout && ret20 != null && ret20 <= 0.30 && !limitUps;
  // 波段 W1（回測：20 日中位數 +7.3%，上漲機率 68%，n=42）：均線多頭且月線向上、今天剛站回月線、法人 10 日淨買為正、近 20 日漲幅 <20%
  const reclaim = !!(ma20 && ma20p && x.c > ma20 && p.c <= ma20p);
  const W1 = !!(s.mkt === 'TW' && ma5 && ma20 && ma60 && ma20p5 && ma5 > ma20 && ma20 > ma60 && ma20 > ma20p5 && reclaim && (f10 > 0 || t10 > 0) && ret20 != null && ret20 < 0.20);

  return {
    sym: s.sym, name: s.name, tag: s.tag, mkt: s.mkt, status: 'ok', asOf: x.d, barSrc: x.src,
    close: x.c, chgPct: r2(chg * 100), vol: Math.round(x.v / 1000), volRatio: r2(volRatio), volReliable,
    ret20Pct: r2(ret20 == null ? null : ret20 * 100), distHi60Pct: r2((x.c / hi60 - 1) * 100), hi20: r2(hi20), hi60: r2(hi60),
    ma5: r2(ma5), ma20: r2(ma20), ma60: r2(ma60), aboveMa20: ma20 ? x.c > ma20 : null, dailyVolPct: r2(dailyVol),
    low: x.l, inst: instOut,
    signals: { S1, S1v, W1, breakout, volSpike: volRatio != null && volRatio >= 3, reclaimMa20: reclaim },
    entry: { limitLow: r2(x.c * 0.98), limitHigh: r2(x.c * 1.01), gapSkipAbove: r2(x.c * 1.03), invalidBelow: x.l },
  };
}

// ── 6. 主流程 ──
(async () => {
  const stocks = loadStocks();
  const twIds = stocks.filter(s => s.mkt === 'TW' && !s.sym.startsWith('^'));
  const start = new Date(Date.now() - 370 * 86400e3).toISOString().slice(0, 10);
  const results = [], errors = [], bars = {};
  const dates = recentTradeDates(12);
  const official = { twse: {}, tpex: {} }, offInst = { twse: null, tpex: null };
  const srcLog = { twseDays: [], tpexDays: [], twseInst: false, tpexInst: false, fmBars: [], estBars: [] };

  // 6a. 先抓所有台股的 Yahoo 日線 + FinMind 法人
  const raw = {};
  for (const s of stocks) {
    try {
      let b, inst = null;
      if (MOCK) { b = mockBars(s); inst = s.mkt === 'TW' ? mockInst(b) : null; }
      else {
        b = await fetchChart(s.sym);
        if (s.mkt === 'TW' && !s.sym.startsWith('^')) {
          const id = s.sym.replace(/\.TWO?$/, '');
          try { inst = await fetchInstFinMind(id, start); } catch (e) { inst = {}; errors.push({ sym: s.sym, stage: 'inst', msg: String(e.message || e) }); }
        }
      }
      raw[s.sym] = { bars: b, inst };
    } catch (e) {
      errors.push({ sym: s.sym, stage: 'chart', msg: String(e.message || e) });
      results.push({ sym: s.sym, name: s.name, tag: s.tag, mkt: s.mkt, status: 'fail' });
    }
    await sleep(MOCK ? 0 : 300);
  }

  // 6b. 找出 Yahoo 缺的日期（最新一天幾乎一定缺），用官方資料補；最多補最近 12 個平日
  if (!MOCK) {
    for (const d of dates) {
      const missing = twIds.filter(s => raw[s.sym] && !raw[s.sym].bars.some(b => b.d === d));
      if (!missing.length) continue;
      if (missing.some(s => !s.sym.endsWith('.TWO'))) { const o = await fetchTWSEDay(d); if (o) { official.twse[d] = o; srcLog.twseDays.push(d); } }
      if (missing.some(s => s.sym.endsWith('.TWO'))) { const o = await fetchTPExDay(d); if (o) { official.tpex[d] = o; srcLog.tpexDays.push(d); } }
      await sleep(400);
    }
    // 當日法人（官方優先，覆蓋 FinMind）：只補最新一個有官方行情的交易日
    const latestTW = srcLog.twseDays[0] || null, latestOTC = srcLog.tpexDays[0] || null;
    if (latestTW) { offInst.twse = await fetchTWSEInst(latestTW); srcLog.twseInst = !!offInst.twse; }
    if (latestOTC) { offInst.tpex = await fetchTPExInst(latestOTC); srcLog.tpexInst = !!offInst.tpex; }
  }

  for (const s of stocks) {
    if (!raw[s.sym]) continue;
    let { bars: b, inst } = raw[s.sym];
    try {
      if (!MOCK && s.mkt === 'TW' && !s.sym.startsWith('^')) {
        const id = s.sym.replace(/\.TWO?$/, ''), isOTC = s.sym.endsWith('.TWO');
        const pool = isOTC ? official.tpex : official.twse;
        const has = d => b.some(x => x.d === d);
        // 1) 官方日線
        for (const d of dates) { if (has(d)) continue; const o = pool[d] && pool[d][id]; if (o) b.push({ d, ...o, src: isOTC ? 'tpex' : 'twse' }); }
        // 2) 還缺的交易日（以官方行事曆判斷；官方全掛就不判斷）→ FinMind 日線
        const calendarKnown = srcLog.twseDays.length > 0 || srcLog.tpexDays.length > 0;
        const isTradeDay = d => !calendarKnown || !!(official.twse[d] || official.tpex[d]);
        let fmDays = [];
        if (dates.some(d => !has(d) && isTradeDay(d))) {
          let fm = null; try { fm = await fetchFinMindPrice(id, dates[dates.length - 1]); } catch (e) { fm = null; }
          if (fm) for (const d of dates) if (!has(d) && fm[d]) { b.push({ d, ...fm[d], src: 'finmind' }); fmDays.push(d); srcLog.fmBars.push(s.sym + '@' + d); }
        }
        b.sort((x, y) => (x.d < y.d ? -1 : 1));
        // 3) 最新交易日還是沒有 → 小時線估一根（成交量標不可靠）
        const want = dates.find(d => official.twse[d] || official.tpex[d]) || fmDays.sort().pop() || null;
        if (want && !has(want)) { const e = await fetchEstBar(s.sym, want); if (e) { b.push(e); b.sort((x, y) => (x.d < y.d ? -1 : 1)); srcLog.estBars.push(s.sym); } }
        // 官方當日法人覆蓋
        const oi = isOTC ? offInst.tpex : offInst.twse, od = isOTC ? srcLog.tpexDays[0] : srcLog.twseDays[0];
        if (oi && od && oi[id]) { inst = inst || {}; inst[od] = oi[id]; }
      }
      bars[s.sym] = { bars: b, inst };
      if (s.sym.startsWith('^')) { results.push({ sym: s.sym, name: s.name, mkt: s.mkt, status: 'ok', index: true, asOf: b[b.length - 1].d, close: b[b.length - 1].c, chgPct: r2((b[b.length - 1].c / b[b.length - 2].c - 1) * 100) }); continue; }
      results.push(analyze(s, b, inst));
    } catch (e) {
      errors.push({ sym: s.sym, stage: 'analyze', msg: String(e.message || e) });
      results.push({ sym: s.sym, name: s.name, tag: s.tag, mkt: s.mkt, status: 'fail' });
    }
  }

  // 族群強度：同標籤裡「站上月線且量 ≥1.5 倍」的檔數
  const byTag = {};
  for (const r of results) if (r.status === 'ok' && !r.index && r.tag) {
    const o = (byTag[r.tag] = byTag[r.tag] || { total: 0, strong: 0 });
    o.total++; if (r.aboveMa20 && r.volRatio >= 1.5) o.strong++;
  }
  for (const r of results) if (r.tag && byTag[r.tag]) r.group = byTag[r.tag];

  const asOfTW = results.filter(r => r.mkt === 'TW' && r.asOf).map(r => r.asOf).sort().pop() || null;
  const twOk = results.filter(r => r.mkt === 'TW' && !r.index && r.status === 'ok');
  const out = {
    generatedAt: new Date().toISOString(), asOfTW,
    coverage: {
      twStocks: twIds.length, twOk: twOk.length, twOnAsOf: twOk.filter(r => r.asOf === asOfTW).length,
      withTodayInst: twOk.filter(r => r.inst && r.inst.date === asOfTW).length, sources: srcLog,
    },
    lists: {
      short: results.filter(r => r.signals && r.signals.S1).map(r => r.sym),
      shortNoInst: results.filter(r => r.signals && r.signals.S1v && !r.signals.S1).map(r => r.sym),
      swing: results.filter(r => r.signals && r.signals.W1).map(r => r.sym),
    },
    groups: byTag, ok: results.filter(r => r.status === 'ok').length, failed: results.filter(r => r.status === 'fail').length,
    errors, stocks: results,
  };
  fs.mkdirSync(path.join(ROOT, 'data', 'history'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'data', 'latest.json'), JSON.stringify(out, null, 1));
  fs.writeFileSync(path.join(ROOT, 'data', 'bars.json'), JSON.stringify(bars));
  if (asOfTW) fs.writeFileSync(path.join(ROOT, 'data', 'history', asOfTW + '.json'), JSON.stringify(out, null, 1));
  console.log(`asOf=${asOfTW} ok=${out.ok} failed=${out.failed} twOnAsOf=${out.coverage.twOnAsOf}/${twIds.length} todayInst=${out.coverage.withTodayInst} src=${JSON.stringify(srcLog)}`);
  console.log(`short=${out.lists.short.join(',') || '-'} swing=${out.lists.swing.join(',') || '-'}`);
  if (errors.length) console.log('errors:', JSON.stringify(errors));
  if (out.ok < stocks.length * 0.9) { console.error('抓取成功率低於 90%，標記失敗'); process.exit(1); }
})();

// ── 測試用假資料 ──
function mockBars(s) {
  let seed = [...s.sym].reduce((a, c) => a + c.charCodeAt(0), 7); const R = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  const bars = []; let p = 100; const t0 = Date.UTC(2025, 9, 1);
  for (let i = 0; i < 250; i++) { const d = new Date(t0 + i * 86400e3); if (d.getUTCDay() % 6 === 0) continue; const o = p, c = p * (1 + (R() - 0.5) * 0.06); bars.push({ d: d.toISOString().slice(0, 10), o, h: Math.max(o, c) * (1 + R() * 0.01), l: Math.min(o, c) * (1 - R() * 0.01), c, v: Math.round(1e6 + R() * 3e6), src: 'yahoo' }); p = c; }
  if (s.sym === '2330.TW') { const l = bars[bars.length - 1]; l.c = Math.max(...bars.slice(-21, -1).map(b => b.c)) * 1.02; l.v = 2e7; l.h = Math.max(l.h, l.c); }
  return bars;
}
function mockInst(bars) { const m = {}; bars.forEach((b, i) => { m[b.d] = { f: (i % 3 - 1) * 500000, t: i % 2 ? 200000 : -100000 }; }); m[bars[bars.length - 1].d] = { f: 800000, t: 300000 }; return m; }
