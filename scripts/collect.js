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

const LEVELS_PER_SIDE = 3;
const EXTRA_LEVELS_PER_SIDE = 2;
const EXTRA_DOMINANCE_MARGIN = 1.15;
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
  if(!sorted.length) throw new Error('No active BTC option
