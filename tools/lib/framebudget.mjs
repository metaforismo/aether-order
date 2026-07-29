/**
 * The chamber's per-frame GPU budget, computed rather than asserted.
 *
 * Round 2 of this specification published a pass table computed in CSS-logical
 * pixels and concluded "= 20.6 Mfrag/s at 60 fps". GPUs shade device pixels.
 * The three named reference devices run at device-pixel ratios of 2, 2.6 and
 * ~2.75, so the real load was between four and nine times the published figure.
 * The conclusion survived — the arithmetic was never the constraint — but a
 * table offered as the proof that a premium look is affordable without a fluid
 * solver cannot be understated by an order of magnitude in a repository whose
 * whole claim is that it states its arithmetic.
 *
 * So the table is generated here, at a stated DPR, and docs/DESIGN.md §7.1
 * quotes this module. `tests/framebudget.test.mjs` fails the build if the
 * document and the module disagree, exactly as `tests/paytable.test.mjs` does
 * for the paytable.
 *
 * The mitigation is also a decision, not an implementation detail: the WebGL
 * backing store is capped at DPR 2 even on a DPR 3 panel. That is a visual
 * quality choice about the chamber, so it belongs in the art direction (§6.2)
 * and is stated there. Text, the slot rings and the 1 px specular line are DOM
 * and SVG, drawn at native DPR, so nothing with a hard edge is resampled.
 */

/** The chamber rect in CSS pixels on the 390 x 844 reference viewport. */
export const CHAMBER_CSS = Object.freeze({ width: 390, height: 430 });

/** The whole reference viewport. The chrome layer is this big; the canvas is not. */
export const VIEWPORT_CSS = Object.freeze({ width: 390, height: 844 });

/** Sphere diameter in CSS pixels: the tube is 96 wide with 78-tall slots. */
export const SPHERE_DIAMETER_CSS = 64;

/**
 * The chamber's WebGL backing store never exceeds this many device pixels per
 * CSS pixel, whatever the panel reports. See §6.2: the chamber's content is
 * low-frequency by construction (gradients, bloom, one sprite master), so the
 * cap is invisible on it, and every high-frequency element is drawn outside it.
 */
export const BACKING_STORE_DPR_CAP = 2;

/** 4 bytes per pixel: RGBA8 render targets throughout. No float targets. */
export const BYTES_PER_PIXEL = 4;

export const REFERENCE_DEVICES = Object.freeze([
  Object.freeze({ id: 'iphone-se-2', name: 'iPhone SE (2nd gen)', devicePixelRatio: 2, gpu: 'Apple A13' }),
  Object.freeze({ id: 'pixel-6a', name: 'Pixel 6a', devicePixelRatio: 2.6, gpu: 'Mali-G78 MP20' }),
  Object.freeze({ id: 'galaxy-a54', name: 'Galaxy A54', devicePixelRatio: 2.75, gpu: 'Mali-G68 MP5' }),
]);

/**
 * The five passes, as linear scale factors on the backing store, with the
 * texture taps each fragment costs. `spriteShaded` marks the one pass that
 * shades sprites rather than a full-screen quad.
 */
export const PASSES = Object.freeze([
  Object.freeze({
    id: 1,
    name: 'Sphere layer → offscreen RT',
    scale: 0.5,
    spriteShaded: true,
    tapsPerFragment: 2,
    note: 'one 256 x 256 master, tinted per element; the refraction source only needs low frequency',
  }),
  Object.freeze({
    id: 2,
    name: 'Fluid: caustics + refraction + depth',
    scale: 0.75,
    spriteShaded: false,
    tapsPerFragment: 2,
    note: 'samples pass 1 with a refraction offset',
  }),
  Object.freeze({
    id: 3,
    name: 'Bright-pass + downsample',
    scale: 0.25,
    spriteShaded: false,
    tapsPerFragment: 1,
    note: 'bloom threshold 0.78',
  }),
  Object.freeze({
    id: 4,
    name: 'Two separable blurs',
    scale: 0.25,
    spriteShaded: false,
    passes: 2,
    tapsPerFragment: 9,
    note: '9-tap Gaussian each direction, 12 px radius at 390 px width',
  }),
  Object.freeze({
    id: 5,
    name: 'Composite: fluid + bloom add',
    scale: 1,
    spriteShaded: false,
    tapsPerFragment: 2,
    note: 'the only full-resolution pass; UI chrome is DOM, not this canvas',
  }),
]);

