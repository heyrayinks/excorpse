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
// and stamping cached tinted tip sprites. A brush reusing an existing tip
// needs only a row — but that's a wiring convenience, NOT a way to ship
// brushes: 15 were added this way in a day and all but one were pulled
// within a fortnight. See the quality bar in BRUSH_ENGINE_PLAN.md before
// adding another. Tips are procedural (no assets fetched at runtime); parameter
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
    // Ink. The nib angle is fixed in page space (about -40 degrees, the usual
    // broad-nib hold), so direction changes modulate the line the way they do
    // on paper. Replaced the old Wet Quill, whose speed-driven width plus ink
    // pooling read as blobby rather than as a pen.
    // Filed under Basics and free (2026-07-21): it earned its place in the
    // permanent free set alongside Pen / Eraser / Fill / Airbrush, and with
    // Pencil and Brush pulled it's the only broad-mark tool left. `icon` is
    // explicit because Basics has no family glyph.
    ink_nib:      { family: 'Basics', free: true, icon: '/graphics/Exquisite-corpse-tool-icons-10-QUILL.svg', label: 'Chisel Nib', nib: true, nibAngle: -0.7, wet: false, sizeRange: [3, 34], size: 11, pressureSize: 0.5 },
    // First brush built from real scans. Spacing is WIDE because each stamp is
    // already a stretch of dragged stroke, not a contact patch — stamping these
    // densely smears the streaking that is the whole point of them. Follow is
    // high for the same reason: the mark carries its own drag direction, and a
    // fixed hold would lay the streaks across the line instead of along it.
    // Dry brush, second set. These impressions are near-round, so spinning each
    // dab costs almost no width but decorrelates the lace — which is the whole
    // problem with a broken tip: repetition is invisible on a solid stamp and
    // reads as a caterpillar on a lacy one. Hence the near-free full rotation
    // rather than the small angle wobble the elongated sets use.
    dry_brush:    { retired: true, family: 'Watercolor', label: 'Dry Brush',    stamps: 'dry_brush', spacing: 0.16, wet: false, stampAlpha: 0.5, sizeRange: [6, 70], size: 26, pressureSize: 0.75, scatter: 0.04, angle: 'follow', stampAngle: 0, stampFollow: 0.15, angleJitter: 3.14, sizeJitter: 0.10, offsetJitter: 0.06 },
    // Brush pen. These impressions ARE contact patches, so unlike the dry brush
    // they stamp densely and hold a mostly-fixed angle: the thick/thin is the
    // tip staying put while the stroke direction turns under it, the same
    // geometry as the Chisel Nib.
    brush_pen:    { retired: true, family: 'Basics', label: 'Brush Pen',        stamps: 'brush_pen', spacing: 0.14, wet: false, stampAlpha: 0.9, sizeRange: [4, 60], size: 18, pressureSize: 0.8, scatter: 0.01, angle: 'follow', stampAngle: -0.7, stampFollow: 0.2, angleJitter: 0.07, sizeJitter: 0.06, offsetJitter: 0.03 },
    wc_wash:      { retired: true, family: 'Watercolor', label: 'Wet Wash',     tip: 'wetDisc',     spacing: 0.18, opacity: 0.38, wet: true,  rim: 2.2, rimWidth: 4,  sizeRange: [8, 80],  size: 30, pressureSize: 0.75, scatter: 0.05, angle: 'none' },
    wc_bleed:     { retired: true, family: 'Watercolor', label: 'Soft Bleed',   tip: 'softDisc',    spacing: 0.16, opacity: 0.30, wet: true,  rim: 0.8, rimWidth: 10, sizeRange: [10, 90], size: 42, pressureSize: 0.7, scatter: 0.08, angle: 'none' },
    wc_dry:       { retired: true, family: 'Watercolor', label: 'Dry Brush',    rake: true, grains: 46, tooth: 0.75, grit: 0.42, gritScale: 0.13, stampAlpha: 0.62, wet: false, sizeRange: [6, 60],  size: 22, pressureSize: 0.8 },
    wc_granulate: { retired: true, family: 'Watercolor', label: 'Granulating',  tip: 'granDisc',    spacing: 0.18, opacity: 0.42, wet: true,  rim: 1.8, rimWidth: 4, granulate: 0.85, sizeRange: [8, 80],  size: 32, pressureSize: 0.75, scatter: 0.06, angle: 'none' },
    // Charcoal and Pastel are all dragged tips (rake: true) — see
    // rakeAlongSegment. `grains` is roughly how many ridges touch the paper,
    // `grit`/`gritScale` how readily they lift and how fine the resulting
    // break-up is. A high grit with few grains is a bald, scratchy stick; a low
    // grit with many is a dense soft one.
    ch_willow:     { retired: true, family: 'Charcoal', label: 'Willow',          rake: true, grains: 44, tooth: 0.8, grit: 0.34, gritScale: 0.10, stampAlpha: 0.34, wet: false, sizeRange: [6, 70],  size: 26, pressureSize: 0.7 },
    ch_compressed: { retired: true, family: 'Charcoal', label: 'Compressed',      rake: true, grains: 60, tooth: 0.55, grit: 0.16, gritScale: 0.07, stampAlpha: 0.72, wet: false, sizeRange: [4, 60],  size: 18, pressureSize: 0.75 },
    ch_pencil:     { retired: true, family: 'Charcoal', label: 'Charcoal Pencil', rake: true, grains: 22, tooth: 0.35, grit: 0.22, gritScale: 0.16, stampAlpha: 0.6,  wet: false, sizeRange: [2, 24],  size: 8,  pressureSize: 0.8 },
    ch_stick:      { retired: true, family: 'Charcoal', label: 'Side Stick',      rake: true, grains: 72, tooth: 0.85, grit: 0.40, gritScale: 0.06, stampAlpha: 0.52, wet: false, sizeRange: [12, 90], size: 40, pressureSize: 0.6 },
    // Pastel: waxy/chalky, with the colour wobble now carried per contact
    // ridge rather than per stamp.
    op_soft:    { retired: true, family: 'Pastel', label: 'Soft Pastel', rake: true, grains: 50, tooth: 0.7, grit: 0.30, gritScale: 0.09, stampAlpha: 0.72, colorJitter: 0.05, wet: false, sizeRange: [6, 70],  size: 24, pressureSize: 0.72 },
    op_heavy:   { retired: true, family: 'Pastel', label: 'Oil Pastel',  rake: true, grains: 66, tooth: 0.4, grit: 0.12, gritScale: 0.05, stampAlpha: 0.92, colorJitter: 0.07, wet: false, sizeRange: [6, 70],  size: 26, pressureSize: 0.7 },
    op_scumble: { retired: true, family: 'Pastel', label: 'Scumble',     rake: true, grains: 32, tooth: 0.85, grit: 0.55, gritScale: 0.15, stampAlpha: 0.6,  colorJitter: 0.06, wet: false, sizeRange: [10, 90], size: 40, pressureSize: 0.6 },
    op_chalk:   { retired: true, family: 'Pastel', label: 'Chalk',       rake: true, grains: 46, tooth: 0.8, grit: 0.38, gritScale: 0.11, stampAlpha: 0.44, colorJitter: 0.08, wet: false, sizeRange: [6, 70],  size: 26, pressureSize: 0.72 },
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

