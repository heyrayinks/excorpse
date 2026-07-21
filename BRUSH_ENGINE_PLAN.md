# Brush Engine — architecture notes & recipe for future brush drops

Status as of 2026-07-19: **SHIPPED** — the parametric stamp engine plus 15
subscriber brushes across four families (Ink 3, Watercolor 4, Charcoal 4,
Pastel 4) are live. This doc is the map for adding more brushes (the whole
point of the $2.99/mo subscription: new brushes as they release) and for the
bigger lifts that were deliberately deferred.

## Swatch harness (added 2026-07-21) — look before you tune

    node dev/swatch-server.js
    -> http://localhost:4600/dev/brush-swatches.html

Renders every brush through an identical battery of six test strokes
(pressure taper / filled area / two strokes crossing / fast light flick /
single dab / full-pressure edge) and writes one PNG per family to
`dev/out/`. Parameter tuning was previously done blind — screenshots are
unreliable in the automated browser pane, so brushes were verified by
counting pixel alpha, which proves paint landed but says nothing about
whether it looks like the medium. Open the sheets side by side with a
reference scan instead.

The harness renders from `/brush-engine.js`, the SAME file the app loads —
a swatch sheet that could drift from what players get would be worse than
none. Only the input is synthesised (a path plus a pressure profile per
test); every mark is made by production stamping code. The ink tools'
drivers are reconstructed in the harness since their handlers live inside
`setupCanvas` closures, but they call the real `inkStamp*` functions.

## Where everything lives

**`brush-engine.js`** (extracted from `index.html` 2026-07-21, loaded as a
classic `<script src>` before the main one so its top-level consts stay
visible exactly as when inline) holds the ink stamps and the whole
parametric engine. `FAMILY_ICONS` and the `TOOL_META` registration loop
stayed in `index.html` — they depend on app state, not engine state.
Everything else below is still in `index.html`.

- **`BRUSH_PRESETS`** — the data table. One row per brush: `family`, `label`,
  `tip`, `spacing` (fraction of width between stamps), `opacity` (wet
  composite alpha), `stampAlpha` (per-stamp alpha for dry media), `wet`
  (buffer + multiply composite on lift), `sizeRange`/`size`, `pressureSize`,
  `scatter`, `angle` (`'none' | 'follow'`), `colorJitter` (per-variant HSL
  nudge). **A new brush that reuses an existing tip is ONE new row + nothing
  else** — menu, sizes, slider, gating, and Open Canvas sync all derive.
- **`buildTipMask(tip, s)`** — procedural tip shapes (alpha masks): `wetDisc`,
  `softDisc`, `granDisc`, `toothCoarse`, `toothSoft`, `toothFine`,
  `flatStick` (long-axis vertical → `angle:'follow'` drags it perpendicular),
  `pastelTip`, `pastelHeavy` (grooves rotate along the stroke),
  `pastelScumble`. New texture = new case here.
- **`tipSprite(tip, color, w, colorJitter)`** — bucketed, tinted, cached
  (`TIP_VARIANTS` pre-baked randomizations; cache cap 64, clear-all on
  overflow). All stamping is `drawImage` of these sprites — never per-stamp
  path drawing (perf on iPad at the 2550×3300 logged-in canvas).
- **`stampAlongSegment(ctx, presetId, color, from, to, fromW, toW, state)`**
  — the one shared stroke walker (residual-carry cadence, smoothed direction
  for rotated tips). Used by BOTH engines and by remote replay.
- **Wet compositing** — per-engine lazy full-size buffer + overlay preview
  canvas; on lift the stroke goes through the shared
  `compositeWetStroke()` (all three call sites — both engines and the Open
  Canvas remote-replay path — route through it). That applies, in order:
  the wash itself (`multiply` at `preset.opacity`, so overlapping washes
  genuinely darken), the **dried edge rim**, and **granulation**.
  Open Canvas remotes use pooled per-player-order buffers
  (`ocWetBuffers`) composited on the sender's `up` op — remote wet strokes
  appear on lift, by design.
