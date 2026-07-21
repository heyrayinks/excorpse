// ============================================================================
// Exquisite Corpse — brush engine (ink stamps + parametric stamp engine)
// ============================================================================
// Extracted verbatim from index.html 2026-07-21 so that BOTH the app and the
// dev swatch harness (dev/brush-swatches.html) render brushes from the SAME
// code — a swatch sheet is only useful for tuning if it cannot drift from
// what players actually get. Loaded as a plain classic <script> before the
// main one (no bundler; Node 16 constraint), so these top-level consts and
// functions are visible to the main script exactly as when they were inline.
//
// Architecture notes live in BRUSH_ENGINE_PLAN.md. Deliberately NOT moved:
// FAMILY_ICONS and the TOOL_META registration loop (they depend on TOOL_META,
// which is app state, not engine state) — those stayed in index.html.

// ---------- INK SPLOTCH BRUSHES (subscriber set) ----------
// Shared stamp primitives for the three ink tools (Ink Splat, Ink
// Splatter, Wet Quill). Written once with explicit ctx/color args (the
// same convention as the oc* functions below) and called from BOTH
// drawing engines — these are new tools, so unlike the duplicated legacy
// primitives there's no proven behavior at risk in sharing them. Every
// stamp is randomized: two stamps of the same size never look identical,
// which is what makes ink read as ink.

// One irregular ink blot: a wobbly closed blob plus a scatter of
// satellite droplets, the bigger ones with a teardrop tail pointing back
// at the blob like a real splat's throw-off.
function inkStampSplat(ctx, color, size, x, y) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = color;

    const n = 10 + Math.floor(Math.random() * 5);
    const stretch = 0.78 + Math.random() * 0.45; // slight oval, random orientation
    const rot = Math.random() * Math.PI;
    const cosR = Math.cos(rot), sinR = Math.sin(rot);
    const pts = [];
    for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const r = size * (0.55 + Math.random() * 0.45);
        const ex = Math.cos(a) * r * stretch;
        const ey = Math.sin(a) * r / stretch;
        pts.push({ x: x + ex * cosR - ey * sinR, y: y + ex * sinR + ey * cosR });
    }
    // Smooth the polygon by curving through edge midpoints — straight
    // lines between random radii read as a gemstone, not a liquid.
    const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    ctx.beginPath();
    let m = mid(pts[n - 1], pts[0]);
    ctx.moveTo(m.x, m.y);
    for (let i = 0; i < n; i++) {
        const m2 = mid(pts[i], pts[(i + 1) % n]);
        ctx.quadraticCurveTo(pts[i].x, pts[i].y, m2.x, m2.y);
    }
    ctx.closePath();
    ctx.fill();

    const drops = 3 + Math.floor(Math.random() * 6);
    for (let i = 0; i < drops; i++) {
        const a = Math.random() * Math.PI * 2;
        const dist = size * (1.05 + Math.random() * 0.95);
        const dr = size * (0.05 + Math.pow(Math.random(), 2) * 0.16);
        const dx = x + Math.cos(a) * dist, dy = y + Math.sin(a) * dist;
        ctx.beginPath();
        ctx.arc(dx, dy, dr, 0, Math.PI * 2);
        ctx.fill();
        if (dr > size * 0.09) {
            const tailLen = dr * (2 + Math.random() * 1.5);
            const perp = a + Math.PI / 2;
            ctx.beginPath();
            ctx.moveTo(dx + Math.cos(perp) * dr * 0.7, dy + Math.sin(perp) * dr * 0.7);
            ctx.lineTo(dx - Math.cos(a) * tailLen, dy - Math.sin(a) * tailLen);
            ctx.lineTo(dx - Math.cos(perp) * dr * 0.7, dy - Math.sin(perp) * dr * 0.7);
            ctx.closePath();
            ctx.fill();
        }
    }
}

