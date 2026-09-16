// Runs on GitHub's servers via a scheduled Action — not on your PC.
//
// Fetches Deribit option OI and computes S/R + max-pain for FOUR tracked
// expiries at once — the nearest daily, weekly, monthly, and quarterly
// contract — and merges each into data/levels.json, one growing history per
// timeframe. It also keeps writing the original data/daily-levels.json
// (unchanged format/behavior) so nothing that already depends on it breaks.
//
// The workflow that calls this script commits the updated files back to the
// repo, so history accumulates forever, with or without your PC/browser
// being open.

const fs = require('fs');
const path = require('path');

const DERIBIT = 'https://www.deribit.com/api/v2';
const DAILY_FILE = path.join(__dirname, '..', 'data', 'daily-levels.json');   // legacy, single-timeframe file (kept for backward compatibility)
const LEVELS_FILE = path.join(__dirname, '..', 'data', 'levels.json');        // new, multi-timeframe file: { daily: {...}, weekly: {...}, monthly: {...}, quarterly: {...} }

// Levels are now a manual per-side count, chosen live in the dashboard
// (0-10, via the "S/R levels (per side)" dropdown) rather than a fixed
// count gated by a statistical threshold. Since the dropdown can ask for
// up to 10 per side, we store the full top-10-per-side ranking here for
// every period — the dashboard then just slices however many it wants to
// display for both live and historical periods. Ranks 1-3 (rank index
// 0-2) are meant to be drawn solid; ranks 4-10 (index 3-9) dotted — same
// split as index.html's LEVELS_PER_SIDE.
const MAX_LEVELS_PER_SIDE = 10;
const LEVELS_PER_SIDE = 3;   // ranks below this are "solid"; the rest are "extra" (dotted)
const EXPIRY_HOUR_UTC = 8; // Deribit's daily option settlement time
const TIMEFRAMES = ['daily', 'weekly', 'monthly', 'quarterly'];

// ---------------- Deribit helpers ----------------