- **Rim and granulation are composite-time, NOT tip-time** (reworked
  2026-07-21). Both are properties of the whole dried shape, and baking
  them into the tip was the single biggest thing making watercolor look
  fake: a rim on every stamp turned strokes into visible chains of
  circles, and tip-carved grain slid along with the brush instead of
  staying registered to the paper. The rim band is `A * (1 - blur(A))`,
  computed with one `destination-out` drawImage; `blurredAlpha()` prefers
  the native canvas filter and falls back to *staged* halving (a single
  big downscale quantises to a grid and yields a rim on one side of a
  stroke only — measured). Granulation knocks holes in a copy of the
  stroke using `paperGrainField()`, a cached canvas-sized noise field
  addressed in canvas coordinates, so two strokes crossing the same patch
  of paper settle into the same hollows.
- **Wet tips are flat-topped on purpose** — their only job is to build an
  even field of alpha for the composite to shape. Don't add edge rings.
- **Menu** — `toolMenuHtml()` groups by `family` with section headers
  (headers omitted when only Basics is visible). Clicks are DELEGATED on
  `#toolMenu`; `refreshToolMenu()` rebuilds it in place when the async
  `/account/me` fetch lands after a draw screen rendered (race fixed
  2026-07-19 — don't regress to per-item listeners).
- **Wire protocol** — preset strokes ride the existing `stroke` ops
  (`tool` = preset id, widths in points); stamp randomness re-rolls per
  client (accepted airbrush-precedent divergence). Ink brushes use the
  `stamp` op type (whitelisted in `server.js` ws handler). **No server
  changes are needed for new preset brushes.**

## Recipe: shipping a new brush (the monthly-drop workflow)

1. Add a `BRUSH_PRESETS` row (new tip case in `buildTipMask` only if no
   existing texture fits). `subscriberOnly` gating is automatic.
2. If it's a new family: add to `TOOL_FAMILY_ORDER` + `FAMILY_ICONS` + a
   234-viewBox `#888`/`#d7d7d7` SVG in `graphics/`.
3. Verify with the established browser-pane recipe (screenshots are
   unreliable in the automated pane — use pixel sampling):
   patch `requestAnimationFrame`→setTimeout, patch
   `PointerEvent.prototype.getCoalescedEvents` to `return [this]`, dispatch
   with `pointerId: 1`; beta-signup (`betaCode` env) grants `subscribed`.
   Draw → `getImageData` alpha counts; wet brushes → crossing strokes,
   assert intersection alpha > single-stroke alpha; Open Canvas → draw,
   reload, assert history replay repaints (proves server round-trip).
   Delete test accounts via `DELETE /api/account/me` when done.
4. Update the Brush Subscription card copy (count/families) on the account
   page. Commit per family, push (Railway auto-deploys; in-progress games
   now survive graceful deploys via the SIGTERM snapshot in `server.js`).

## Planned: 300 DPI export (record → simulate → render on demand)

**Status: specced, not started (2026-07-21).** Resolution currently sits at
200 DPI for logged-in users (`PAID_RENDER_SCALE`) and 200 DPI for everything
stored (`OUTPUT_SCALE`), which are now independent knobs. The idea here is to
stop carrying print resolution live and instead generate it at export time,
making 300 DPI a subscriber perk that costs nothing while drawing.

### Why

The live canvas pays for print resolution on every stroke, every flood fill,
every wet buffer, on every device. Rendering on demand instead means the live
canvas can sit at 100–200 DPI while exports go as high as we like — and brush
quality stops being negotiated against the frame budget (the lane caps in
`basicBrushSegment` / `basicPencilSegment` exist purely for that reason and
would come straight back out).

### The blocker that must land FIRST: determinism

There are ~59 `Math.random()` calls in `brush-engine.js` and ~47 more in
`index.html`'s drawing code. Today that's harmless — pixels are the source of
truth. The moment an export re-renders from an op log, every one of them
re-rolls and **the downloaded file is not the drawing the user made**:
different grain, different splatter, different dry-brush break-up. That is
strictly worse than a slow canvas, so it cannot ship second.

Replace them with a small seeded PRNG keyed off each stroke's id (Open Canvas
ops already carry a `sid`; see `ocSend`) plus a per-call counter. Everything
that's already position-keyed (`paperTooth`, `paperValueNoise`, the rake's
`rakeNoise`) is deterministic and needs no change — that's most of the texture.