// One frame's worth of flicked droplets. Where the airbrush is a dense
// mist of translucent specks biased toward the center, this is the
// opposite: a few chunky, fully-opaque drops spread across the whole
// radius, elongated along their throw direction — the look of snapping a
// loaded brush at the page.
function inkStampSplatterFrame(ctx, color, radius, target, pressure) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = color;
    const drops = 1 + Math.round(pressure * 3);
    for (let i = 0; i < drops; i++) {
        const a = Math.random() * Math.PI * 2;
        const dist = Math.pow(Math.random(), 0.7) * radius;
        const dx = target.x + Math.cos(a) * dist;
        const dy = target.y + Math.sin(a) * dist;
        const dr = Math.max(0.4, radius * (0.02 + Math.pow(Math.random(), 3.2) * 0.14));
        const len = dr * (1 + Math.random() * 1.6); // elongated along the flick
        ctx.globalAlpha = 0.85 + Math.random() * 0.15;
        ctx.beginPath();
        ctx.ellipse(dx, dy, len, dr, a, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.globalAlpha = 1;
}

// A small pooling blob — a mini splat without satellites. The quill drops
// these where a stroke starts, lingers, or ends (wet ink pooling), and a
// tiny version doubles as the occasional stray fleck beside the line.
function inkStampQuillBlob(ctx, color, size, x, y) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = color;
    const n = 8;
    const pts = [];
    for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const r = size * (0.72 + Math.random() * 0.28);
        pts.push({ x: x + Math.cos(a) * r, y: y + Math.sin(a) * r });
    }
    const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    ctx.beginPath();
    let m = mid(pts[n - 1], pts[0]);
    ctx.moveTo(m.x, m.y);
    for (let i = 0; i < n; i++) {
        const m2 = mid(pts[i], pts[(i + 1) % n]);
        ctx.quadraticCurveTo(pts[i].x, pts[i].y, m2.x, m2.y);
    }
    ctx.closePath();
    ctx.fill();
}

