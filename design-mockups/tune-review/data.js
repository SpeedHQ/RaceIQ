// Synthetic stint data — shared by all mockups. Deterministic PRNG so every page matches.
(function () {
  let seed = 42;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

  const CORNERS = [
    { n: "T1", frac: 0.06, min: 118 }, { n: "T2", frac: 0.13, min: 96 },
    { n: "T3", frac: 0.22, min: 152 }, { n: "T4", frac: 0.31, min: 74 },
    { n: "T5", frac: 0.42, min: 132 }, { n: "T6", frac: 0.51, min: 88 },
    { n: "T7", frac: 0.63, min: 165 }, { n: "T8", frac: 0.72, min: 61 },
    { n: "T9", frac: 0.84, min: 108 }, { n: "T10", frac: 0.93, min: 142 },
  ];

  // Per-sample trace over track fraction (N points)
  function makeTrace(jitter, degrade) {
    const N = 480, t = [];
    for (let i = 0; i < N; i++) {
      const f = i / (N - 1);
      // nearest corner influence
      let brake = 0, steer = 0, near = null, dmin = 1;
      for (const c of CORNERS) {
        const d = Math.abs(f - c.frac);
        if (d < dmin) { dmin = d; near = c; }
      }
      const w = Math.max(0, 1 - dmin / 0.035);        // braking zone width
      const ws = Math.max(0, 1 - dmin / 0.05);        // steering width
      brake = w > 0 && f < near.frac ? Math.min(1, w * 1.25) : 0;
      steer = ws * (near.min < 100 ? 0.9 : 0.55) * (CORNERS.indexOf(near) % 2 ? 1 : -1);
      let throttle = brake > 0.05 ? 0 : Math.min(1, 0.25 + (dmin / 0.06));
      if (f > near.frac && dmin < 0.03) throttle = Math.min(1, (f - near.frac) / 0.03);
      // jitter models driver inconsistency
      brake = Math.max(0, Math.min(1, brake + (rnd() - 0.5) * jitter * (brake > 0 ? 1 : 0.06)));
      throttle = Math.max(0, Math.min(1, throttle + (rnd() - 0.5) * jitter));
      steer = Math.max(-1, Math.min(1, steer + (rnd() - 0.5) * jitter * 0.8));
      const vmax = 285 - degrade * 6;
      const speed = Math.max(near.min - degrade * 3,
        vmax - (near ? (1 - dmin * 14) * (vmax - near.min) * Math.max(0, 1 - dmin / 0.07) : 0))
        + (rnd() - 0.5) * 3;
      t.push({ f, throttle, brake, steer, speed });
    }
    return t;
  }

  const LAP_BASE = 92.412; // 1:32.412
  const laps = [];
  for (let i = 0; i < 12; i++) {
    const warm = i === 0 ? 2.8 : 0;
    const deg = i * 0.055;                       // tire degradation slope
    const noise = (rnd() - 0.5) * (i === 7 ? 2.4 : 0.55); // lap 8 = mistake
    const time = LAP_BASE + warm + deg + noise;
    const s1 = time * 0.31 + (rnd() - 0.5) * 0.2;
    const s2 = time * 0.40 + (rnd() - 0.5) * 0.25;
    laps.push({
      n: i + 1, time, sectors: [s1, s2, time - s1 - s2],
      valid: i !== 7, offTrack: i === 7,
      tyre: { FL: 82 + i * 1.1 + rnd() * 2, FR: 86 + i * 1.4 + rnd() * 2, RL: 80 + i * 0.9 + rnd() * 2, RR: 84 + i * 1.2 + rnd() * 2 },
      fuel: 48 - i * 2.1,
    });
  }
  const valid = laps.filter(l => l.valid && l.n !== 1);
  const times = valid.map(l => l.time);
  const best = Math.min(...times);
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const sd = Math.sqrt(times.reduce((a, t) => a + (t - mean) ** 2, 0) / times.length);
  // consistency score: 100 - scaled CoV
  const consistency = Math.max(0, Math.min(100, 100 - (sd / mean) * 100 * 28));
  // degradation slope via linear fit on valid laps
  const xs = valid.map(l => l.n), xm = xs.reduce((a, b) => a + b) / xs.length;
  const slope = valid.reduce((a, l) => a + (l.n - xm) * (l.time - mean), 0) /
                valid.reduce((a, l) => a + (l.n - xm) ** 2, 0);

  const bestTrace = makeTrace(0.03, 0);
  const focusTrace = makeTrace(0.11, 0.6);

  // input smoothness metrics off focus trace
  let overlap = 0, coast = 0;
  focusTrace.forEach(s => {
    if (s.throttle > 0.1 && s.brake > 0.1) overlap++;
    if (s.throttle < 0.05 && s.brake < 0.05) coast++;
  });

  const fmt = t => {
    const m = Math.floor(t / 60), s = (t - m * 60).toFixed(3);
    return m + ":" + (s.length < 6 ? "0" : "") + s;
  };

  window.STINT = {
    CORNERS, laps, valid, best, mean, sd, consistency,
    degradationSlope: slope,
    bestTrace, focusTrace,
    overlapPct: (overlap / focusTrace.length * 100),
    coastPct: (coast / focusTrace.length * 100),
    fmt,
    meta: { car: "Mazda MX-5 Cup", track: "Laguna Seca", tune: "v4 — softer rear ARB", date: "2026-02-14" },
    C: {
      throttle: getComputedStyle(document.documentElement).getPropertyValue("--ch-throttle").trim() || "#059669",
      brake: "#ef4444", steer: "#0891b2", clutch: "#3b82f6", warn: "#d97706",
      accent: "#22d3ee", green: "#34d399", amber: "#f59e0b", red: "#ef4444",
      grid: "#1e293b", dim: "#7a8ea0", text: "#f1f5f9", muted: "#a0b0c0",
    },
  };

  // tiny tooltip helper
  window.attachTip = function (el, getHtml) {
    let tip = document.querySelector(".tip");
    if (!tip) { tip = document.createElement("div"); tip.className = "tip"; document.body.appendChild(tip); }
    el.addEventListener("mousemove", e => {
      const html = getHtml(e);
      if (!html) { tip.style.display = "none"; return; }
      tip.innerHTML = html; tip.style.display = "block";
      tip.style.left = Math.min(e.clientX + 14, innerWidth - 220) + "px";
      tip.style.top = (e.clientY + 16) + "px";
    });
    el.addEventListener("mouseleave", () => tip.style.display = "none");
  };
})();
