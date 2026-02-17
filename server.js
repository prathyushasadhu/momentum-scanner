/**
 * Daily Momentum Scanner – US & Canada
 * Fixed: better tickers, relaxed filters, more candidates
 */

const express = require("express");
const path    = require("path");
const https   = require("https");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

// ── Much better ticker universe ───────────────────────────────────────────────
// Active, liquid stocks that regularly trade in the $1–$20 range
const US_TICKERS = [
  // Popular small caps & meme stocks still active
  "SNDL","CLOV","AMC","SPCE","PLUG","FCEL","BLNK","GOEV","NKLA","WKHS",
  "SKLZ","MVIS","IDEX","OCGN","AGEN","INO","GNUS","CENN","MULN","BBAI",
  // Biotech small caps
  "ITRM","ACST","ENVB","SAVA","SRNE","ATOS","BFRI","VISL","ADTX","ABOS",
  "HPCO","CRGE","SFOR","SGLY","ADTX","VERB","BIOC","SHIP","DPRO","SHOT",
  // EV / Tech small caps
  "RIDE","HYLN","AYRO","SOLO","KPLT","CODA","NEON","PALT","AGRI","CJET",
  "BSFC","EZFL","MCVT","EPAZ","SOWG","SGBX","BRTX","ZEST","PHUN","DOGZ",
  // Mid-tier active stocks $1–$20
  "OPEN","PSFE","BARK","BODY","OPAD","ATIP","PRPB","GREE","EBON","BTBT",
  "MARA","RIOT","HUT","BITF","CIFR","CLSK","IREN","WULF","GRVY","LOVE",
  "CXAI","BBIG","FFIE","NTRB","MOXC","PROG","BIOR","GFAI","TAOP","MEGL",
  "DPRO","FRGE","NAKD","KOSS","WISH","EXPR","NEGG","ATER","XELA","CENN",
  // More liquid names
  "SOFI","COUR","LMND","ROOT","DKNG","HOOD","RBLX","AFRM","UPST","MAPS",
  "UWMC","RKT","NRDS","IONQ","RXRX","ARQT","CLOV","HLTH","PAYO","PNTM",
];

const CA_TICKERS = [
  // Cannabis
  "ACB.TO","WEED.TO","CRON.TO","OGI.TO","FIRE.TO","APHA.TO","TLRY.TO",
  // Energy small caps
  "GTE.TO","ATH.TO","BTE.TO","PEY.TO","TVE.TO","AAV.TO","CPG.TO",
  "RRX.TO","SGY.TO","CJ.TO","WCP.TO","BIR.TO","VII.TO","MEG.TO",
  // Mining / Gold
  "NXE.TO","DML.TO","GPR.TO","AR.TO","ERO.TO","TXG.TO","LUG.TO",
  "MAG.TO","HBM.TO","SSL.TO","ELD.TO","IMG.TO","KGI.TO","OR.TO",
  // Tech / Other
  "LSPD.TO","DCBO.TO","ALYA.TO","TPVG.TO","BIGG.TO","VERY.TO",
];

const ALL_TICKERS = [...new Set([...US_TICKERS, ...CA_TICKERS])];

// ── Cache ─────────────────────────────────────────────────────────────────────
let cache = { data: null, ts: 0 };
const CACHE_TTL = 5 * 60 * 1000;

// ── RSI ───────────────────────────────────────────────────────────────────────
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