// ---- Image stamp tips (scanned impressions) ----
// The one place the engine fetches an asset at runtime. Everything else here
// is procedural on purpose, so this path is deliberately narrow: a preset opts
// in with `stamps: '<setName>'`, and the set is a handful of PNGs of the SAME
// tip pressed and lifted — the contact patch, not a stroke. Dense spacing means
// the silhouette is never seen as such; what reads is the edge quality.
//
// These are our own scans, which also keeps us clear of the tip-PNG licensing
// question in BRUSH_ENGINE_PLAN.md — nothing third-party enters the repo.
const STAMP_SETS = {
    // First real set (2026-07-22): one loaded brush dragged repeatedly until it
    // ran out. ORDERED — 01 is the last, driest mark — so it's used as a
    // depletion run, not a shuffle. Only 01-03 are loaded: 04 and 05 are the
    // heavily-loaded sampling marks, and that's not the ink level this brush is
    // for. It also keeps the across-axis in a 27-41px band instead of 27-91,
    // which is what made the dry-out step rather than fade.
    // Superseded by dry-brush-02 (the first set was dragged marks, which the
    // engine then swept a second time — see BRUSH_ENGINE_PLAN.md). Kept only
    // so the old sheets can be re-rendered for comparison.
    dry_brush_v1: { dir: '/graphics/stamps/dry-brush', prefix: 'dry-brush-', count: 3, slice: 0.24 },
    // Second dry-brush set (2026-07-22): 10 press-and-lift impressions, lacy
    // and broken, near-round (aspect 0.8-1.5). Unordered — ink coverage isn't
    // monotonic across the files — so these cycle as variants rather than
    // running as a depletion sequence.
    dry_brush: { dir: '/graphics/stamps/dry-brush-02', prefix: 'dry-brush-02-', count: 10 },
    // Brush pen: stays loaded, so every mark is dense and full. Unordered —
    // these are interchangeable impressions, and the thick/thin comes from the
    // tip's angle against the stroke, not from running out of ink.
    brush_pen: { dir: '/graphics/stamps/brush-pen', prefix: 'brush-pen-', count: 5 },
};
const stampMasks = new Map();  // setName -> [canvas] once decoded
const stampLoads = new Map();  // setName -> Promise, so concurrent asks share

// Alpha comes from DARKNESS for a scan on white paper, or straight from the
// alpha channel if the PNG was cut out. Sniffing which avoids a flag the
// person making the stamps would have to remember to set correctly.
function maskFromImage(img) {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height);
    const p = d.data;
    let transparent = false;
    for (let i = 3; i < p.length; i += 4) { if (p[i] < 250) { transparent = true; break; } }
    if (!transparent) {
        for (let i = 0; i < p.length; i += 4) {
            // Rec. 601 luma; white paper -> 0 alpha, full black -> opaque.
            const lum = (p[i] * 0.299 + p[i + 1] * 0.587 + p[i + 2] * 0.114) / 255;
            p[i + 3] = Math.round((1 - lum) * 255);
        }
    }
    // The mask carries shape in ALPHA only, like buildTipMask's output, so
    // tipSprite's source-in tint works on it unchanged.
    for (let i = 0; i < p.length; i += 4) { p[i] = p[i + 1] = p[i + 2] = 255; }
    ctx.putImageData(d, 0, 0);
    return c;
}

// Alpha-weighted principal axis of the inked pixels. Scans arrive at whatever
// angle the mark happened to be made at (the first real set came in between 36
// and 49 degrees), and requiring a consistent hand-alignment would be a rule to
// get wrong for no reason. Measure it and straighten it instead.
function principalAngle(mask) {
    const w = mask.width, h = mask.height;
    const d = mask.getContext('2d').getImageData(0, 0, w, h).data;
    let sum = 0, sx = 0, sy = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const a = d[(y * w + x) * 4 + 3] / 255;
        if (a > 0.03) { sum += a; sx += x * a; sy += y * a; }
    }
    if (!sum) return 0;
    const cx = sx / sum, cy = sy / sum;
    let vxx = 0, vyy = 0, vxy = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const a = d[(y * w + x) * 4 + 3] / 255;
        if (a <= 0.03) continue;
        const dx = x - cx, dy = y - cy;
        vxx += a * dx * dx; vyy += a * dy * dy; vxy += a * dx * dy;
    }
    return 0.5 * Math.atan2(2 * vxy / sum, (vxx - vyy) / sum);
}

// Rotate the mark's long axis to horizontal, which is what the rest of the
// pipeline assumes (aspect, and the angle the stamp is drawn at).
function straightenMask(mask) {
    const theta = principalAngle(mask);
    if (Math.abs(theta) < 0.01) return mask;
    const diag = Math.ceil(Math.hypot(mask.width, mask.height));
    const c = document.createElement('canvas');
    c.width = c.height = diag;
    const ctx = c.getContext('2d');
    ctx.translate(diag / 2, diag / 2);
    ctx.rotate(-theta);
    ctx.drawImage(mask, -mask.width / 2, -mask.height / 2);
    return c;
}