export const SPHERE_COUNT = Object.freeze({ classic: 5, seven: 7 });

/**
 * Compute the whole budget for one configuration.
 *
 * @param {object} options
 * @param {number} options.widthCss chamber width in CSS pixels
 * @param {number} options.heightCss chamber height in CSS pixels
 * @param {number} options.devicePixelRatio the panel's ratio
 * @param {number|null} options.dprCap the backing-store cap, or null for none
 * @param {number} options.spheres how many sprites are shaded
 * @param {number} options.fps the frame rate the totals are quoted at
 */
export function frameBudget({
  widthCss = CHAMBER_CSS.width,
  heightCss = CHAMBER_CSS.height,
  devicePixelRatio,
  dprCap = BACKING_STORE_DPR_CAP,
  spheres = SPHERE_COUNT.seven,
  spriteDiameterCss = SPHERE_DIAMETER_CSS,
  fps = 60,
} = {}) {
  if (!(devicePixelRatio > 0)) throw new RangeError('frameBudget requires a positive devicePixelRatio');
  const effectiveDpr = dprCap === null ? devicePixelRatio : Math.min(devicePixelRatio, dprCap);
  const width = Math.round(widthCss * effectiveDpr);
  const height = Math.round(heightCss * effectiveDpr);
  const backingPixels = width * height;

  const rows = PASSES.map((pass) => {
    const passWidth = Math.round(width * pass.scale);
    const passHeight = Math.round(height * pass.scale);
    const target = passWidth * passHeight;
    const repeats = pass.passes ?? 1;
    const spriteEdge = Math.round(spriteDiameterCss * effectiveDpr * pass.scale);
    const shaded = pass.spriteShaded ? spheres * spriteEdge * spriteEdge : target * repeats;
    const cleared = pass.spriteShaded ? target : 0;
    const writes = (shaded + cleared) * BYTES_PER_PIXEL;
    const reads = shaded * pass.tapsPerFragment * BYTES_PER_PIXEL;
    return Object.freeze({
      id: pass.id,
      name: pass.name,
      scale: pass.scale,
      resolution: `${passWidth} × ${passHeight}`,
      targetPixels: target,
      shadedFragments: shaded,
      clearedFragments: cleared,
      writeBytes: writes,
      readBytes: reads,
      note: pass.note,
    });
  });

  const shadedFragments = rows.reduce((sum, row) => sum + row.shadedFragments, 0);
  const clearedFragments = rows.reduce((sum, row) => sum + row.clearedFragments, 0);
  const writeBytes = rows.reduce((sum, row) => sum + row.writeBytes, 0);
  const readBytes = rows.reduce((sum, row) => sum + row.readBytes, 0);

  return Object.freeze({
    devicePixelRatio,
    effectiveDpr,
    capped: effectiveDpr < devicePixelRatio,
    backing: `${width} × ${height}`,
    backingPixels,
    rows: Object.freeze(rows),
    shadedFragments,
    clearedFragments,
    writeBytes,
    readBytes,
    trafficBytes: writeBytes + readBytes,
    fps,
    megafragmentsPerSecond: (shadedFragments * fps) / 1e6,
    writeMegabytesPerSecond: (writeBytes * fps) / 1e6,
    readMegabytesPerSecond: (readBytes * fps) / 1e6,
    trafficMegabytesPerSecond: ((writeBytes + readBytes) * fps) / 1e6,
  });
}

