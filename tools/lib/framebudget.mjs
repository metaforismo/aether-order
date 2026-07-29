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

/**
 * The clip export budget (§9.1): 1080 x 1920 offscreen at a fixed 30 fps,
 * rendered from the transcript rather than screen-recorded.
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
  return Object.freeze({
    width,
    height,
    fps,
    seconds,
    frames,
    shadedFragmentsPerFrame: perFrame.shadedFragments,
    megafragmentsPerFrame: perFrame.shadedFragments / 1e6,
    totalMegafragments: (perFrame.shadedFragments * frames) / 1e6,
  });
}

/** Round to a fixed number of places for display, as a string. */
export const fixed = (value, places) => value.toFixed(places);