// Crop to the inked bounding box and record the impression's proportions.
// Stroke thickness is the tip's extent ACROSS travel, so that short axis is
// what the size slider has to mean — otherwise how tightly a scan happened to
// be framed would silently rescale the brush (measured: a 26px setting drew an
// 8px line, because the lens filled only 27% of the square across).
function cropMask(mask) {
    const w = mask.width, h = mask.height;
    const d = mask.getContext('2d').getImageData(0, 0, w, h).data;
    let minX = w, maxX = -1, minY = h, maxY = -1;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (d[(y * w + x) * 4 + 3] > 8) {
                if (x < minX) minX = x; if (x > maxX) maxX = x;
                if (y < minY) minY = y; if (y > maxY) maxY = y;
            }
        }
    }
    if (maxX < 0) return null; // blank scan
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const c = document.createElement('canvas');
    c.width = bw; c.height = bh;
    c.getContext('2d').drawImage(mask, minX, minY, bw, bh, 0, 0, bw, bh);
    return { canvas: c, across: bh, along: bw };
}

function loadStampSet(name) {
    if (stampMasks.has(name)) return Promise.resolve(stampMasks.get(name));
    if (stampLoads.has(name)) return stampLoads.get(name);
    const set = STAMP_SETS[name];
    if (!set) return Promise.reject(new Error(`unknown stamp set ${name}`));
    const load = Promise.all(
        Array.from({ length: set.count }, (_, i) => new Promise((res, rej) => {
            const img = new Image();
            img.onload = () => res(straightenMask(maskFromImage(img)));
            img.onerror = () => rej(new Error(`stamp ${name}/${i + 1} failed`));
            img.src = `${set.dir}/${set.prefix || ''}${String(i + 1).padStart(2, '0')}.png`;
        }))
    ).then(raw => {
        // A DRAGGED scan records a contact patch already moved along a path.
        // Stamping it whole makes the engine sweep an already-swept mark: the
        // texture is right, but the mark is longer than a tight curve's radius
        // and juts out of the stroke as darts. `slice` cuts a cross-section out
        // of the middle instead — the bristle pattern ACROSS the tip, which is
        // the actual contact patch. Sweeping a gappy cross-section is what
        // produces lengthwise streaks on real paper, so the dry-brush character
        // comes back out of the mechanism rather than being baked in.
        // Crop FIRST: the slice has to be a fraction of the MARK, not of the
        // canvas it floats in, or it barely narrows anything.
        let cropped = raw.map(cropMask).filter(Boolean);
        if (set.slice) cropped = cropped.map(m => {
            const keep = Math.max(2, Math.round(m.canvas.width * set.slice));
            // Where along the drag to cut. The middle of a stroke is its most
            // solid part, so slicing there returned a clean but characterless
            // tip — all the break-up lives toward the tail, where the ink was
            // giving out. `sliceAt` 0..1 runs start..end of the drag.
            const at = set.sliceAt ?? 0.5;
            const x0 = Math.round((m.canvas.width - keep) * Math.min(1, Math.max(0, at)));
            const c = document.createElement('canvas');
            c.width = keep; c.height = m.canvas.height;
            c.getContext('2d').drawImage(m.canvas, x0, 0, keep, m.canvas.height,
                0, 0, keep, m.canvas.height);
            return cropMask(c);
        }).filter(Boolean);
        if (!cropped.length) throw new Error(`stamp set ${name} is blank`);
        // Normalise the SET by one shared factor, not each impression to a
        // uniform size: one press runs fatter than the next, and flattening
        // that would throw away the very inconsistency these scans are for.
        const meanAcross = cropped.reduce((s, m) => s + m.across, 0) / cropped.length;
        const masks = cropped.map(m => ({
            canvas: m.canvas,
            aspect: m.along / m.across,  // long axis relative to stroke width
            scale: m.across / meanAcross, // this press's own heft, preserved
        }));
        stampMasks.set(name, masks);
        return masks;
    });
    stampLoads.set(name, load);
    return load;
}

// Stamping is synchronous per dab, so a set must be resident BEFORE a stroke
// starts. Callers (tool selection, and remote replay before it feeds ops)
// await this; a preset whose set isn't loaded simply doesn't draw rather than
// falling back to a procedural tip that would look like a different brush.
function stampsReady(presetId) {
    const set = BRUSH_PRESETS[presetId]?.stamps;
    return set ? stampMasks.has(set) : true;
}

function tipSprite(tip, color, w, colorJitter, variantOverride) {
    // Bucketed sprite size: sprites are drawn at the bucket size and
    // drawImage-scaled to the exact stamp width, keeping the cache small.
    const bucket = Math.max(8, Math.pow(2, Math.ceil(Math.log2(w))));
    const variant = variantOverride ?? Math.floor(Math.random() * TIP_VARIANTS);
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

// Tinted, bucketed sprite for one impression of an image stamp set — the
// tipSprite path, but with the mask coming from a scan instead of buildTipMask.
// Tinted sprite for one impression at a bucketed height. The caller decides
// the draw size, so a depletion run can stretch between two impressions'
// proportions without needing a sprite per intermediate size.
function stampSprite(setName, idx, color, dh) {
    const masks = stampMasks.get(setName);
    if (!masks || !masks.length) return null;
    const mask = masks[idx % masks.length];
    const bucketH = Math.max(8, Math.pow(2, Math.ceil(Math.log2(Math.max(1, dh)))));
    const bucketW = Math.max(1, Math.round(bucketH * mask.aspect));
    const key = `stamp:${setName}|${idx % masks.length}|${color}|${bucketH}`;
    let sprite = tipCache.get(key);
    if (!sprite) {
        if (tipCache.size > 64) tipCache.clear();
        const c = document.createElement('canvas');
        c.width = bucketW; c.height = bucketH;
        const ctx = c.getContext('2d');
        ctx.drawImage(mask.canvas, 0, 0, bucketW, bucketH);
        ctx.globalCompositeOperation = 'source-in';
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, bucketW, bucketH);
        sprite = c;
        tipCache.set(key, sprite);
    }
    return sprite;
}

// Per-dab wobble for image stamps, keyed off DISTANCE ALONG THE STROKE rather
// than Math.random(). Two reasons, and the second is the load-bearing one:
// remote peers replaying the same op get identical marks (today's stamp
// randomness is an accepted divergence), and the planned 300 DPI export can
// re-render an op log without the drawing changing under the user. That export
// is blocked on replacing ~59 Math.random() calls; there's no reason to add to
// the pile when a hash of state.dist does the same job. Same reason paperTooth
// and rakeNoise are position-keyed.
function stampHash(x) {
    const s = Math.sin(x * 127.1) * 43758.5453;
    return s - Math.floor(s);
}

