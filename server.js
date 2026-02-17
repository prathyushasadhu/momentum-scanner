/**
 * Daily Momentum Scanner – US & Canada
 * Node.js / Express backend
 * Data: Yahoo Finance (server-side, no CORS issues)
 */

const express  = require("express");
const path     = require("path");
const https    = require("https");

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Serve static frontend ─────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

// ── Ticker universe ───────────────────────────────────────────────────────────
const US_TICKERS = [
  "SNDL","CLOV","AMC","SPCE","SKLZ","WKHS","GOEV","NKLA","BLNK","PLUG",
  "FCEL","OCGN","AGEN","INO","GNUS","MVIS","XELA","ATER","CENN","MULN",
  "IDEX","BIOC","AEYE","VERB","ACST","VERI","SHIP","DPRO","FFIE","BFRI",
  "VISL","ENVB","SFOR","TAOP","SGLY","ADTX","ITRM","ABOS","HPCO","CRGE",
  "FRGE","MEGL","SHOT","NTRB","MOXC","PROG","RIDE","WISH","NAKD","KOSS",
  "ATOS","PHUN","DOGZ","CODA","NEON","BSFC","EZFL","PALT","AGRI","CJET",
  "SOWG","SGBX","BRTX","ZEST","SAVA","SRNE","EXPR","NEGG","GFAI","BBBY",
];

const CA_TICKERS = [
  "ACB.TO","WEED.TO","CRON.TO","OGI.TO","FIRE.TO","GTE.TO","ATH.TO",
  "BTE.TO","NXE.TO","DML.TO","GPR.TO","AR.TO","ERO.TO","BIR.TO","VII.TO",
  "MEG.TO","PEY.TO","TVE.TO","AAV.TO","CPG.TO","RRX.TO","SGY.TO","CJ.TO",
  "WCP.TO","TXG.TO","LUG.TO","MAG.TO","HBM.TO","FM.TO","SSL.TO","ELD.TO",
];

const ALL_TICKERS = [...US_TICKERS, ...CA_TICKERS];

// ── Simple in-memory cache (5 minutes) ───────────────────────────────────────
let cache = { data: null, ts: 0 };
const CACHE_TTL = 5 * 60 * 1000;

// ── Yahoo Finance fetcher (server-side, no CORS) ──────────────────────────────
function fetchYahoo(symbol) {
  return new Promise((resolve) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
                `?interval=1d&range=60d&includePrePost=false`;
    const options = {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept":     "application/json",
      },
    };

    https.get(url, options, (res) => {
      let raw = "";
      res.on("data", chunk => raw += chunk);
      res.on("end", () => {
        try {
          const json   = JSON.parse(raw);
          const result = json?.chart?.result?.[0];
          if (!result) return resolve(null);

          const quotes  = result.indicators?.quote?.[0] || {};
          const closes  = (quotes.close  || []).filter(v => v != null);
          const volumes = (quotes.volume || []).filter(v => v != null);
          const highs   = (quotes.high   || []).filter(v => v != null);

          if (closes.length < 32) return resolve(null);

          const n         = closes.length;
          const todayC    = closes[n - 1];
          const prevC     = closes[n - 2];
          const todayVol  = volumes[n - 1] || 0;
          const prevHigh  = highs[n - 2]   || 0;
          const avg30     = volumes.slice(-31, -1).reduce((a, b) => a + b, 0) / 30;

          if (!avg30 || !todayC || !prevC) return resolve(null);

          const pct      = ((todayC - prevC) / prevC) * 100;
          const volRatio = todayVol / avg30;
          const rsi      = calcRSI(closes);

          // ── All 5 filters ──────────────────────────────────────────────
          if (todayC < 1 || todayC > 20)           return resolve(null);
          if (volRatio < 2)                         return resolve(null);
          if (pct < 3)                              return resolve(null);
          if (!rsi || rsi < 50 || rsi > 75)        return resolve(null);
          if (todayC <= prevHigh)                   return resolve(null);

          // ── Trade levels ───────────────────────────────────────────────
          const entry    = +(todayC  * 1.001).toFixed(4);
          const stopLoss = +(entry   * 0.980).toFixed(4);
          const target   = +(entry   * 1.035).toFixed(4);
          const risk     = +(entry   - stopLoss).toFixed(4);
          const reward   = +(target  - entry).toFixed(4);
          const rrRatio  = +(reward / risk).toFixed(2);

          // ── Composite score ────────────────────────────────────────────
          const score = +(
            Math.min(volRatio / 5, 1) * 40 +
            Math.min(pct / 10,    1) * 40 +
            ((rsi - 50) / 25)         * 20
          ).toFixed(2);

          const isCA = symbol.endsWith(".TO") || symbol.endsWith(".V");

          resolve({
            symbol,
            label:    symbol.replace(".TO", "").replace(".V", ""),
            exchange: isCA ? "TSX" : "US",
            price:    +todayC.toFixed(4),
            pct:      +pct.toFixed(2),
            volume:   Math.round(todayVol),
            avgVol:   Math.round(avg30),
            volRatio: +volRatio.toFixed(2),
            rsi, entry, stopLoss, target, rrRatio, score,
          });
        } catch { resolve(null); }
      });
    }).on("error", () => resolve(null));
  });
}

// ── RSI (14-period) ───────────────────────────────────────────────────────────
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const sl = closes.slice(-(period + 1));
  let g = 0, l = 0;
  for (let i = 1; i < sl.length; i++) {
    const d = sl[i] - sl[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  const ag = g / period, al = l / period;
  if (al === 0) return 100;
  return +((100 - 100 / (1 + ag / al)).toFixed(2));
}

// ── Controlled concurrency batch runner ───────────────────────────────────────
async function runBatch(tickers, concurrency = 10) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < tickers.length) {
      const sym = tickers[idx++];
      const r   = await fetchYahoo(sym);
      if (r) results.push(r);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ── API: GET /api/scan ────────────────────────────────────────────────────────
app.get("/api/scan", async (req, res) => {
  // Serve from cache if fresh
  if (cache.data && Date.now() - cache.ts < CACHE_TTL) {
    console.log("Serving from cache");
    return res.json(cache.data);
  }

  console.log(`Scanning ${ALL_TICKERS.length} tickers…`);
  const t0      = Date.now();
  const found   = await runBatch(ALL_TICKERS, 10);
  const top5    = found.sort((a, b) => b.score - a.score).slice(0, 5);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Done in ${elapsed}s — ${found.length} candidates, top ${top5.length} returned`);

  const payload = {
    scanned:   ALL_TICKERS.length,
    found:     found.length,
    top5,
    timestamp: new Date().toLocaleString("en-CA", { timeZone: "America/Toronto" }),
    elapsed:   `${elapsed}s`,
  };

  cache = { data: payload, ts: Date.now() };
  res.json(payload);
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/api/health", (_req, res) => res.json({ status: "ok", ts: new Date().toISOString() }));

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`🚀 Momentum Scanner running on port ${PORT}`));