/* ==================================================================== *
 * The other half of the frame: the DOM/SVG chrome layer.                *
 *                                                                       *
 * The pass table above budgets the WebGL canvas and nothing else, and    *
 * §6.2 deliberately moves every hard edge OUT of that canvas: all text,  *
 * the slot rings, the tube outline and the 1 px specular line are DOM    *
 * and SVG at native DPR, because the backing store is capped at DPR 2.   *
 * §6.4 then animates exactly that layer throughout SETTLE — a gold ring  *
 * lock per slot with a 90 ms rebound, a 2 px chamber flex, and per-line  *
 * state changes at 120 ms.                                              *
 *                                                                       *
 * So the published budget proved the cheap half and was silent on the    *
 * expensive one. On a Galaxy A54 the chrome layer is ~1073 x 2321 device *
 * pixels, composited every frame beside the canvas, and it appeared in   *
 * no table in the document. Concurrent SVG animation plus a WebGL canvas *
 * is the standard 60 fps failure on this exact device class, and it is   *
 * the binding cost here — not fill rate.                                 *
 *                                                                       *
 * Two things are modelled below, because they fail for different         *
 * reasons:                                                               *
 *                                                                       *
 *   1. COMPOSITE. The system compositor blends the chrome layer and the  *
 *      upscaled canvas into the framebuffer at NATIVE dpr, every frame,  *
 *      whether anything moved or not. It is pure bandwidth and it is     *
 *      unavoidable; it is also, once counted, affordable.                *
 *   2. RASTER. If an animation touches any property that invalidates a   *
 *      layer's raster — stroke geometry, filters, layout — the layer is  *
 *      re-rasterised and re-uploaded every frame. THIS is what kills the *
 *      frame rate, it is not visible in a fragment count, and it is      *
 *      avoidable by rule: during SETTLE the chrome layer animates        *
 *      `transform` and `opacity` only, on pre-promoted layers.           *
 *                                                                       *
 * `naiveRasterPixelsPerFrame` is the counterfactual that rule buys back. *
 * ==================================================================== */

/**
 * Chrome geometry in CSS pixels. docs/DESIGN.md §5 S1, §5 S4 and §6.9 declare
 * these.
 *
 * `tube.height` is the CLASSIC chamber column; SEVEN's chamber crops 40 px
 * tighter (§12), and `SPHERE_DIAMETER_CSS` is likewise CLASSIC's 64 where
 * SEVEN's is 44. Both are deliberately left at the larger value, so every
 * figure this module publishes is an **upper bound over both variants**. A
 * budget that has to be recomputed per variant is a budget somebody will quote
 * the wrong half of.
 */
export const CHROME_CSS = Object.freeze({
  /** The tube outline group: the 2 px chamber flex transforms this. */
  tube: Object.freeze({ width: 96, height: 430 }),
  /** One slot's ring bounding box. The tube keeps its width; pitch varies. */
  slotHeight: Object.freeze({ classic: 78, seven: 58 }),
  /** One pinned ticket-strip row in S4, which changes state at its lock. */
  ticketRow: Object.freeze({ width: 390, height: 28 }),
  /** The settle-cadence hairline under the top rail. */
  hairline: Object.freeze({ width: 390, height: 3 }),
});

/** docs/DESIGN.md §4: a ticket carries at most this many lines. */
export const MAX_TICKET_ROWS = 12;

/** The §6.4 motion table, as numbers, so the concurrency claim is computed. */
export const MOTION_MS = Object.freeze({
  settleStagger: Object.freeze({ classic: 420, seven: 360 }),
  lockRebound: 90,
  lineStateChange: 120,
  fall: 340,
});

/** Bytes per output pixel written by the compositor into the framebuffer. */
const COMPOSITOR_WRITE_BYTES = BYTES_PER_PIXEL;

/**
 * The compositor and raster budget for the DOM/SVG layer during SETTLE.
 *
 * @param {object} options
 * @param {number} options.devicePixelRatio the panel's ratio — NOT capped; the
 *   whole point of §6.2 is that this layer is drawn at native density
 * @param {'classic'|'seven'} options.variant
 * @param {number} options.ticketRows lines pinned in S4
 * @param {number} options.fps
 */