// ============================================================================
// BASIC TOOLS (Pen / Brush / Pencil) — shared by both drawing engines
// ============================================================================
// Tuned against a real pen/brush/pencil study (2026-07-21). What that study
// showed, and what these implement:
//
//   BRUSH — speed is the main modulator. A slow stroke is fat and solid; a
//           quick one is thinner AND goes dry, breaking into streaks with a
//           hairline tail. Previously width came from pressure alone, so every
//           brush mark had the same solid body however fast it was drawn.
//   PEN   — very nearly uniform width, but NOT a clean vector line: the real
//           line wavers slightly and skips ink here and there, more so when
//           moving fast. Ours was mathematically perfect, which is most of why
//           it read as digital.
//   PENCIL— light, granular, and registered to the PAPER, with the grain
//           running along the stroke. Ours scattered random dots in a disc,
//           which gives noise rather than tooth and slides with the brush.
//
// Speed is derived from SEGMENT LENGTH rather than timestamps. Pointer samples
// arrive at a roughly fixed rate, so how far the pointer moved between two
// samples is how fast it was going — and unlike a timestamp that survives the
// wire, so a remote replay modulates identically with nothing extra sent.
// Everything else here is keyed off POSITION for the same reason (and so the
// paper texture stays registered to the sheet across strokes).

function strokeSpeed(dist) {
    return Math.min(1, dist / (16 * PAPER_SCALE));
}

// Lays a stroke down as thin lines running ALONG it, spread across its width.
// This is the shape of the whole idea: dry media breaks up longitudinally —
// a fast brush leaves parallel streaks with paper showing between them, and
// graphite catches the tooth in ridges that run with the stroke. Gating whole
// sub-steps on and off instead (the first attempt) can only ever produce
// dashes ACROSS the stroke, which reads as Morse code, not as dry media.
// With spacing below lane width the lanes overlap into a solid mark, so the
// same routine covers "slow and solid" and "fast and streaky" continuously.
function laneStroke(ctx, from, to, halfWidth, laneCount, perLane) {
    const dx = to.x - from.x, dy = to.y - from.y;
    const dist = Math.hypot(dx, dy) || 0.01;
    const nx = -dy / dist, ny = dx / dist;      // across travel
    for (let i = 0; i < laneCount; i++) {
        const off = ((i + 0.5) / laneCount - 0.5) * 2 * halfWidth;
        const ax = from.x + nx * off, ay = from.y + ny * off;
        const bx = to.x + nx * off, by = to.y + ny * off;
        perLane(ax, ay, bx, by, off, (ax + bx) / 2, (ay + by) / 2);
    }
}

// Walks a segment in short sub-steps, calling back with each piece plus the
// position-derived values the basic tools modulate on.
function walkSegment(from, to, stepPx, fn) {
    const dx = to.x - from.x, dy = to.y - from.y;
    const dist = Math.hypot(dx, dy);
    const subs = Math.max(1, Math.ceil(dist / Math.max(0.5, stepPx)));
    for (let s = 0; s < subs; s++) {
        const ta = s / subs, tb = (s + 1) / subs;
        fn(from.x + dx * ta, from.y + dy * ta, from.x + dx * tb, from.y + dy * tb, (ta + tb) / 2);
    }
}

// Pen: essentially a clean line. The study shows a technical pen stays very
// nearly uniform — the only tells are a slight waver in weight and, on quick
// strokes, a marginally lighter/thinner line. Deliberately restrained: an
// earlier attempt at "irregularity" cut the line into beads, which is far
// further from a real pen than the perfectly smooth line it replaced.
function basicPenSegment(ctx, color, from, to, fromWidth, toWidth) {
    const speed = strokeSpeed(Math.hypot(to.x - from.x, to.y - from.y));
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalAlpha = 1 - 0.15 * speed;              // quick strokes bite less
    walkSegment(from, to, 3 * PAPER_SCALE, (ax, ay, bx, by, t) => {
        const wob = 0.94 + 0.12 * paperValueNoise((ax + bx) / 18 + 5.5, (ay + by) / 18 + 5.5);
        ctx.lineWidth = Math.max(0.4, (fromWidth + (toWidth - fromWidth) * t) * wob * (1 - 0.12 * speed));
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
    });
    ctx.restore();
}

// Brush: slow is fat and solid, quick is thinner and goes dry — breaking into
// streaks that run WITH the stroke, exactly as in the study. Lanes overlap at
// low speed so a deliberate mark is still a solid black stroke.
function basicBrushSegment(ctx, color, from, to, fromWidth, toWidth) {
    const speed = strokeSpeed(Math.hypot(to.x - from.x, to.y - from.y));
    const thin = 1 - 0.4 * speed;
    const dryness = Math.max(0, speed - 0.45) / 0.55;   // only really dries out when moving
    const w = ((fromWidth + toWidth) / 2) * thin;
    const half = Math.max(0.3, w / 2);

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (dryness <= 0.01) {                              // solid: one clean stroke
        ctx.lineWidth = Math.max(0.4, w);
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
        ctx.restore();
        return;
    }

    // Sub-step ALONG the stroke as well as across it. Gating a whole lane over
    // a whole segment switches it on and off in slabs — a 20px segment becomes
    // a 20px rectangle, which came out looking like a barcode. Deciding per
    // small piece is what makes the break-up read as fine streaks instead.
    // Capped. Lane count follows stroke width, and a big brush at full
    // pressure on a scaled canvas would otherwise ask for a couple of hundred
    // lanes per sub-step — enough to stall a stroke on an iPad. The cap only
    // binds on very fat marks, where individual streaks aren't resolvable
    // anyway. Comes back out if live rendering ever drops to 1x (see the
    // 300 DPI export plan).
    const lanes = Math.min(40, Math.max(4, Math.round(half * 3)));
    ctx.lineWidth = Math.max(0.5, (half * 2) / lanes * 2.1);
    walkSegment(from, to, 3 * PAPER_SCALE, (ax, ay, bx, by) => {
        laneStroke(ctx, { x: ax, y: ay }, { x: bx, y: by }, half, lanes, (lx, ly, ex, ey, off, mx, my) => {
            // Sampled COARSE along the sheet but decorrelated per lane (the
            // `off` term). Gating on fine paper tooth alone made the mark
            // crumble every few pixels; a real dry brush leaves long parallel
            // streaks, so the gate has to vary slowly along the stroke and
            // sharply across it. Still position-keyed, so repeat passes break
            // in the same places.
            const streak = paperValueNoise(mx / 24 + off * 0.85, my / 24 + off * 0.85);
            if (streak < 0.58 * dryness) return;
            // The heel of the brush holds ink longer than its edges do.
            const edge = 1 - Math.abs(off) / (half + 0.001);
            if (edge < 0.3 * dryness * streak) return;
            ctx.beginPath();
            ctx.moveTo(lx, ly);
            ctx.lineTo(ex, ey);
            ctx.stroke();
        });
    });
    ctx.restore();
}

