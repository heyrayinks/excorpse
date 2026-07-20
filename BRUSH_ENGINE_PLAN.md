# Brush Engine — architecture notes & recipe for future brush drops

Status as of 2026-07-19: **SHIPPED** — the parametric stamp engine plus 15
subscriber brushes across four families (Ink 3, Watercolor 4, Charcoal 4,
Pastel 4) are live. This doc is the map for adding more brushes (the whole
point of the $2.99/mo subscription: new brushes as they release) and for the
bigger lifts that were deliberately deferred.

## Where everything lives (all in `index.html` unless noted)

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
  canvas; stroke composites onto the layer once on lift with
  `multiply` at `preset.opacity` (overlapping washes genuinely darken).
  Open Canvas remotes use pooled per-player-order buffers
  (`ocWetBuffers`) composited on the sender's `up` op — remote wet strokes
  appear on lift, by design.
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