Bonus: this also fixes the existing accepted divergence where remote peers see
different random details than the person drawing.

### What already exists

Open Canvas has ~90% of the machinery: every op is persisted to `game.strokes`
server-side, and `applyRemoteDrawOp` already rebuilds a whole canvas from that
log (used by late-joiner sync AND the timelapse replay, which points `ocCtxs`
at offscreen canvases and feeds ops through the same renderer). An export is
that same replay, run at a different scale, into a bigger buffer.

**Round modes record nothing** — no op log outside the OC engine. That's the
bulk of the remaining work.

### Sequence

1. **Seeded PRNG** replacing `Math.random()` in the drawing path. Verify: draw
   a stroke, re-render the same ops, assert pixel-identical output.
2. **Scale-parameterised replay.** `applyRemoteDrawOp` and the replay harness
   assume base resolution (`CANVAS_W = BASE_CANVAS_W` before playback).
   Multiply op coordinates and widths by a target scale, and call
   `setPaperScale()` to match so paper tooth stays a fixed physical size.
   Verify: a 1x re-render is pixel-identical to the live canvas.
3. **300 DPI export for Open Canvas** — gate on `subscribed`, re-render the log
   at scale 3 on download. Needs a progress state: a dense drawing at 8.4M px
   is not an instant save. Note `fill` is pixel-based (BFS over the whole
   canvas) and must replay in order; it's the expensive op at scale.
4. **Op capture for round modes**, mirroring the OC op shapes, then the same
   export path. Undo can then pop ops instead of storing PNG snapshots.
5. **Drop the live canvas** to 100 DPI once exports are decoupled, and remove
   the lane caps.

### Watch out for

- `OUTPUT_W/H` must stay a single uniform size — a round-based creation
  stitches three sections from three different artists into one image.
  Per-tier *stored* resolution is not possible; per-tier *export* is the whole
  point of this design.
- `stitchSheetDataUrl` draws each section into the frame with an explicit
  destination size, so images stored at the old 300 DPI still composite fine
  alongside 200 DPI ones. Don't "fix" that by assuming source dimensions.
- iOS Safari has a canvas allocation ceiling (~16.7M px on many devices). A
  3-panel combine at full export width already had to be capped for this
  reason — see `combineCompositesRaw`.

## Licensing guardrails (researched 2026-07-19)

- Krita's brush ENGINES are GPL C++ — never port their code into this app.
- Krita preset packs: David Revoy's are CC-BY 4.0 (2025-01 bundle and the
  taro-0 GitHub mirror are CC0). MyPaint `.myb` settings are public-domain
  by project policy; libmypaint is ISC. Using these as *visual/parameter
  reference* for original code (what we did) is unambiguously fine; copying
  actual `.kpp`/`.myb` files or tip PNGs into the repo would need
  license/attribution review first.

## Deferred (future sessions)

- **Smudge / blender brush** — real pixel-sampling paint mixing ("oil/
  acrylic-tier"). Needs per-stamp `getImageData` reads; prototype at Open
  Canvas resolution (850×1100) first, gate behind perf testing at 300 DPI.
- **Per-point pressure→opacity on the wire** — dry-media alpha dynamics are
  currently local-only (remote uses the preset default). If divergence ever
  bothers anyone, add an `a` field to stroke points.
- **Wet-preview blit cost on iPad** — the overlay preview redraws per event
  batch; if real-device testing shows stutter, fall back to composite-on-
  lift only (stroke invisible until lift, like some real watercolor apps).
- **More tips**: bristle rake, sponge, salt-texture watercolor, paper-grain
  shared noise tile (one tile reused across tips instead of per-tip dots).