// Pencil: light, continuous, and registered to the PAPER — graphite catches
// the sheet's high points, so the grain runs along the stroke and a second
// pass darkens the same ridges. The old version scattered random dots in a
// disc, which reads as video noise and slides along with the brush; it was
// also far darker than the reference. Kept continuous on purpose: real pencil
// is faint but unbroken, so tooth modulates DARKNESS here and only drops a
// lane outright where the paper is genuinely low.
function basicPencilSegment(ctx, color, from, to, width) {
    const speed = strokeSpeed(Math.hypot(to.x - from.x, to.y - from.y));
    const r = Math.max(0.6, width) / 2;

    // No lanes. Overlapping translucent lanes double-composite where they
    // overlap, and at a pencil's width those overlaps line up into fine
    // parallel ribs running down the mark. A pencil line is only a few px
    // across anyway, so there's no cross-stroke structure worth resolving —
    // the texture people actually read is density varying ALONG the line.
    //
    // Two passes: a soft wide halo giving the ragged edge, and a narrower core
    // for the body, both shaded by paper tooth so a second pass over the same
    // patch darkens the same grain. BUTT caps so consecutive pieces abut
    // instead of overlapping (round caps double-composite into beads).
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineCap = 'butt';
    // Sub-step well under the paper's ~4px tooth features. At 2px the two
    // beat against each other and shading passes came out looking like
    // brickwork; sampling several times per feature gives a gradient.
    walkSegment(from, to, 1.1 * PAPER_SCALE, (ax, ay, bx, by) => {
        const grit = 0.55 + paperTooth((ax + bx) / 2, (ay + by) / 2) * 0.75;
        const fade = 1 - 0.3 * speed;
        const pass = (widthMul, alpha) => {
            ctx.lineWidth = Math.max(0.4, r * 2 * widthMul);
            ctx.globalAlpha = Math.max(0, Math.min(0.6, alpha));
            ctx.beginPath();
            ctx.moveTo(ax, ay);
            ctx.lineTo(bx, by);
            ctx.stroke();
        };
        pass(1.0, 0.10 * grit * fade);    // soft halo — the ragged edge
        pass(0.55, 0.22 * grit * fade);   // core
    });
    ctx.restore();
}

// ---- Dragged-tip (rake) rendering ----
//
// Stamping a texture repeatedly along a path CANNOT produce a streak, however
// good the texture is: re-printing the same grain at intervals reads as a
// chain of prints, which is the thing that makes digital dry media feel
// digital. A real charcoal stick or dry brush keeps a set of high points in
// contact with the paper and those points RAKE continuous lines, so the grain
// follows the direction of travel and curves with it.
//
// So dry presets don't stamp at all. On stroke start the tip is generated as a
// set of contact points across its width — irregular in position, width and
// darkness, and regenerated per stroke, because a real tip is never twice the
// same. Each point then draws a continuous line along the segment, offset
// perpendicular to travel, so the whole grain pattern drags.
//
// Grit comes from contact points LIFTING: each one is gated by 1D value noise
// along distance travelled, so points drop in and out against the tooth of the
// paper instead of drawing unbroken comb lines.

// ---- Paper tooth ----
//
// The rake gives direction and drag, but on its own it has no notion of the
// PAPER: strokes come out fibrous, long parallel filaments rather than tone
// sitting in a textured surface. Real dry media only touches the high points
// of the sheet, so pigment density is a property of where you are on the page,
// not of the stroke.
//
// This is sampled per contact point per segment, in canvas coordinates, so
// overlapping hatch passes catch the SAME tooth and build up the way charcoal
// actually does. It's procedural rather than the cached noise canvas the wet
// brushes granulate through (paperGrainField) because dry media paints
// straight to the layer for instant feedback — there's no lift-composite to
// mask through, and a per-point function needs no readback.
//
// Sampling per point also happens to decorrelate by construction: the value
// depends on position, and every grain is at a different position, so nothing
// lines up on segment boundaries.
let PAPER_SCALE = 1;   // tracks RENDER_SCALE so tooth is a fixed physical size
function setPaperScale(s) { PAPER_SCALE = s || 1; }

function paperHash2(x, y) {
    const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return s - Math.floor(s);
}
function paperValueNoise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = paperHash2(xi, yi), b = paperHash2(xi + 1, yi);
    const c = paperHash2(xi, yi + 1), d = paperHash2(xi + 1, yi + 1);
    const top = a + (b - a) * u, bot = c + (d - c) * u;
    return top + (bot - top) * v;
}
// Two octaves: a coarse one for the tooth itself, a finer one for the speckle
// that sits inside it. ~4px features at 1x, scaled up at 300 DPI so the paper
// doesn't turn into fine sand when the canvas gets bigger.
function paperTooth(x, y) {
    const s = 4 * PAPER_SCALE;
    const n1 = paperValueNoise(x / s, y / s);
    const n2 = paperValueNoise(x / (s * 0.42) + 31.4, y / (s * 0.42) + 17.2);
    return n1 * 0.68 + n2 * 0.32;
}

function rakeHash(x) {
    const s = Math.sin(x) * 43758.5453;
    return s - Math.floor(s);
}
// Smoothstep-interpolated 1D value noise. Cheap, and it only has to look like
// paper rather than be statistically respectable.
function rakeNoise(seed, t) {
    const i = Math.floor(t), f = t - i;
    const a = rakeHash(seed + i * 12.9898);
    const b = rakeHash(seed + (i + 1) * 12.9898);
    const u = f * f * (3 - 2 * f);
    return a + (b - a) * u;
}

