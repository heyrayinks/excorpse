// DrawRun shared world model — loaded by BOTH the server (require) and the
// browser (<script src="/drawrun-world.js">), so builder rules and terrain
// math can never drift between the two.
//
// The road is endless: stored in 400 px chunks created on demand and pruned
// behind the camera. New chunks are ALWAYS flat (BASE_Y) regardless of what
// neighbours look like, so every machine builds identical terrain no matter
// in which order it happens to create chunks. Edits are validated against
// slope limits including the neighbouring sample, so flat chunks can't hide
// a cliff.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DRWorld = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const C = {
    CELL: 4, CPC: 100, BASE_Y: 336, MIN_Y: 150, MAX_Y: 372,
    MAXGAP: 100, MINGAP: 30, START_X: 60, VW: 800, BW: 1600, LH: 400,
    NET_MARGIN: 250,                 // build zone starts this far beyond the runner's screen (covers network delay)
    SPEED: 160, ACCEL: 4, MAXSPEED: 280,
    REGEN: 10, REGEN_RAMP: 1, REGEN_RAMP_T: 60,
    COST: { gap: 18, wall: 12, spike: 8, bar: 10, bullet: 10, hillPerPx: 0.12 },
    DIM: { wall: { w: 14, h: 70 }, spike: { w: 24, h: 20 }, bar: { w: 80, h: 10 } },
    BULLET_VX: -220, BULLET_R: 9, MAX_BULLETS: 6,
    OBS_SPACING: 120, GAP_SPACING: 150, OBS_GAP_CLEAR: 120,
    GRAVITY: 1800, JUMP: 640, SNAP: 8,
  };
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const speedAt = t => Math.min(C.MAXSPEED, C.SPEED + C.ACCEL * t);
  const regenAt = t => C.REGEN * (1 + C.REGEN_RAMP * Math.min(1, t / C.REGEN_RAMP_T));
  const camXFor = px => Math.max(0, px - 200);
  // Leftmost x the builder may edit. Leads the runner slightly so a stale
  // position report can never let an edit land on-screen.
  const lockFor = (px, speed) => camXFor(px + (speed || C.SPEED) * 0.15) + C.VW + C.NET_MARGIN;

  function createWorld() {
    const { CELL, CPC, BASE_Y } = C, CHUNK = CELL * CPC;
    const chunks = new Map();
    const DUMMY = { H: new Float32Array(CPC).fill(BASE_Y), G: new Uint8Array(CPC) };
    let minC = 0, maxC = -1;
    const w = { obs: [], nextId: 1, CHUNK };

    function ensureTo(c) {
      while (maxC < c) { maxC++; chunks.set(maxC, { H: new Float32Array(CPC).fill(BASE_Y), G: new Uint8Array(CPC) }); }
    }
    function chunkOf(i) {
      const c = Math.floor(i / CPC);
      if (c < minC || c < 0) return DUMMY;
      if (c > maxC) { if (c > maxC + 400) return DUMMY; ensureTo(c); } // refuse absurd indexes (bad input)
      return chunks.get(c);
    }
    const getH = i => chunkOf(i).H[((i % CPC) + CPC) % CPC];
    const getG = i => chunkOf(i).G[((i % CPC) + CPC) % CPC];
    function setH(i, v) { const ch = chunkOf(i); if (ch !== DUMMY) ch.H[i % CPC] = v; }
    function setG(i, v) { const ch = chunkOf(i); if (ch !== DUMMY) ch.G[i % CPC] = v; }
    const r1 = v => Math.round(v * 10) / 10;

    w.reset = function () { chunks.clear(); minC = 0; maxC = -1; w.obs = []; w.nextId = 1; ensureTo(3); };
    w.ensureAround = function (cx) {
      ensureTo(Math.floor((cx + C.BW + 800) / CHUNK));
      const keep = Math.floor((cx - 800) / CHUNK);
      while (minC < keep) { chunks.delete(minC); minC++; }
      w.obs = w.obs.filter(o => o.x + o.w > cx - 400);
    };
    w.chunkCount = () => chunks.size;
    w.getH = getH; w.getG = getG;
    w.road = x => { x = Math.max(0, x); const i = x / CELL, i0 = Math.floor(i), f = i - i0; return getH(i0) * (1 - f) + getH(i0 + 1) * f; };
    w.gapAt = x => getG(Math.floor(Math.max(0, x) / CELL)) === 1;
    w.gapNear = (a, b) => { for (let i = Math.max(0, Math.floor(a / CELL)); i <= Math.floor(b / CELL); i++) if (getG(i)) return true; return false; };
    w.obsRect = o => {
      const base = w.road(o.x + o.w / 2);
      return o.t === 'bar' ? { x: o.x, y: base - o.clear - o.h, w: o.w, h: o.h } : { x: o.x, y: base - o.h, w: o.w, h: o.h };
    };

    // ---- applying confirmed edits (clients, and the server's replay log) ----
    w.applyH = (a, vals) => { for (let k = 0; k < vals.length; k++) setH(a + k, vals[k]); };
    w.applyGap = (i0, i1) => { for (let i = i0; i <= i1; i++) setG(i, 1); };
    w.addObs = o => { w.obs.push(o); if (o.id >= w.nextId) w.nextId = o.id + 1; };

    // ---- validated edits (server): mutate the world, return what to broadcast ----
    // Hill: a gaussian bump of height `dy` (screen-down positive) centred on ax.
    w.sculpt = function (ax, sigma, dy, lock, energy) {
      if (![ax, sigma, dy, lock, energy].every(Number.isFinite)) return null;
      sigma = clamp(sigma, 30, 100); dy = clamp(dy, -40, 40); ax = Math.max(0, ax);
      for (const sc of [1, 0.5, 0.25]) {
        const d = dy * sc, cost = Math.abs(d) * C.COST.hillPerPx;
        if (energy < cost) return null;
        const a = Math.max(1, Math.floor((ax - 3 * sigma) / CELL)), b = Math.ceil((ax + 3 * sigma) / CELL);
        const bak = []; for (let i = a - 1; i <= b + 1; i++) bak.push(getH(i));
        let ok = true;
        for (let i = a; i <= b; i++) {
          const x = i * CELL; if (x < lock) continue;
          const k = x - ax, v = r1(getH(i) + d * Math.exp(-k * k / (2 * sigma * sigma)));
          setH(i, v); if (v < C.MIN_Y || v > C.MAX_Y) ok = false;
        }
        for (let i = a; i <= b + 1 && ok; i++) if (Math.abs(getH(i) - getH(i - 1)) > CELL) ok = false;
        if (ok) { const vals = []; for (let i = a; i <= b; i++) vals.push(r1(getH(i))); return { a, vals, cost }; }
        for (let i = a - 1; i <= b + 1; i++) setH(i, bak[i - a + 1]);
      }
      return null;
    };
    w.cutGap = function (x0, x1, lock, energy) {
      if (![x0, x1, lock, energy].every(Number.isFinite)) return { err: 'Bad gap' };
      if (x1 < x0) [x0, x1] = [x1, x0];
      x0 = Math.max(0, x0); x1 = Math.min(x1, x0 + C.MAXGAP);
      if (x1 - x0 < C.MINGAP) return { err: 'Gap too small' };
      if (x0 < lock) return { err: 'Too close — build in the open zone' };
      if (energy < C.COST.gap) return { err: 'Not enough energy' };
      if (w.gapNear(x0 - C.GAP_SPACING, x1 + C.GAP_SPACING)) return { err: 'Gaps need 150 px of road between them' };
      if (w.obs.some(o => o.x + o.w > x0 - C.OBS_GAP_CLEAR && o.x < x1 + C.OBS_GAP_CLEAR)) return { err: 'Too close to an obstacle' };
      const i0 = Math.ceil(x0 / CELL), i1 = Math.floor(x1 / CELL);
      w.applyGap(i0, i1);
      return { i0, i1, cost: C.COST.gap };
    };
    // opts: { hbH: runner hitbox height, bullets: bullets currently alive }
    w.place = function (kind, wx, wy, lock, energy, opts) {
      opts = opts || {};
      if (![wx, wy, lock, energy].every(Number.isFinite)) return { err: 'Bad placement' };
      const cost = C.COST[kind];
      if (kind === 'hillPerPx' || cost === undefined) return { err: 'Unknown tool' };
      if (energy < cost) return { err: 'Not enough energy' };
      if (kind === 'bullet') {
        if (wx < lock) return { err: 'Too close — build in the open zone' };
        if ((opts.bullets || 0) >= C.MAX_BULLETS) return { err: 'Max 6 bullets at once' };
        return { cost, bullet: { x: Math.round(wx), y: Math.round(clamp(wy, 40, C.LH - 20)) } };
      }
      const dim = C.DIM[kind]; if (!dim) return { err: 'Unknown tool' };
      const o = { t: kind, x: Math.round(wx - dim.w / 2), w: dim.w, h: dim.h };
      if (kind === 'bar') o.clear = Math.round(clamp(opts.hbH || 55, 16, 60) * 0.5 + 12);
      if (o.x < lock) return { err: 'Too close — build in the open zone' };
      if (w.gapNear(o.x - C.OBS_GAP_CLEAR, o.x + o.w + C.OBS_GAP_CLEAR)) return { err: 'Too close to a gap' };
      if (w.obs.some(p => Math.abs(p.x + p.w / 2 - wx) < C.OBS_SPACING)) return { err: 'Too close to another obstacle' };
      if (kind === 'bar' && Math.abs(w.road(o.x) - w.road(o.x + o.w)) > 14) return { err: 'Road too steep for a low bar' };
      o.id = w.nextId++;
      return { cost, obs: o };
    };

    w.reset();
    return w;
  }

  return { C, clamp, speedAt, regenAt, camXFor, lockFor, createWorld };
});