// ---------- PARAMETRIC STAMP ENGINE (subscriber brush families) ----------
// One data-driven engine for the Watercolor / Charcoal / Pastel families:
// every brush is a row in BRUSH_PRESETS (tip texture, spacing, opacity,
// pressure dynamics), rendered by stampAlongSegment() walking the stroke
// and stamping cached tinted tip sprites. New brushes are new rows, not
// new code — which is what a "new brushes as they release" subscription
// needs. Tips are procedural (no assets fetched at runtime); parameter
// feel is tuned by eye against Krita/MyPaint's CC0/public-domain preset
// packs, but all code here is original — Krita's own engines are GPL C++
// and were never copied.
//
// `wet: true` presets (watercolor washes) don't paint the layer directly:
// stamps accumulate in an offscreen "wet buffer" at full strength during
// the stroke (previewed on a transparent overlay canvas), then composite
// onto the layer ONCE on lift-off via compositeWetStroke() — so a single
// stroke reads as one even wash, and separate overlapping strokes darken
// each other the way layered watercolor does.
//
// The wash's CHARACTER (edge rim, granulation) is applied at that composite
// step, not baked into the tip — see compositeWetStroke for why. Wet tips
// are therefore deliberately flat-topped: their job is to build an even
// field of alpha, nothing else.
//   rim        — strength of the dried-edge darkening (0 = off)
//   rimWidth   — how far that rim reaches inward, px at RENDER_SCALE 1
//   granulate  — strength of paper-locked pigment settling (0 = off)
const BRUSH_PRESETS = {
    wc_wash:      { family: 'Watercolor', label: 'Wet Wash',     tip: 'wetDisc',     spacing: 0.18, opacity: 0.38, wet: true,  rim: 2.2, rimWidth: 4,  sizeRange: [8, 80],  size: 30, pressureSize: 0.5, scatter: 0.05, angle: 'none' },
    wc_bleed:     { family: 'Watercolor', label: 'Soft Bleed',   tip: 'softDisc',    spacing: 0.16, opacity: 0.30, wet: true,  rim: 0.8, rimWidth: 10, sizeRange: [10, 90], size: 42, pressureSize: 0.5, scatter: 0.08, angle: 'none' },
    wc_dry:       { family: 'Watercolor', label: 'Dry Brush',    tip: 'toothCoarse', spacing: 0.22, opacity: 0.55, wet: false, sizeRange: [6, 60],  size: 22, pressureSize: 0.6, scatter: 0.04, angle: 'follow' },
    wc_granulate: { family: 'Watercolor', label: 'Granulating',  tip: 'granDisc',    spacing: 0.18, opacity: 0.42, wet: true,  rim: 1.8, rimWidth: 4, granulate: 0.85, sizeRange: [8, 80],  size: 32, pressureSize: 0.5, scatter: 0.06, angle: 'none' },
    // Charcoal: dry stamping, low per-stamp alpha that builds up with
    // passes, grain carved from the tip, texture rotating with travel.
    ch_willow:     { family: 'Charcoal', label: 'Willow',          tip: 'toothSoft', spacing: 0.25, opacity: 1, stampAlpha: 0.28, wet: false, sizeRange: [6, 70],  size: 26, pressureSize: 0.45, scatter: 0.06, angle: 'follow' },
    ch_compressed: { family: 'Charcoal', label: 'Compressed',      tip: 'toothFine', spacing: 0.22, opacity: 1, stampAlpha: 0.7,  wet: false, sizeRange: [4, 60],  size: 18, pressureSize: 0.5,  scatter: 0.04, angle: 'follow' },
    ch_pencil:     { family: 'Charcoal', label: 'Charcoal Pencil', tip: 'toothFine', spacing: 0.3,  opacity: 1, stampAlpha: 0.55, wet: false, sizeRange: [2, 24],  size: 8,  pressureSize: 0.6,  scatter: 0.03, angle: 'follow' },
    ch_stick:      { family: 'Charcoal', label: 'Side Stick',      tip: 'flatStick', spacing: 0.15, opacity: 1, stampAlpha: 0.5,  wet: false, sizeRange: [12, 90], size: 40, pressureSize: 0.4,  scatter: 0.02, angle: 'follow' },
    // Pastel: near-opaque waxy/chalky stamps with crumbly edges and
    // per-stamp color jitter (each cached tip variant carries a slightly
    // nudged tint, so the wobble costs nothing at stamp time).
    op_soft:    { family: 'Pastel', label: 'Soft Pastel', tip: 'pastelTip',     spacing: 0.28, opacity: 1, stampAlpha: 0.75, colorJitter: 0.05, wet: false, sizeRange: [6, 70],  size: 24, pressureSize: 0.5, scatter: 0.05, angle: 'follow' },
    op_heavy:   { family: 'Pastel', label: 'Oil Pastel',  tip: 'pastelHeavy',   spacing: 0.22, opacity: 1, stampAlpha: 0.95, colorJitter: 0.07, wet: false, sizeRange: [6, 70],  size: 26, pressureSize: 0.5, scatter: 0.03, angle: 'follow' },
    op_scumble: { family: 'Pastel', label: 'Scumble',     tip: 'pastelScumble', spacing: 0.3,  opacity: 1, stampAlpha: 0.6,  colorJitter: 0.06, wet: false, sizeRange: [10, 90], size: 40, pressureSize: 0.4, scatter: 0.12, angle: 'follow' },
    op_chalk:   { family: 'Pastel', label: 'Chalk',       tip: 'toothSoft',     spacing: 0.3,  opacity: 1, stampAlpha: 0.4,  colorJitter: 0.08, wet: false, sizeRange: [6, 70],  size: 26, pressureSize: 0.5, scatter: 0.06, angle: 'follow' },
};