// ── Yahoo Finance fetch ───────────────────────────────────────────────────────
function fetchYahoo(symbol) {
  return new Promise((resolve) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=60d&includePrePost=false`;
    const opts = { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } };

    const req = https.get(url, opts, (res) => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        try {
          const json   = JSON.parse(raw);
          const result = json?.chart?.result?.[0];
          if (!result) return resolve(null);

          const q      = result.indicators?.quote?.[0] || {};
          const closes = (q.close  || []).filter(v => v != null);
          const vols   = (q.volume || []).filter(v => v != null);
          const highs  = (q.high   || []).filter(v => v != null);
          const lows   = (q.low    || []).filter(v => v != null);

          if (closes.length < 20) return resolve(null);

          const n        = closes.length;
          const todayC   = closes[n - 1];
          const prevC    = closes[n - 2];
          const todayV   = vols[n - 1]   || 0;
          const prevH    = highs[n - 2]  || 0;
          const avgLen   = Math.min(30, vols.length - 1);
          const avg30    = vols.slice(-avgLen - 1, -1).reduce((a, b) => a + b, 0) / avgLen;

          if (!avg30 || !todayC || !prevC) return resolve(null);

          const pct      = ((todayC - prevC) / prevC) * 100;
          const volRatio = todayV / avg30;
          const rsi      = calcRSI(closes);

          // ── RELAXED filters (easier to pass) ──────────────────────────
          if (todayC < 0.5 || todayC > 30)         return resolve(null); // wider price
          if (volRatio < 1.5)                       return resolve(null); // lower vol threshold
          if (pct < 2)                              return resolve(null); // lower % threshold
          if (!rsi || rsi < 45 || rsi > 80)        return resolve(null); // wider RSI
          if (todayC <= prevH * 0.995)              return resolve(null); // near breakout ok

          // ── Trade levels ──────────────────────────────────────────────
          const entry    = +(todayC  * 1.001).toFixed(4);
          const stopLoss = +(entry   * 0.980).toFixed(4);
          const target   = +(entry   * 1.035).toFixed(4);
          const risk     = +(entry   - stopLoss).toFixed(4);
          const reward   = +(target  - entry).toFixed(4);
          const rrRatio  = +(reward  / risk).toFixed(2);

          // ── Score ─────────────────────────────────────────────────────
          const score = +(
            Math.min(volRatio / 5, 1) * 40 +
            Math.min(pct / 10, 1)     * 40 +
            ((Math.min(rsi, 75) - 45) / 30) * 20
          ).toFixed(2);

          const isCA = symbol.endsWith(".TO") || symbol.endsWith(".V");

          resolve({
            symbol,
            label:    symbol.replace(".TO","").replace(".V",""),
            exchange: isCA ? "TSX" : "US",
            price:    +todayC.toFixed(4),
            pct:      +pct.toFixed(2),
            volume:   Math.round(todayV),
            avgVol:   Math.round(avg30),
            volRatio: +volRatio.toFixed(2),
            rsi, entry, stopLoss, target, rrRatio, score,
          });
        } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
  });
}

// ── Batch runner ──────────────────────────────────────────────────────────────
async function runBatch(tickers, concurrency = 10) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < tickers.length) {
      const sym = tickers[idx++];
      const r   = await fetchYahoo(sym);
      if (r) {
        results.push(r);
        console.log(`✓ ${sym} | price=$${r.price} | pct=+${r.pct}% | vol=${r.volRatio}x | rsi=${r.rsi}`);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ── API ───────────────────────────────────────────────────────────────────────
app.get("/api/scan", async (req, res) => {
  if (cache.data && Date.now() - cache.ts < CACHE_TTL) {
    console.log("Serving from cache");
    return res.json(cache.data);
  }

  console.log(`\nStarting scan of ${ALL_TICKERS.length} tickers…`);
  const t0    = Date.now();
  const found = await runBatch(ALL_TICKERS, 10);
  const top5  = found.sort((a, b) => b.score - a.score).slice(0, 5);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\nDone in ${elapsed}s | ${found.length} candidates | top ${top5.length} returned`);
  top5.forEach((s, i) => console.log(`  ${i+1}. ${s.label} score=${s.score}`));

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

app.get("/api/health", (_req, res) => res.json({ status:"ok", tickers: ALL_TICKERS.length }));

app.listen(PORT, () => console.log(`🚀 Scanner running on port ${PORT} | ${ALL_TICKERS.length} tickers loaded`));