// `width` is the tip's actual width in canvas px for this stroke. Ridge count
// has to follow it: `grains` is tuned for the preset's default size, and at
// writing scale (a 5px tip) that many ridges collapse into an illegible smear
// of sub-pixel lines. Roughly one ridge per 1.1px of tip keeps the texture at
// the same physical density whatever size the brush is set to.
function makeRakeTip(preset, color, width) {
    const target = Math.max(5, Math.min(preset.grains || 22, Math.round((width || 30) / 1.1)));
    const count = Math.max(4, Math.round(target * (0.7 + Math.random() * 0.6)));
    // `w` below is a fraction of tip width, tuned for a full-size tip's ridge
    // count. Scaling the count down for a fine tip without widening each ridge
    // just makes a faint smear — a fine tip's ridges ARE a bigger share of its
    // width. Keeps total coverage roughly constant across sizes.
    const wScale = Math.max(1, Math.min(4, 26 / count));
    // A tip's contact points aren't evenly spread — they clump, which is why a
    // dry stroke has dense passages and bald ones. Bias positions toward a few
    // random clusters rather than sampling the width uniformly.
    const clusters = 2 + Math.floor(Math.random() * 3);
    const centers = [];
    for (let i = 0; i < clusters; i++) centers.push(Math.random() * 2 - 1);

    const grains = [];
    for (let i = 0; i < count; i++) {
        // Roughly a third of the ridges sit in a FRINGE outside the stroke's
        // body. They're lighter and lift far more readily, which is what gives
        // the stroke a dithered falloff at its edges instead of the ruler-
        // straight boundary a uniform spread produces.
        const fringe = Math.random() < 0.34;
        let off;
        if (fringe) {
            off = (0.34 + Math.random() * 0.28) * (Math.random() < 0.5 ? -1 : 1);
        } else {
            const c = centers[Math.floor(Math.random() * clusters)];
            off = Math.max(-1, Math.min(1, c + (Math.random() - 0.5) * 0.8)) * 0.34;
        }
        grains.push({
            off,
            fringe,
            // Kept genuinely THIN. Wide grains drawn over a ~2.5px pointer
            // segment are slabs, and a stroke built from slabs looks like
            // masonry — that was the blockiness. Coverage comes from having
            // many fine ridges instead of a few fat ones.
            w: (0.012 + Math.pow(Math.random(), 2) * 0.05) * wScale,  // fraction of tip width
            a: (0.2 + Math.random() * 0.8) * (fringe ? 0.45 : 1),
            seed: Math.random() * 1000,
            // Clamped so the coarse octave's period stays above ~10px, well
            // clear of the pointer sampling rate (see the aliasing note below).
            freq: Math.min(0.1, (preset.gritScale || 0.09) * (0.5 + Math.random())),
            // Fringe ridges lift much more often, so the outside of a stroke
            // breaks into scattered marks rather than ending on a hard line.
            thresh: Math.min(0.88, (preset.grit ?? 0.3) * (0.6 + Math.random() * 0.8) + (fringe ? 0.3 : 0)),
            wander: 0.01 + Math.random() * 0.04,
            // Pastel's per-stamp colour wobble becomes per-GRAIN here, which is
            // truer anyway: a pastel stick deposits slightly different pigment
            // along each ridge, not a different colour every few pixels.
            color: preset.colorJitter
                ? jitterColor(color, preset.colorJitter, Math.floor(Math.random() * TIP_VARIANTS))
                : color,
        });
    }
    return grains;
}

function rakeAlongSegment(ctx, presetId, color, from, to, fromW, toW, state) {
    const preset = BRUSH_PRESETS[presetId];
    if (!state.grains) {
        state.grains = makeRakeTip(preset, color, Math.max(fromW, toW));
        state.dist = 0;
    }
    const dx = to.x - from.x, dy = to.y - from.y;
    const dist = Math.hypot(dx, dy);

    const tf = taperFactor(state, Math.max(fromW, toW));
    fromW *= tf; toW *= tf;

    // Direction is smoothed exactly as the stamp walker smooths it, so the rake
    // doesn't twitch on noisy pointer samples and swing the whole grain pattern.
    if (dist > 0.5) {
        const dir = Math.atan2(dy, dx);
        if (state.dir === undefined) state.dir = dir;
        else {
            let delta = dir - state.dir;
            while (delta > Math.PI) delta -= Math.PI * 2;
            while (delta < -Math.PI) delta += Math.PI * 2;
            // Snap through genuine corners and reversals instead of easing.
            // Hatching back and forth swings the rake a full 180 degrees, and
            // easing through that leaves it briefly aligned WITH travel, which
            // fans the ridges out into a spray at every turn — the spiky
            // fringes at the ends of hatch strokes.
            state.dir += Math.abs(delta) > 1.2 ? delta : delta * 0.35;
        }
    } else if (state.dir === undefined) {
        state.dir = 0;
    }

    const perp = state.dir + Math.PI / 2;
    const px = Math.cos(perp), py = Math.sin(perp);
    const d0 = state.dist || 0;
    const d1 = d0 + Math.max(dist, 0.35); // a tap still advances the grit phase

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    // BUTT caps + round joins, and — critically — ONE stroke() per ridge per
    // segment rather than one per sub-step. Each ridge draws at alpha < 1, so
    // sub-steps stroked separately double-composite where their caps overlap,
    // laying down a darker mark every 2px along every ridge. Across parallel
    // ridges those line up into rungs across the stroke: the grid/checkerboard
    // that showed up when writing at text size. Stroking one continuous path
    // has no internal overlap at all, and butt ends abut the next segment's
    // cleanly since the offsets match.
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';
    const baseAlpha = preset.stampAlpha ?? 1;
    const tooth = preset.tooth || 0;

    // A tap still has to leave a mark: give a zero-length segment a short
    // smear along the tip so it reads as the stick being set down, not a dot.
    const tap = dist < 0.4;
    const ext = tap ? Math.max(1, (fromW + toW) / 14) : 0;
    const ex = Math.cos(state.dir) * ext, ey = Math.sin(state.dir) * ext;

    // Walk the segment in sub-steps of a fixed PHYSICAL length rather than
    // drawing it in one go. A pointer move is ~3px on the free canvas but ~9px
    // at 300 DPI, so gating grit once per segment produced dashes three times
    // longer there — hard-edged tiles, blocky exactly where paying subscribers
    // draw. Stepping at 2px * scale keeps grit the same size on the page at
    // any resolution, and costs draw calls only in proportion to the canvas.
    const step = 2 * PAPER_SCALE;
    const subs = tap ? 1 : Math.max(1, Math.ceil(dist / step));

    for (const g of state.grains) {
        // Width is per GRAIN, not per sub-step. Any attribute constant across a
        // drawn piece steps at its boundary, and every grain shares those
        // boundaries, so the steps line up into hard vertical edges across the
        // stroke — that was the corduroy. Same reason alpha carries no
        // per-piece modulation: tonal variety comes from grains differing and
        // from the paper, both decorrelated, neither periodic.
        ctx.strokeStyle = g.color;
        ctx.lineWidth = Math.max(0.6, g.w * (fromW + toW) / 2);
        ctx.globalAlpha = Math.min(1, g.a * baseAlpha);
        ctx.beginPath();
        let open = false, drew = false;

        for (let s = 0; s < subs; s++) {
            const ta = s / subs, tb = (s + 1) / subs;
            const da = d0 + (d1 - d0) * ta, db = d0 + (d1 - d0) * tb;

            const wa = fromW + (toW - fromW) * ta, wb = fromW + (toW - fromW) * tb;
            const oa = (g.off + Math.sin(da * g.wander + g.seed) * 0.04) * wa;
            const ob = (g.off + Math.sin(db * g.wander + g.seed) * 0.04) * wb;

            const ax = from.x + dx * ta + px * oa, ay = from.y + dy * ta + py * oa;
            const bx = from.x + dx * tb + px * ob, by = from.y + dy * tb + py * ob;

            // Both grit and paper tooth are pure GATES now — they decide
            // whether this ridge is touching here, not how dark it is. Alpha
            // has to stay constant across the path for it to be one stroke(),
            // and gating is the truer model anyway: a ridge either reaches the
            // paper or skips over a hollow. Tone still varies, via the grains
            // themselves differing and via where the gaps land.
            const lifted = rakeNoise(g.seed, db * g.freq) < g.thresh;
            const inHollow = tooth && paperTooth((ax + bx) / 2, (ay + by) / 2) < tooth * 0.42;

            if (lifted || inHollow) { open = false; continue; }
            if (!open) { ctx.moveTo(ax - ex, ay - ey); open = true; }
            ctx.lineTo(bx + ex, by + ey);
            drew = true;
        }
        if (drew) ctx.stroke();
    }
    ctx.restore();
    state.dist = d1;
}