// ---- Tip sprite factory ----
// Tips are built as black alpha-profile masks, tinted via 'source-in',
// and cached per (tip, color, size bucket, variant). All stamping is
// drawImage of these cached sprites — never per-stamp path drawing —
// which is what keeps textured brushes usable at the 300 DPI canvas.
const TIP_VARIANTS = 4; // pre-baked randomizations per textured tip, picked per stamp
const tipCache = new Map();

function buildTipMask(tip, s) {
    const c = document.createElement('canvas');
    c.width = c.height = s;
    const ctx = c.getContext('2d');
    const half = s / 2;
    if (tip === 'pastelTip' || tip === 'pastelHeavy' || tip === 'pastelScumble') {
        // Near-opaque disc with a crumbly bitten edge — pastel doesn't
        // feather like a wet wash, it breaks up.
        ctx.fillStyle = 'rgba(0,0,0,0.95)';
        ctx.beginPath();
        ctx.arc(half, half, half * 0.92, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = 'destination-out';
        // Rim bites
        const bites = Math.max(8, Math.round(s / 3));
        for (let i = 0; i < bites; i++) {
            const a = Math.random() * Math.PI * 2;
            const d = half * (0.8 + Math.random() * 0.25);
            ctx.globalAlpha = 0.7 + Math.random() * 0.3;
            ctx.beginPath();
            ctx.arc(half + Math.cos(a) * d, half + Math.sin(a) * d, Math.max(0.8, s * (0.04 + Math.random() * 0.08)), 0, Math.PI * 2);
            ctx.fill();
        }
        if (tip === 'pastelScumble') {
            // Big interior holes — broken coverage that lets the layer
            // underneath show through.
            const holes = Math.max(10, Math.round(s * s / 45));
            for (let i = 0; i < holes; i++) {
                const a = Math.random() * Math.PI * 2;
                const d = Math.sqrt(Math.random()) * half * 0.85;
                ctx.globalAlpha = 0.6 + Math.random() * 0.4;
                ctx.beginPath();
                ctx.arc(half + Math.cos(a) * d, half + Math.sin(a) * d, Math.max(0.8, s * (0.05 + Math.random() * 0.09)), 0, Math.PI * 2);
                ctx.fill();
            }
        } else if (tip === 'pastelHeavy') {
            // Thin horizontal grooves: rotated with travel at stamp time,
            // they read as waxy bristle streaks running along the stroke.
            const grooves = Math.max(3, Math.round(s / 8));
            for (let i = 0; i < grooves; i++) {
                const gy = Math.random() * s;
                ctx.globalAlpha = 0.25 + Math.random() * 0.3;
                ctx.fillRect(0, gy, s, Math.max(0.5, s * 0.02));
            }
        } else {
            // Soft pastel: light chalky pitting
            const pits = Math.max(10, Math.round(s * s / 30));
            for (let i = 0; i < pits; i++) {
                const a = Math.random() * Math.PI * 2;
                const d = Math.sqrt(Math.random()) * half * 0.85;
                ctx.globalAlpha = 0.25 + Math.random() * 0.35;
                ctx.beginPath();
                ctx.arc(half + Math.cos(a) * d, half + Math.sin(a) * d, Math.max(0.5, s * (0.02 + Math.random() * 0.04)), 0, Math.PI * 2);
                ctx.fill();
            }
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        return c;
    }
    if (tip === 'flatStick') {
        // Tall flat ellipse (long axis vertical): rotated by travel
        // direction at stamp time, so it drags PERPENDICULAR to the
        // stroke — the side of a charcoal stick laying down a wide band.
        ctx.save();
        ctx.translate(half, half);
        ctx.scale(0.35, 1);
        const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, half);
        grad.addColorStop(0, 'rgba(0,0,0,0.95)');
        grad.addColorStop(0.85, 'rgba(0,0,0,0.85)');
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(0, 0, half, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    } else {
        const grad = ctx.createRadialGradient(half, half, 0, half, half, half);
        if (tip === 'wetDisc' || tip === 'granDisc') {
            // FLAT-TOPPED with a short feather. These used to carry a bright
            // ring at 0.85 to fake the watercolor wet rim, which was exactly
            // wrong: a rim on every stamp turns a stroke into a visible chain
            // of overlapping circles (scalloped edges, ribboned washes) — real
            // watercolor has ONE rim, around the perimeter of the whole dried
            // shape. That now happens in compositeWetStroke. A flat top also
            // means densely-spaced stamps saturate to an even field instead of
            // building lumpy density.
            grad.addColorStop(0, 'rgba(0,0,0,0.9)');
            grad.addColorStop(0.78, 'rgba(0,0,0,0.9)');
            grad.addColorStop(1, 'rgba(0,0,0,0)');
        } else if (tip === 'toothSoft' || tip === 'toothFine') {
            // Harder, denser base for dry media — the grain carved below
            // does the texturing, not the gradient.
            grad.addColorStop(0, 'rgba(0,0,0,0.95)');
            grad.addColorStop(0.75, 'rgba(0,0,0,0.8)');
            grad.addColorStop(1, 'rgba(0,0,0,0)');
        } else { // softDisc and the base for toothCoarse
            // softDisc keeps a longer feather than the flat wet tips (it's the
            // wet-on-wet brush), but not the old 0.6-at-60% ramp, which spread
            // density so gradually that strokes read as airbrushed cloud with
            // no edge anywhere.
            grad.addColorStop(0, 'rgba(0,0,0,0.9)');
            grad.addColorStop(0.55, 'rgba(0,0,0,0.82)');
            grad.addColorStop(1, 'rgba(0,0,0,0)');
        }
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, s, s);
    }

    // Texture passes carve paper-tooth holes out of the base disc.
    //
    // granDisc deliberately has NO carving pass any more. Grain punched into
    // the tip travels with the brush, so the "paper texture" slid around with
    // the stroke instead of staying registered to the sheet — the giveaway
    // that it wasn't paper at all. Granulation is now a paper-locked pass in
    // compositeWetStroke; granDisc is just the flat wet tip that opts into it.
    if (tip === 'toothCoarse') {
        ctx.globalCompositeOperation = 'destination-out';
        const dots = Math.max(20, Math.round(s * s / 30));
        for (let i = 0; i < dots; i++) {
            const a = Math.random() * Math.PI * 2;
            const d = Math.sqrt(Math.random()) * half;
            ctx.globalAlpha = 0.5 + Math.random() * 0.5;
            ctx.beginPath();
            ctx.arc(half + Math.cos(a) * d, half + Math.sin(a) * d, Math.max(0.8, s * (0.04 + Math.random() * 0.09)), 0, Math.PI * 2);
            ctx.fill();
        }
    } else if (tip === 'toothSoft' || tip === 'flatStick') {
        ctx.globalCompositeOperation = 'destination-out';
        const dots = Math.max(14, Math.round(s * s / 22));
        for (let i = 0; i < dots; i++) {
            const a = Math.random() * Math.PI * 2;
            const d = Math.sqrt(Math.random()) * half;
            ctx.globalAlpha = 0.3 + Math.random() * 0.4;
            ctx.beginPath();
            ctx.arc(half + Math.cos(a) * d, half + Math.sin(a) * d, Math.max(0.6, s * (0.03 + Math.random() * 0.05)), 0, Math.PI * 2);
            ctx.fill();
        }
    } else if (tip === 'toothFine') {
        ctx.globalCompositeOperation = 'destination-out';
        const dots = Math.max(18, Math.round(s * s / 14));
        for (let i = 0; i < dots; i++) {
            const a = Math.random() * Math.PI * 2;
            const d = Math.sqrt(Math.random()) * half;
            ctx.globalAlpha = 0.35 + Math.random() * 0.4;
            ctx.beginPath();
            ctx.arc(half + Math.cos(a) * d, half + Math.sin(a) * d, Math.max(0.4, s * (0.015 + Math.random() * 0.03)), 0, Math.PI * 2);
            ctx.fill();
        }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    return c;
}

// Deterministic per-variant color nudge (lightness + a whisper of hue).
// Each cached tip variant gets its own tint, so picking a random variant
// per stamp gives pastel's natural color wobble for free.
function jitterColor(hex, amt, variant) {
    const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    let h = 0, sat = 0;
    if (d > 0) {
        sat = d / (1 - Math.abs(2 * l - 1));
        if (max === r) h = 60 * (((g - b) / d) % 6);
        else if (max === g) h = 60 * ((b - r) / d + 2);
        else h = 60 * ((r - g) / d + 4);
        if (h < 0) h += 360;
    }
    const seeds = [[-1, 0.6], [0.7, -0.4], [-0.3, -0.9], [1, 0.8]];
    const [dl, dh] = seeds[variant % seeds.length];
    const l2 = Math.min(0.95, Math.max(0.05, l + dl * amt));
    const h2 = (h + dh * amt * 80 + 360) % 360;
    return `hsl(${h2.toFixed(1)}, ${(sat * 100).toFixed(1)}%, ${(l2 * 100).toFixed(1)}%)`;
}

function tipSprite(tip, color, w, colorJitter) {
    // Bucketed sprite size: sprites are drawn at the bucket size and
    // drawImage-scaled to the exact stamp width, keeping the cache small.
    const bucket = Math.max(8, Math.pow(2, Math.ceil(Math.log2(w))));
    const variant = Math.floor(Math.random() * TIP_VARIANTS);
    const key = `${tip}|${color}|${bucket}|${variant}|${colorJitter || 0}`;
    let sprite = tipCache.get(key);
    if (!sprite) {
        if (tipCache.size > 64) tipCache.clear(); // cheap cap; rebuilt lazily
        const mask = buildTipMask(tip, bucket);
        const ctx = mask.getContext('2d');
        ctx.globalCompositeOperation = 'source-in';
        ctx.fillStyle = colorJitter ? jitterColor(color, colorJitter, variant) : color;
        ctx.fillRect(0, 0, bucket, bucket);
        sprite = mask;
        tipCache.set(key, sprite);
    }
    return sprite;
}

// ---- The one shared stroke primitive ----
// Walks a segment stamping every (spacing x width), carrying leftover
// distance in state.residual so stamp cadence is seamless across the
// segment boundaries of a polyline. state = { residual, dir } per stroke.
function stampAlongSegment(ctx, presetId, color, from, to, fromW, toW, state) {
    const preset = BRUSH_PRESETS[presetId];
    const dx = to.x - from.x, dy = to.y - from.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 0.5 && preset.angle === 'follow') {
        const dir = Math.atan2(dy, dx);
        if (state.dir === undefined) state.dir = dir;
        else {
            let delta = dir - state.dir;
            while (delta > Math.PI) delta -= Math.PI * 2;
            while (delta < -Math.PI) delta += Math.PI * 2;
            state.dir += delta * 0.3; // smoothed so texture doesn't twitch
        }
    }
    const stampAt = (x, y, w) => {
        const sprite = tipSprite(preset.tip, color, w, preset.colorJitter);
        ctx.globalCompositeOperation = 'source-over';
        // Dry media (charcoal/pastel) stamp translucently and build up
        // over repeated passes; wet presets stamp at full strength since
        // their whole stroke gets one opacity pass at composite time.
        ctx.globalAlpha = preset.stampAlpha ?? 1;
        if (preset.angle === 'follow' && state.dir !== undefined) {
            ctx.save();
            ctx.translate(x, y);
            ctx.rotate(state.dir);
            ctx.drawImage(sprite, -w / 2, -w / 2, w, w);
            ctx.restore();
        } else {
            ctx.drawImage(sprite, x - w / 2, y - w / 2, w, w);
        }
        ctx.globalAlpha = 1;
    };

    if (dist < 0.02) { // the "dot on tap" stamp at stroke start
        stampAt(from.x, from.y, Math.max(1, fromW));
        state.residual = 0;
        return;
    }
    const step = Math.max(1, preset.spacing * Math.max((fromW + toW) / 2, 2));
    // Clamp: if the width (and so the step) shrank since the residual was
    // banked, an oversized residual would otherwise walk pos backwards.
    let sinceLast = Math.min(state.residual, step); // distance travelled since the last stamp, carried across segments
    let pos = 0;
    while (pos + (step - sinceLast) <= dist) {
        pos += step - sinceLast;
        sinceLast = 0;
        const t = pos / dist;
        const w = Math.max(1, fromW + (toW - fromW) * t);
        const jitter = preset.scatter * w;
        stampAt(
            from.x + dx * t + (Math.random() - 0.5) * 2 * jitter,
            from.y + dy * t + (Math.random() - 0.5) * 2 * jitter,
            w
        );
    }
    state.residual = sinceLast + (dist - pos);
}

// ---- Wet stroke composite (where a wash becomes watercolor) ----
//
// Called once per wet stroke, on lift, by BOTH drawing engines, the Open
// Canvas remote-replay path, and the dev swatch harness. The buffer holds the
// stroke as an even field of alpha at full strength; everything that makes it
// read as watercolor rather than translucent ink happens here, for one reason:
// these are properties of the whole dried SHAPE, not of any single stamp.
//
//   1. the wash itself   — multiply at preset.opacity (unchanged)
//   2. the dried edge    — pigment migrates outward as water evaporates and
//                          strands at the boundary, leaving the perimeter
//                          darker than the middle. THE single strongest tell
//                          of real watercolor.
//   3. granulation       — heavy pigments settle into the hollows of the
//                          paper, so the mottling is registered to the sheet
//                          and does not move with the brush.
//
// `scale` is RENDER_SCALE, so rim width is a constant physical size rather
// than shrinking to a hairline at 300 DPI.
function compositeWetStroke(destCtx, buffer, preset, scale) {
    const w = buffer.width, h = buffer.height;
    scale = scale || 1;

    destCtx.save();
    destCtx.globalCompositeOperation = 'multiply';
    destCtx.globalAlpha = preset.opacity;
    destCtx.drawImage(buffer, 0, 0);

    // --- Dried edge ---
    // The rim band is  A * (1 - blur(A))  where A is the stroke's alpha:
    // ~0 deep inside (blur is still ~1 there), rising to a peak just inside
    // the boundary, and 0 outside it. destination-out computes exactly that
    // in one drawImage, since it resolves to dstAlpha * (1 - srcAlpha).
    //
    if (preset.rim) {
        const rimPx = Math.max(2, Math.round((preset.rimWidth || 7) * scale));
        const rim = document.createElement('canvas');
        rim.width = w; rim.height = h;
        const rctx = rim.getContext('2d');
        rctx.drawImage(buffer, 0, 0);
        rctx.globalCompositeOperation = 'destination-out';
        rctx.drawImage(blurredAlpha(buffer, rimPx), 0, 0);

        // rim is a multiplier on the wash opacity and is allowed to exceed 1
        // (the band peaks at ~0.5 alpha, so it needs the headroom to read).
        destCtx.globalAlpha = Math.min(1, preset.opacity * preset.rim);
        destCtx.drawImage(rim, 0, 0);
    }

    // --- Granulation ---
    // Knock holes in a copy of the stroke using a canvas-fixed noise field,
    // then lay that copy down as extra pigment: what survives is the paint
    // that settled into the paper's low spots. Because the noise is addressed
    // in canvas coordinates, two strokes crossing the same patch of paper
    // granulate into the SAME hollows, which is what sells it.
    if (preset.granulate) {
        const grain = paperGrainField(w, h);
        const gran = document.createElement('canvas');
        gran.width = w; gran.height = h;
        const gctx = gran.getContext('2d');
        gctx.drawImage(buffer, 0, 0);
        gctx.globalCompositeOperation = 'destination-out';
        gctx.drawImage(grain, 0, 0, w, h);

        destCtx.globalAlpha = preset.opacity * preset.granulate;
        destCtx.drawImage(gran, 0, 0);
    }

    destCtx.restore();
}

// Blur used to find a stroke's boundary. Prefers the native canvas filter,
// which is a true symmetric gaussian; falls back to repeated halving for
// browsers without it (Safari below 17), since iPad matters here.
//
// The fallback halves in STAGES rather than resampling straight down to
// 1/radius in one step: a single big downscale quantises the blur to a grid
// that size, which lands a stroke's two edges at different offsets within a
// grid cell and produced a rim on one side of a stroke and not the other.
let canvasFilterOk = null;
function blurredAlpha(src, radius) {
    const w = src.width, h = src.height;
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const octx = out.getContext('2d');

    if (canvasFilterOk === null) {
        const probe = document.createElement('canvas').getContext('2d');
        probe.filter = 'blur(2px)';
        canvasFilterOk = probe.filter === 'blur(2px)';
    }
    if (canvasFilterOk) {
        octx.filter = `blur(${radius}px)`;
        octx.drawImage(src, 0, 0);
        octx.filter = 'none';
        return out;
    }

    let cur = src, cw = w, ch = h;
    for (let r = radius; r > 1; r /= 2) {
        const nw = Math.max(1, Math.round(cw / 2)), nh = Math.max(1, Math.round(ch / 2));
        const step = document.createElement('canvas');
        step.width = nw; step.height = nh;
        const sctx = step.getContext('2d');
        sctx.imageSmoothingEnabled = true;
        sctx.drawImage(cur, 0, 0, nw, nh);
        cur = step; cw = nw; ch = nh;
    }
    octx.imageSmoothingEnabled = true;
    octx.drawImage(cur, 0, 0, w, h);
    return out;
}

// Lazily-built, cached noise field covering the whole canvas — the paper's
// tooth. Generated at a quarter resolution and upscaled at use: clumps land
// at roughly the 3-5px scale of real cold-press tooth, it costs a fraction of
// a full-size ImageData pass (which would be 34MB at 300 DPI), and unlike a
// repeating tile there are no seams to spot.
const paperGrainCache = new Map();
function paperGrainField(w, h) {
    const key = w + 'x' + h;
    let field = paperGrainCache.get(key);
    if (field) return field;
    if (paperGrainCache.size > 4) paperGrainCache.clear();

    const gw = Math.max(1, Math.round(w / 4)), gh = Math.max(1, Math.round(h / 4));
    field = document.createElement('canvas');
    field.width = gw; field.height = gh;
    const ctx = field.getContext('2d');
    const img = ctx.createImageData(gw, gh);
    const d = img.data;
    for (let i = 0; i < gw * gh; i++) {
        // Biased low so most of the wash survives and the grain reads as
        // scattered settling rather than a screen door over the whole stroke.
        const v = Math.pow(Math.random(), 1.7);
        d[i * 4 + 3] = Math.round(v * 235);
    }
    ctx.putImageData(img, 0, 0);
    paperGrainCache.set(key, field);
    return field;
}

// Pressure -> stamp width, per preset dynamics. Mouse/touch sit at a
// fixed mid pressure like the other tools.
function presetWidthFor(preset, baseSize, e) {
    const p = (e.pointerType === 'pen' && e.pressure > 0) ? e.pressure : 0.5;
    const factor = (1 - preset.pressureSize) + preset.pressureSize * Math.min(1.6, p * 1.6);
    return Math.max(1, baseSize * factor);
}