export function chromeBudget({
  devicePixelRatio,
  variant = 'seven',
  ticketRows = MAX_TICKET_ROWS,
  fps = 60,
  viewport = VIEWPORT_CSS,
  chamber = CHAMBER_CSS,
} = {}) {
  if (!(devicePixelRatio > 0)) throw new RangeError('chromeBudget requires a positive devicePixelRatio');
  const slots = SPHERE_COUNT[variant];
  if (!slots) throw new RangeError(`Unknown variant: ${variant}`);
  const px = (css) => Math.round(css * devicePixelRatio);
  const area = (w, h) => px(w) * px(h);

  const viewportPixels = area(viewport.width, viewport.height);
  // The canvas covers only the chamber rect, and the compositor samples it at
  // native density even though it was rendered at the capped one.
  const canvasPixels = area(chamber.width, chamber.height);

  const compositeShaded = viewportPixels;
  const compositeWriteBytes = viewportPixels * COMPOSITOR_WRITE_BYTES;
  const compositeReadBytes = (viewportPixels + canvasPixels) * BYTES_PER_PIXEL;

  /**
   * Every chrome element that moves during SETTLE, promoted to its own layer so
   * that moving it costs a transform and never a repaint.
   */
  const layers = Object.freeze([
    Object.freeze({
      id: 'slot-rings',
      count: slots,
      devicePixelsEach: area(CHROME_CSS.tube.width, CHROME_CSS.slotHeight[variant]),
      animates: 'transform (4% ring overshoot) + opacity',
      note: 'one per slot; the 90 ms rebound is shorter than the settle stagger, so at most one is in flight',
    }),
    Object.freeze({
      id: 'tube-outline',
      count: 1,
      devicePixelsEach: area(CHROME_CSS.tube.width, CHROME_CSS.tube.height),
      animates: 'transform (2 px chamber flex)',
      note: 'the flex is a translate on the whole group, never a change to the path',
    }),
    Object.freeze({
      id: 'ticket-rows',
      count: ticketRows,
      devicePixelsEach: area(CHROME_CSS.ticketRow.width, CHROME_CSS.ticketRow.height),
      animates: 'opacity + colour',
      note: 'one per line; state changes at the deciding lock, 120 ms, identical for won and lost',
    }),
    Object.freeze({
      id: 'cadence-hairline',
      count: 1,
      devicePixelsEach: area(CHROME_CSS.hairline.width, CHROME_CSS.hairline.height),
      animates: 'transform (scaleX)',
      note: 'reaches full width at lock n-1, not lock n',
    }),
  ]);

  const promotedPixels = layers.reduce((sum, layer) => sum + layer.count * layer.devicePixelsEach, 0);
  const layerCount = layers.reduce((sum, layer) => sum + layer.count, 0);

  // At most one ring rebound is ever in flight, because the rebound is shorter
  // than the interval between locks. Computed, not assumed.
  const stagger = MOTION_MS.settleStagger[variant];
  const concurrentRingRebounds = Math.max(1, Math.ceil(MOTION_MS.lockRebound / stagger));

  // Under the compositor-only rule nothing is re-rasterised during SETTLE.
  const rasterPixelsPerFrame = 0;
  // The counterfactual: animate the ring by stroke geometry and the flex by
  // editing the tube path, and both layers invalidate every frame.
  const ringPixels = layers[0].devicePixelsEach * concurrentRingRebounds;
  const naiveRasterPixelsPerFrame = ringPixels + layers[1].devicePixelsEach * layers[1].count;

  return Object.freeze({
    devicePixelRatio,
    variant,
    fps,
    viewport: `${px(viewport.width)} × ${px(viewport.height)}`,
    viewportPixels,
    canvasSampledPixels: canvasPixels,
    compositeShadedFragments: compositeShaded,
    compositeWriteBytes,
    compositeReadBytes,
    compositeMegafragmentsPerSecond: (compositeShaded * fps) / 1e6,
    compositeWriteMegabytesPerSecond: (compositeWriteBytes * fps) / 1e6,
    compositeReadMegabytesPerSecond: (compositeReadBytes * fps) / 1e6,
    compositeTrafficMegabytesPerSecond: ((compositeWriteBytes + compositeReadBytes) * fps) / 1e6,
    layers,
    layerCount,
    promotedPixels,
    /** Layer-memory cost of promoting all of it, at 4 bytes per pixel. */
    promotedLayerMegabytes: (promotedPixels * BYTES_PER_PIXEL) / 1e6,
    concurrentRingRebounds,
    rasterPixelsPerFrame,
    rasterMegapixelsPerSecond: (rasterPixelsPerFrame * fps) / 1e6,
    naiveRasterPixelsPerFrame,
    naiveRasterMegapixelsPerSecond: (naiveRasterPixelsPerFrame * fps) / 1e6,
    naiveUploadMegabytesPerSecond: (naiveRasterPixelsPerFrame * BYTES_PER_PIXEL * fps) / 1e6,
  });
}