// ---- Broad / chisel nib ----
//
// A real chisel nib is an EDGE of fixed length held at a fixed angle to the
// page. Sweeping that edge along a path traces a quadrilateral per segment,
// and the thick/thin modulation every calligrapher relies on falls out of the
// geometry for free: travel perpendicular to the edge shows its full width,
// travel along it collapses to a hairline. There's no width formula here on
// purpose — formulas produce the "blobby marker" look this replaced.
function nibAlongSegment(ctx, presetId, color, from, to, fromW, toW, state) {
    const preset = BRUSH_PRESETS[presetId];
    const ang = preset.nibAngle ?? -0.7;
    // Half-edge vector. fromW/toW carry pressure, so bearing down widens the
    // nib a little the way a flexible nib spreads.
    const ex0 = Math.cos(ang) * fromW / 2, ey0 = Math.sin(ang) * fromW / 2;
    const ex1 = Math.cos(ang) * toW / 2,   ey1 = Math.sin(ang) * toW / 2;

    // Each segment is its own quad, and abutting quads leave an antialiased
    // seam every few pixels — which reads as a serrated, hatched edge. Extend
    // both ends a half pixel along travel so consecutive quads overlap. Ink is
    // opaque, so painting the overlap twice is invisible.
    const sx = to.x - from.x, sy = to.y - from.y;
    const slen = Math.hypot(sx, sy) || 1;
    const bx = (sx / slen) * 0.5, by = (sy / slen) * 0.5;

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(from.x + ex0 - bx, from.y + ey0 - by);
    ctx.lineTo(to.x + ex1 + bx, to.y + ey1 + by);
    ctx.lineTo(to.x - ex1 + bx, to.y - ey1 + by);
    ctx.lineTo(from.x - ex0 - bx, from.y - ey0 - by);
    ctx.closePath();
    ctx.fill();

    // A tap should still register as the nib being set down.
    if (Math.hypot(to.x - from.x, to.y - from.y) < 0.4) {
        ctx.lineWidth = Math.max(0.6, fromW * 0.12);
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo(from.x + ex0, from.y + ey0);
        ctx.lineTo(from.x - ex0, from.y - ey0);
        ctx.stroke();
    }
    ctx.restore();
    state.residual = 0;
}

// Entry taper. Real media doesn't arrive at full width — the tip lands and
// loads over the first few millimetres. Without this every preset mark starts
// with a blunt, machine-cut end, which is a big part of why they read as
// uniform sausages next to the legacy Brush tool (which has always tapered).
// Driven by distance travelled, so it's identical on remote replay and needs
// nothing on the wire. Taper-OUT would need lift lookahead the dry engines
// don't have — see BRUSH_ENGINE_PLAN.md.
function taperFactor(state, w) {
    const len = Math.max(5, w * 1.6);
    return Math.min(1, 0.3 + 0.7 * ((state.dist || 0) / len));
}