async function fetchJSON(url){
  const res = await fetch(url);
  if(!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const body = await res.json();
  if(body.error) throw new Error(JSON.stringify(body.error));
  return body.result;
}

function parseInstrument(name){
  const parts = name.split('-');
  if(parts.length !== 4) return null;
  const [, expiry, strikeStr, cp] = parts;
  return { expiry, strike: parseInt(strikeStr, 10), type: cp === 'C' ? 'call' : 'put' };
}

function expirySortKey(expiryStr){
  const d = new Date(expiryStr.replace(/(\d{1,2})([A-Z]{3})(\d{2})/, '$1 $2 20$3'));
  return d.getTime() || 0;
}

// Legacy nearest-expiry-overall picker — kept exactly as before so
// data/daily-levels.json's behavior doesn't change.
function pickNearestExpiry(uniqueExpiries){
  const sorted = [...uniqueExpiries].sort((a, b) => expirySortKey(a) - expirySortKey(b));
  if(!sorted.length) throw new Error('No active BTC option expiries found');
  return sorted[0];
}

function aggregateOI(summary, expiry){
  const byStrike = {};
  for(const row of summary){
    const parsed = parseInstrument(row.instrument_name);
    if(!parsed || parsed.expiry !== expiry) continue;
    if(!byStrike[parsed.strike]) byStrike[parsed.strike] = { call: 0, put: 0 };
    byStrike[parsed.strike][parsed.type] += (row.open_interest || 0);
  }
  return byStrike;
}

// ---------------- Expiry classification (daily / weekly / monthly / quarterly) ----------------
// Mirrors Deribit's own published contract schedule:
//   "Daily options expire every day at 08:00 UTC. Weekly options expire on
//    each Friday... Monthly options expire on the last Friday of each
//    calendar month... Quarterly options expire on the last Friday of each
//    calendar quarter." — so classification is a pure date-arithmetic
// property of the expiry date itself, not a guess.

const MONTHS = { JAN:0, FEB:1, MAR:2, APR:3, MAY:4, JUN:5, JUL:6, AUG:7, SEP:8, OCT:9, NOV:10, DEC:11 };

// Parses a Deribit expiry string like "13SEP26" into a UTC midnight
// timestamp (ms) for that calendar date. Explicit UTC math (no reliance on
// the runner's local timezone or the native Date string parser).
function parseExpiryDateUTC(expiryStr){
  const m = expiryStr.match(/^(\d{1,2})([A-Z]{3})(\d{2})$/);
  if(!m) return null;
  const [, dd, mon, yy] = m;
  const month = MONTHS[mon];
  if(month === undefined) return null;
  return Date.UTC(2000 + parseInt(yy, 10), month, parseInt(dd, 10));
}

// Last Friday of the given UTC month, as a UTC-midnight ms timestamp.
// monthIndex0 may be passed outside 0-11 — Date.UTC normalizes it (e.g.
// month -1 correctly rolls back into December of the previous year).
function lastFridayUTC(year, monthIndex0){
  let t = Date.UTC(year, monthIndex0 + 1, 1) - 86400000; // last day of that month, 00:00 UTC
  while(new Date(t).getUTCDay() !== 5) t -= 86400000;    // walk back to the nearest Friday
  return t;
}

function classifyExpiry(dateMs){
  const d = new Date(dateMs);
  if(d.getUTCDay() !== 5) return 'daily'; // not a Friday => daily
  const isLastFridayOfMonth = dateMs === lastFridayUTC(d.getUTCFullYear(), d.getUTCMonth());
  if(!isLastFridayOfMonth) return 'weekly';
  const isQuarterEndMonth = [2, 5, 8, 11].includes(d.getUTCMonth()); // Mar/Jun/Sep/Dec
  return isQuarterEndMonth ? 'quarterly' : 'monthly';
}

// Nearest active expiry classified as `timeframe`, or null if none is
// currently listed (can happen momentarily right at a rollover).
function pickNearestByTimeframe(uniqueExpiries, timeframe){
  const candidates = uniqueExpiries
    .map(expiry => ({ expiry, ms: parseExpiryDateUTC(expiry) }))
    .filter(e => e.ms !== null)
    .map(e => ({ ...e, type: classifyExpiry(e.ms) }))
    .filter(e => e.type === timeframe)
    .sort((a, b) => a.ms - b.ms);
  return candidates.length ? candidates[0] : null;
}

// The period a given timeframe's currently-tracked expiry covers: from the
// previous same-timeframe settlement up to this one's 08:00 UTC settlement.
//
// This can't just be "N days/weeks/months back" — e.g. the calendar month
// right before a monthly expiry might itself have been a QUARTERLY month
// (its last Friday claimed by the quarterly classification instead), in
// which case the true previous monthly boundary is further back still. The
// same subtlety applies to weekly (the immediately-prior Friday might be a
// monthly/quarterly one) and even daily (the day before might be a Friday,
// which is never daily-classified). So: walk backward one natural step at a
// time (1 day for daily, 7 days — i.e. one Friday — for the rest) until
// landing on an expiry date that's actually classified as this SAME
// timeframe; that's the genuine previous boundary.
function periodBoundsForExpiry(timeframe, expiryDateMs){
  const settleTs = expiryDateMs / 1000 + EXPIRY_HOUR_UTC * 3600;
  const stepMs = timeframe === 'daily' ? 86400000 : 7 * 86400000;
  let prev = expiryDateMs - stepMs;
  let guard = 0;
  while(classifyExpiry(prev) !== timeframe && guard < 60){
    prev -= stepMs;
    guard++;
  }
  const startTs = prev / 1000 + EXPIRY_HOUR_UTC * 3600;
  return { dayStart: startTs, dayEnd: settleTs };
}

// ---------------- Level computation (mirrors index.html) ----------------
// No statistical/dominance gating anymore — the dashboard's dropdown lets
// the user manually choose how many levels per side to display (0-10), so
// we simply rank every candidate strike by OI and store the top
// MAX_LEVELS_PER_SIDE per side. Rank index 0-2 ("1st"-"3rd") is meant to
// render solid; index 3-9 ("4th"-"10th") dotted.

function buildSide(pool, sideName, prefix){
  const sorted = [...pool].sort((a, b) => b.metric - a.metric);
  const selected = sorted.slice(0, MAX_LEVELS_PER_SIDE);
  selected.forEach((t, i) => { t.side = sideName; t.label = prefix + (i + 1); t.rank = i; t.extra = i >= LEVELS_PER_SIDE; });
  return selected;
}

// Computes both S/R modes (combined + individual) so the dashboard can
// switch between them for historical periods, same as it does live.
function computeLevels(oiByStrike){
  const strikes = Object.keys(oiByStrike).map(Number).sort((a, b) => a - b);
  if(!strikes.length) return null;

  const withTotals = strikes.map(k => {
    const { call, put } = oiByStrike[k];
    return { strike: k, call, put, total: call + put };
  });

  function forMode(mode){
    let resistanceCandidates, supportCandidates;
    if(mode === 'individual'){
      // Resistance driven purely by call OI, support purely by put OI.
      const resistancePool = withTotals.filter(t => t.call > 0).map(t => ({ ...t, metric: t.call, total: t.call }));
      const supportPool = withTotals.filter(t => t.put > 0).map(t => ({ ...t, metric: t.put, total: t.put }));
      resistanceCandidates = buildSide(resistancePool, 'resistance', 'R');
      supportCandidates = buildSide(supportPool, 'support', 'S');
    }else{
      // Combined mode: a strike counts toward resistance if call>=put OI
      // there (or support if put>call), then the top MAX_LEVELS_PER_SIDE
      // per side by total OI are ranked 1..MAX_LEVELS_PER_SIDE.
      const resistancePool = withTotals.filter(t => t.call >= t.put).map(t => ({ ...t, metric: t.total }));
      const supportPool = withTotals.filter(t => t.put > t.call).map(t => ({ ...t, metric: t.total }));
      resistanceCandidates = buildSide(resistancePool, 'resistance', 'R');
      supportCandidates = buildSide(supportPool, 'support', 'S');
    }
    return [...resistanceCandidates, ...supportCandidates].sort((a, b) => a.strike - b.strike)
      .map(l => ({ strike: l.strike, side: l.side, label: l.label, total: l.total, extra: !!l.extra, rank: l.rank || 0 }));
  }

  let best = null, bestLoss = Infinity;
  for(const k of strikes){
    let loss = 0;
    for(const s of withTotals){
      loss += s.call * Math.max(0, k - s.strike);
      loss += s.put * Math.max(0, s.strike - k);
    }
    if(loss < bestLoss){ bestLoss = loss; best = k; }
  }

  return {
    maxPain: best,
    combined: forMode('combined'),
    individual: forMode('individual'),
  };
}

// ---------------- Legacy daily bucketing (mirrors index.html's dayKeyUTC) ----------------

function dayKeyUTC(tsSec){
  const shifted = tsSec - EXPIRY_HOUR_UTC * 3600;
  return new Date(shifted * 1000).toISOString().slice(0, 10);
}
function dayStartUTC(key){
  return Math.floor(Date.parse(key + 'T00:00:00Z') / 1000) + EXPIRY_HOUR_UTC * 3600;
}

function readJSON(file, fallback){
  try{ return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch(e){ return fallback; }
}
function writeJSON(file, data){
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

// ---------------- Main ----------------

async function main(){
  const instruments = await fetchJSON(`${DERIBIT}/public/get_instruments?currency=BTC&kind=option&expired=false`);
  const uniqueExpiries = [...new Set(instruments.map(i => i.instrument_name.split('-')[1]))];
  const summary = await fetchJSON(`${DERIBIT}/public/get_book_summary_by_currency?currency=BTC&kind=option`);

  // ---- Legacy: data/daily-levels.json (unchanged behavior) ----
  const nearestOverall = pickNearestExpiry(uniqueExpiries);
  const legacyComputed = computeLevels(aggregateOI(summary, nearestOverall));
  if(legacyComputed){
    const now = Math.floor(Date.now() / 1000);
    const key = dayKeyUTC(now);
    const dailyStore = readJSON(DAILY_FILE, {});
    dailyStore[key] = {
      dayStart: dayStartUTC(key),
      expiry: nearestOverall,
      maxPain: legacyComputed.maxPain,
      combined: legacyComputed.combined,
      individual: legacyComputed.individual,
      updatedAt: new Date().toISOString(),
    };
    writeJSON(DAILY_FILE, dailyStore);
    console.log(`[legacy daily-levels.json] Saved period ${key} (expiry ${nearestOverall}): maxPain=${legacyComputed.maxPain}`);
  }else{
    console.log(`[legacy daily-levels.json] No OI data for ${nearestOverall} — skipping.`);
  }

  // ---- New: data/levels.json, one history per timeframe ----
  let levelsStore = readJSON(LEVELS_FILE, null);
  if(levelsStore === null){
    // First run under the new format: seed `daily` from the existing legacy
    // file (if any) so we don't throw away the history already collected,
    // rather than starting the daily timeframe over from empty.
    levelsStore = { daily: {}, weekly: {}, monthly: {}, quarterly: {} };
    const legacyDaily = readJSON(DAILY_FILE, {});
    for(const [key, entry] of Object.entries(legacyDaily)){
      levelsStore.daily[key] = { ...entry, dayEnd: entry.dayStart + 86400 };
    }
  }
  for(const tf of TIMEFRAMES){
    if(!levelsStore[tf]) levelsStore[tf] = {};
  }

  for(const timeframe of TIMEFRAMES){
    const nearest = pickNearestByTimeframe(uniqueExpiries, timeframe);
    if(!nearest){
      console.log(`[levels.json:${timeframe}] No active ${timeframe} expiry currently listed — skipping this run.`);
      continue;
    }
    const computed = computeLevels(aggregateOI(summary, nearest.expiry));
    if(!computed){
      console.log(`[levels.json:${timeframe}] No OI data for ${nearest.expiry} — skipping.`);
      continue;
    }
    const { dayStart, dayEnd } = periodBoundsForExpiry(timeframe, nearest.ms);
    // For `daily`, use the same YYYY-MM-DD key format as the legacy file
    // (so migrated + newly-written entries stay consistent and sort
    // correctly together). Weekly/monthly/quarterly periods aren't
    // calendar-day-aligned, so the expiry string is the natural unique key.
    const key = timeframe === 'daily' ? dayKeyUTC(Math.floor(Date.now() / 1000)) : nearest.expiry;
    levelsStore[timeframe][key] = {
      dayStart,
      dayEnd,
      expiry: nearest.expiry,
      maxPain: computed.maxPain,
      combined: computed.combined,
      individual: computed.individual,
      updatedAt: new Date().toISOString(),
    };
    console.log(`[levels.json:${timeframe}] Saved period ${key} (expiry ${nearest.expiry}): maxPain=${computed.maxPain}, ${computed.combined.length} combined levels, ${computed.individual.length} individual levels.`);
  }

  writeJSON(LEVELS_FILE, levelsStore);
}

main().catch(err => {
  console.error('Collector failed:', err);
  process.exit(1);
});
