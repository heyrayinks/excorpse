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
// onto the layer ONCE on lift-off with globalAlpha = preset.opacity and
// 'multiply' — so a single stroke reads as one even wash with a darker
// wet rim, and separate overlapping strokes genuinely darken each other
// the way layered watercolor does.
const BRUSH_PRESETS = {
    wc_wash:      { family: 'Watercolor', label: 'Wet Wash',     tip: 'wetDisc',     spacing: 0.35, opacity: 0.38, wet: true,  sizeRange: [8, 80],  size: 30, pressureSize: 0.5, scatter: 0.05, angle: 'none' },
    wc_bleed:     { family: 'Watercolor', label: 'Soft Bleed',   tip: 'softDisc',    spacing: 0.30, opacity: 0.30, wet: true,  sizeRange: [10, 90], size: 42, pressureSize: 0.5, scatter: 0.18, angle: 'none' },
    wc_dry:       { family: 'Watercolor', label: 'Dry Brush',    tip: 'toothCoarse', spacing: 0.22, opacity: 0.55, wet: false, sizeRange: [6, 60],  size: 22, pressureSize: 0.6, scatter: 0.04, angle: 'follow' },
    wc_granulate: { family: 'Watercolor', label: 'Granulating',  tip: 'granDisc',    spacing: 0.35, opacity: 0.42, wet: true,  sizeRange: [8, 80],  size: 32, pressureSize: 0.5, scatter: 0.06, angle: 'none' },
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
            // Interior wash with a stronger ring near the edge — composited,
            // that ring is the classic watercolor wet rim.
            grad.addColorStop(0, 'rgba(0,0,0,0.55)');
            grad.addColorStop(0.65, 'rgba(0,0,0,0.6)');
            grad.addColorStop(0.85, 'rgba(0,0,0,0.9)');
            grad.addColorStop(1, 'rgba(0,0,0,0)');
        } else if (tip === 'toothSoft' || tip === 'toothFine') {
            // Harder, denser base for dry media — the grain carved below
            // does the texturing, not the gradient.
            grad.addColorStop(0, 'rgba(0,0,0,0.95)');
            grad.addColorStop(0.75, 'rgba(0,0,0,0.8)');
            grad.addColorStop(1, 'rgba(0,0,0,0)');
        } else { // softDisc and the base for toothCoarse
            grad.addColorStop(0, 'rgba(0,0,0,0.9)');
            grad.addColorStop(0.6, 'rgba(0,0,0,0.6)');
            grad.addColorStop(1, 'rgba(0,0,0,0)');
        }
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, s, s);
    }

    // Texture passes carve paper-tooth holes out of the base disc.
    if (tip === 'granDisc') {
        ctx.globalCompositeOperation = 'destination-out';
        const dots = Math.max(12, Math.round(s * s / 60));
        for (let i = 0; i < dots; i++) {
            const a = Math.random() * Math.PI * 2;
            const d = Math.sqrt(Math.random()) * half;
            ctx.globalAlpha = 0.25 + Math.random() * 0.35;
            ctx.beginPath();
            ctx.arc(half + Math.cos(a) * d, half + Math.sin(a) * d, Math.max(0.6, s * (0.02 + Math.random() * 0.05)), 0, Math.PI * 2);
            ctx.fill();
        }
    } else if (tip === 'toothCoarse') {
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

// Pressure -> stamp width, per preset dynamics. Mouse/touch sit at a
// fixed mid pressure like the other tools.
function presetWidthFor(preset, baseSize, e) {
    const p = (e.pointerType === 'pen' && e.pressure > 0) ? e.pressure : 0.5;
    const factor = (1 - preset.pressureSize) + preset.pressureSize * Math.min(1.6, p * 1.6);
    return Math.max(1, baseSize * factor);
}