// ---- The one shared stroke primitive ----
// Walks a segment stamping every (spacing x width), carrying leftover
// distance in state.residual so stamp cadence is seamless across the
// segment boundaries of a polyline. state = { residual, dir } per stroke.
function stampAlongSegment(ctx, presetId, color, from, to, fromW, toW, state) {
    const preset = BRUSH_PRESETS[presetId];
    // Dry media drags its tip instead of stamping. Dispatching here rather than
    // at the call sites means both engines, Open Canvas remote replay and the
    // swatch harness all pick it up for free.
    if (preset.rake) return rakeAlongSegment(ctx, presetId, color, from, to, fromW, toW, state);
    if (preset.nib) return nibAlongSegment(ctx, presetId, color, from, to, fromW, toW, state);
    // Stamped (wet) presets track distance too, purely so they can taper in.
    const tf = taperFactor(state, Math.max(fromW, toW));
    fromW *= tf; toW *= tf;
    state.dist = (state.dist || 0) + Math.hypot(to.x - from.x, to.y - from.y);
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
    const stampAt = (x, y, w, at) => {
        // Image-stamp presets: pick the impression and its wobble from distance
        // along the stroke, so the mark is reproducible (see stampHash).
        if (preset.stamps) {
            const h1 = stampHash(at), h2 = stampHash(at + 7.77), h3 = stampHash(at + 19.3);
            const masks = stampMasks.get(preset.stamps);
            if (!masks || !masks.length) return; // not resident; see stampsReady
            // Advance the impression roughly once per tip-width travelled, not
            // per dab: at spacing 0.16 a new scan every dab would churn six
            // impressions inside one tip width and read as noise.
            // Two ways to choose the impression. A `deplete` set is an ORDERED
            // run of one brush emptying out — file 01 is the driest, the last
            // is fully loaded — so it's indexed by distance travelled: the
            // stroke starts loaded and runs dry over `deplete` px, exactly the
            // way the real brush does. Sets without it are interchangeable
            // impressions and just cycle, advancing about once per tip width
            // (per dab would churn several inside one width and read as noise).
            let idx, scale, aspect;
            if (preset.deplete) {
                const t = Math.min(1, at / preset.deplete);
                const f = (1 - t) * (masks.length - 1);
                const i0 = Math.max(0, Math.floor(f));
                const i1 = Math.min(masks.length - 1, i0 + 1);
                const fr = f - i0;
                idx = Math.round(f);
                // The impressions differ a lot in heft, so switching outright
                // stepped the line width visibly partway along the stroke.
                // Snapping the TEXTURE but interpolating the PROPORTIONS gets a
                // smooth dry-out for one stamp per dab: a texture swap is far
                // harder to see than a width jump.
                scale = masks[i0].scale + (masks[i1].scale - masks[i0].scale) * fr;
                aspect = masks[i0].aspect + (masks[i1].aspect - masks[i0].aspect) * fr;
            } else {
                idx = Math.floor(at / Math.max(1, w)) % masks.length;
                scale = masks[idx].scale;
                aspect = masks[idx].aspect;
            }
            // Normalise on the extent the tip PROJECTS across the stroke at its
            // nominal hold, not on its narrow axis: held at 40deg a 3:1 tip
            // spans ~2.8x its width, so sizing by the narrow axis made a 26px
            // setting draw an 86px line (measured). Sizing on the projection
            // makes `size` mean stroke width again, and the mark still thins
            // and thickens around it as the direction turns under the tip.
            const a0 = preset.stampAngle ?? 0;
            const proj = aspect * Math.abs(Math.sin(a0)) + Math.abs(Math.cos(a0));
            const across = w / Math.max(0.2, proj) * (1 + (h1 - 0.5) * 2 * (preset.sizeJitter ?? 0));
            const dh = Math.max(1, across * scale);
            const dw = Math.max(1, dh * aspect);
            const sprite = stampSprite(preset.stamps, idx, color, dh);
            if (!sprite) return;
            const off = (h2 - 0.5) * 2 * (preset.offsetJitter ?? 0) * w;
            // A brush held in the hand doesn't swivel to follow the line —
            // that's WHY the mark goes thick and thin: the tip stays put while
            // the direction changes under it (same reason the Chisel Nib fixes
            // nibAngle in page space). Following fully gives a constant-width
            // sausage. `stampFollow` is how much of the travel direction leaks
            // in; a little keeps corners from looking pasted on.
            const follow = preset.stampFollow ?? 0;
            const rot = (preset.stampAngle ?? 0)
                + follow * (state.dir ?? 0)
                + (h3 - 0.5) * 2 * (preset.angleJitter ?? 0);
            ctx.globalCompositeOperation = 'source-over';
            // Optional paper tooth, sampled per dab in CANVAS coordinates so it
            // stays registered to the paper rather than sliding with the brush.
            // CAVEAT, measured 2026-07-22: this only reads as texture when dabs
            // DON'T heavily overlap. On the dry brush (4px spacing under a 26px
            // tip, so ~6 dabs per pixel) the per-dab values averaged out and it
            // acted as a uniform dimmer — coverage moved under 3% while mean
            // alpha fell from 150 to 114. Texture finer than a dab has to be
            // knocked out of the finished stroke, the way compositeWetStroke
            // does granulation, not modulated per dab.
            let alpha = preset.stampAlpha ?? 1;
            if (preset.tooth) alpha *= 1 - preset.tooth * (1 - paperTooth(x, y));
            ctx.globalAlpha = alpha;
            ctx.save();
            ctx.translate(x, y);
            ctx.rotate(rot);
            ctx.drawImage(sprite, -dw / 2, -dh / 2 + off, dw, dh);
            ctx.restore();
            ctx.globalAlpha = 1;
            return;
        }
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

    // state.dist was already advanced past this segment above, so the distance
    // at the segment's START is what indexes each dab's wobble.
    const base = (state.dist || 0) - dist;
    if (dist < 0.02) { // the "dot on tap" stamp at stroke start
        stampAt(from.x, from.y, Math.max(1, fromW), base);
        state.residual = 0;
        return;
    }
    // `spacing` is a fraction of the tip's WIDTH, which is the right unit for a
    // contact patch. For a dragged mark it isn't: these run 5-6x longer than
    // they are wide, so a 0.55 width-spacing laid them down every tenth of
    // their own length — ~10x overlap, which is what grew the barbed comb
    // artifacts where strokes crossed. `spaceAlong` reads spacing as a fraction
    // of the mark's LENGTH instead.
    let spaceScale = 1;
    if (preset.stamps && preset.spaceAlong) {
        const sm = stampMasks.get(preset.stamps);
        if (sm && sm.length) spaceScale = sm.reduce((s, m) => s + m.aspect, 0) / sm.length;
    }
    const step = Math.max(1, preset.spacing * spaceScale * Math.max((fromW + toW) / 2, 2));
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
        // Image stamps take their scatter from the same distance-keyed hash as
        // the rest of their wobble, so the whole dab is reproducible.
        const sx = preset.stamps ? (stampHash(base + pos + 3.1) - 0.5) * 2 : (Math.random() - 0.5) * 2;
        const sy = preset.stamps ? (stampHash(base + pos + 11.7) - 0.5) * 2 : (Math.random() - 0.5) * 2;
        stampAt(
            from.x + dx * t + sx * jitter,
            from.y + dy * t + sy * jitter,
            w,
            base + pos
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
