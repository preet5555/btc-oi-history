// Runs on GitHub's servers via a scheduled Action — not on your PC.
// Fetches Deribit option OI, computes S/R + max-pain for the nearest expiry,
// and merges the result into data/daily-levels.json (one entry per expiry
// period, keyed to the 08:00 UTC Deribit settlement boundary). The workflow
// that calls this script commits the updated file back to the repo, so
// history accumulates forever, with or without your PC/browser being open.

const fs = require('fs');
const path = require('path');

const DERIBIT = 'https://www.deribit.com/api/v2';
const DATA_FILE = path.join(__dirname, '..', 'data', 'daily-levels.json');

const LEVELS_PER_SIDE = 3;
const EXTRA_LEVELS_PER_SIDE = 2;
const EXTRA_DOMINANCE_MARGIN = 1.15;
const EXPIRY_HOUR_UTC = 8; // Deribit's daily option settlement time

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

async function pickNearestExpiry(){
  const instruments = await fetchJSON(`${DERIBIT}/public/get_instruments?currency=BTC&kind=option&expired=false`);
  const unique = [...new Set(instruments.map(i => i.instrument_name.split('-')[1]))];
  unique.sort((a, b) => expirySortKey(a) - expirySortKey(b));
  if(!unique.length) throw new Error('No active BTC option expiries found');
  return unique[0];
}

async function loadOIForExpiry(expiry){
  const summary = await fetchJSON(`${DERIBIT}/public/get_book_summary_by_currency?currency=BTC&kind=option`);
  const byStrike = {};
  for(const row of summary){
    const parsed = parseInstrument(row.instrument_name);
    if(!parsed || parsed.expiry !== expiry) continue;
    if(!byStrike[parsed.strike]) byStrike[parsed.strike] = { call: 0, put: 0 };
    byStrike[parsed.strike][parsed.type] += (row.open_interest || 0);
  }
  return byStrike;
}

// ---------------- Level computation (mirrors public/index.html) ----------------

function statThreshold(values){
  if(values.length < 2) return Infinity;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return mean + Math.sqrt(variance);
}

function buildSide(pool, sideName, prefix, dominanceOk){
  const sorted = [...pool].sort((a, b) => b.metric - a.metric);
  const primary = sorted.slice(0, LEVELS_PER_SIDE);
  const threshold = statThreshold(sorted.map(t => t.metric));
  const extra = sorted.slice(LEVELS_PER_SIDE)
    .filter(t => t.metric >= threshold && dominanceOk(t))
    .slice(0, EXTRA_LEVELS_PER_SIDE);
  primary.forEach((t, i) => { t.side = sideName; t.label = prefix + (i + 1); t.rank = i; t.extra = false; });
  extra.forEach((t, i) => { t.side = sideName; t.label = prefix + (LEVELS_PER_SIDE + i + 1); t.rank = LEVELS_PER_SIDE + i; t.extra = true; });
  return [...primary, ...extra];
}

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
      const resistancePool = withTotals.filter(t => t.call > 0).map(t => ({ ...t, metric: t.call, total: t.call }));
      const supportPool = withTotals.filter(t => t.put > 0).map(t => ({ ...t, metric: t.put, total: t.put }));
      resistanceCandidates = buildSide(resistancePool, 'resistance', 'R', () => true);
      supportCandidates = buildSide(supportPool, 'support', 'S', () => true);
    }else{
      const resistancePool = withTotals.filter(t => t.call >= t.put).map(t => ({ ...t, metric: t.total }));
      const supportPool = withTotals.filter(t => t.put > t.call).map(t => ({ ...t, metric: t.total }));
      resistanceCandidates = buildSide(resistancePool, 'resistance', 'R', t => t.call >= t.put * EXTRA_DOMINANCE_MARGIN);
      supportCandidates = buildSide(supportPool, 'support', 'S', t => t.put >= t.call * EXTRA_DOMINANCE_MARGIN);
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

// ---------------- Day/period bucketing (mirrors public/index.html) ----------------

function dayKeyUTC(tsSec){
  const shifted = tsSec - EXPIRY_HOUR_UTC * 3600;
  return new Date(shifted * 1000).toISOString().slice(0, 10);
}
function dayStartUTC(key){
  return Math.floor(Date.parse(key + 'T00:00:00Z') / 1000) + EXPIRY_HOUR_UTC * 3600;
}

// ---------------- Main ----------------

async function main(){
  const expiry = await pickNearestExpiry();
  const oiByStrike = await loadOIForExpiry(expiry);
  const computed = computeLevels(oiByStrike);
  if(!computed){
    console.log('No OI data for', expiry, '— skipping this run.');
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const key = dayKeyUTC(now);

  let store = {};
  try{
    store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  }catch(e){
    store = {};
  }

  store[key] = {
    dayStart: dayStartUTC(key),
    expiry,
    maxPain: computed.maxPain,
    combined: computed.combined,
    individual: computed.individual,
    updatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2) + '\n');
  console.log(`Saved period ${key} (expiry ${expiry}): maxPain=${computed.maxPain}, ${computed.combined.length} combined levels, ${computed.individual.length} individual levels.`);
}

main().catch(err => {
  console.error('Collector failed:', err);
  process.exit(1);
});