/**
 * Both layers of one frame on one device: the capped WebGL canvas plus the
 * native-DPR chrome layer and the composite that puts them on screen.
 *
 * This is the number docs/DESIGN.md §7.1 has to publish. The canvas alone was
 * 72.2 Mfrag/s and 2–7% of the reference class's fill; with the layer the
 * design deliberately loaded with every hard edge, it is roughly three times
 * that. Still comfortable, and now it is the whole frame.
 */
export function deviceFrameBudget({ devicePixelRatio, variant = 'seven', ticketRows = MAX_TICKET_ROWS, fps = 60 } = {}) {
  const webgl = frameBudget({ devicePixelRatio, spheres: SPHERE_COUNT[variant], fps });
  const chrome = chromeBudget({ devicePixelRatio, variant, ticketRows, fps });
  return Object.freeze({
    devicePixelRatio,
    variant,
    fps,
    webgl,
    chrome,
    totalShadedFragments: webgl.shadedFragments + chrome.compositeShadedFragments,
    totalMegafragmentsPerSecond: webgl.megafragmentsPerSecond + chrome.compositeMegafragmentsPerSecond,
    totalTrafficMegabytesPerSecond:
      webgl.trafficMegabytesPerSecond + chrome.compositeTrafficMegabytesPerSecond,
    totalRasterMegapixelsPerSecond: chrome.rasterMegapixelsPerSecond,
  });
}

/**
 * The clip export budget (§9.1): 1080 x 1920 offscreen at a fixed 30 fps,
 * rendered from the transcript rather than screen-recorded.
 *
 * The chamber passes are not the whole frame here either. The clip carries the
 * burned-in commitment hash, the multiplier stamp and the tube outline, and
 * those are composited over the chamber at export resolution on every frame —
 * so the overlay is counted rather than assumed away, exactly as the composite
 * pass is counted on device.
 */
export function clipExportBudget({ width = 1080, height = 1920, seconds = 6, fps = 30, spheres = SPHERE_COUNT.seven } = {}) {
  // The clip renders the chamber full-bleed, so the sphere scales with width.
  const spriteDiameter = (SPHERE_DIAMETER_CSS * width) / CHAMBER_CSS.width;
  const perFrame = frameBudget({
    widthCss: width,
    heightCss: height,
    devicePixelRatio: 1,
    dprCap: null,
    spheres,
    spriteDiameterCss: spriteDiameter,
    fps,
  });
  const frames = seconds * fps;
  // One full-frame overlay composite: hash, stamp, tube outline, at 1080x1920.
  const overlayFragmentsPerFrame = width * height;
  const shadedPerFrame = perFrame.shadedFragments + overlayFragmentsPerFrame;
  return Object.freeze({
    width,
    height,
    fps,
    seconds,
    frames,
    chamberFragmentsPerFrame: perFrame.shadedFragments,
    overlayFragmentsPerFrame,
    shadedFragmentsPerFrame: shadedPerFrame,
    megafragmentsPerFrame: shadedPerFrame / 1e6,
    totalMegafragments: (shadedPerFrame * frames) / 1e6,
  });
}

/** Round to a fixed number of places for display, as a string. */
export const fixed = (value, places) => value.toFixed(places);
