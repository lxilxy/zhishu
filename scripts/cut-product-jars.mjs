/**
 * cut-product-jars.mjs
 * ---------------------------------------------------------------------------
 * Produces derived, presentation-ready art from the raw carousel renders:
 *
 *   1. CUT-OUT JARS  src/assets/cutouts/<slug>.png
 *      The jar from carousel slot `01`, isolated from its flat studio ground
 *      on transparency.
 *
 *   2. CLEAN LIFESTYLE CROPS  src/assets/cutouts/<slug>-lifestyle.png
 *      Carousel slot `02` is a lifestyle photo with a marketing headline baked
 *      into its lower half. Pages that overlay their *own* copy on that photo
 *      would otherwise collide with the built-in text, so the top portion
 *      (above the headline) is cropped out here.
 *
 * WHY
 * ---
 * Each carousel image `01` is a 2501x2501 square with the jar centred on a
 * flat tinted ground. Placing those squares side by side (as the home hero and
 * the brand collage require) makes the grounds read as three coloured blocks
 * rather than three jars on one surface.
 *
 * The grounds are a single flat colour per image, so they can be keyed out
 * cleanly. The jar edges are soft, so the key uses a distance ramp rather than
 * a hard threshold: pixels close to the ground colour become fully transparent,
 * pixels matching the jar stay opaque, and the band between them fades.
 *
 * The originals in src/assets/<slug>/*.png are never modified.
 *
 * Usage:  node scripts/cut-product-jars.mjs [--tol N] [--feather N] [--border N]
 * Requires `sharp`, which is already a project dependency.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ASSETS = path.join(ROOT, 'src', 'assets');
const OUT = path.join(ASSETS, 'cutouts');

/** Products whose `01` (jar) and `02` (lifestyle) renders should be derived. */
const SLUGS = ['flora-balance', 'phyto-moss', 'magnishield-trio', 'synbiotica-daily'];

/**
 * Fraction of the lifestyle render to keep, measured from the top.
 * The baked-in headline sits in the lower ~40% of every slot-02 image, so
 * keeping the top 50% removes it with margin to spare.
 */
const LIFESTYLE_KEEP = 0.5;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
}

/** Distance below which a pixel is treated as pure background. */
const TOL = arg('tol', 16);
/** Width of the fade band above TOL, in colour-distance units. */
const FEATHER = arg('feather', 26);

/**
 * Remove a flat ground colour, returning raw RGBA pixels plus the tight
 * bounding box of everything that survived.
 *
 * `inset` skips a narrow border before measuring the bounding box: the source
 * renders carry a 1px hard edge (black along the right and bottom) that would
 * otherwise stretch the box to the full frame.
 */
function keyOutGround(data, width, height, channels, bg, inset) {
  const out = Buffer.alloc(width * height * 4);

  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * channels;
      const r = data[s];
      const g = data[s + 1];
      const b = data[s + 2];

      // Manhattan distance in RGB. Cheap and good enough for a flat ground.
      const dist = Math.abs(r - bg.r) + Math.abs(g - bg.g) + Math.abs(b - bg.b);

      let alpha;
      if (dist <= TOL) alpha = 0;
      else if (dist >= TOL + FEATHER) alpha = 255;
      else alpha = Math.round(((dist - TOL) / FEATHER) * 255);

      const d = (y * width + x) * 4;
      out[d] = r;
      out[d + 1] = g;
      out[d + 2] = b;
      out[d + 3] = alpha;

      // Track the extent of anything meaningfully opaque, so the result can be
      // trimmed without leaving a transparent margin. Pixels inside the border
      // inset are ignored for measuring (but still keyed).
      const inside =
        x >= inset && x < width - inset && y >= inset && y < height - inset;
      if (inside && alpha > 12) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0) throw new Error('Every pixel keyed out — the ground detection failed.');
  return { out, minX, maxX, minY, maxY };
}

/**
 * Find the dominant ground colour by sampling a ring well inside the frame.
 * Sampling a ring rather than one corner avoids any edge trim some renders
 * have (phyto-moss has a dark strip along the left edge).
 */
function sampleGround(data, width, height, channels, inset) {
  const tally = new Map();
  const points = [];
  const step = 16;

  for (let x = inset; x < width - inset; x += step) {
    points.push([x, inset], [x, height - inset - 1]);
  }
  for (let y = inset; y < height - inset; y += step) {
    points.push([inset, y], [width - inset - 1, y]);
  }

  for (const [x, y] of points) {
    const s = (y * width + x) * channels;
    // Quantise to 8 levels per channel so near-identical pixels group together.
    const key = `${data[s] >> 3},${data[s + 1] >> 3},${data[s + 2] >> 3}`;
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }

  let bestKey = null;
  let bestCount = -1;
  for (const [k, count] of tally) {
    if (count > bestCount) {
      bestCount = count;
      bestKey = k;
    }
  }
  if (!bestKey) throw new Error('Could not sample a ground colour.');

  // Average the actual pixels belonging to the winning bucket for accuracy.
  const want = bestKey.split(',').map(Number);
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (const [x, y] of points) {
    const s = (y * width + x) * channels;
    if (data[s] >> 3 === want[0] && data[s + 1] >> 3 === want[1] && data[s + 2] >> 3 === want[2]) {
      r += data[s];
      g += data[s + 1];
      b += data[s + 2];
      n++;
    }
  }
  return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
}

/**
 * Crop the top `keep` fraction of a lifestyle render, dropping the headline
 * that the artwork bakes into its lower half.
 */
async function writeLifestyleCrop(slug) {
  const src = path.join(ASSETS, slug, '02.png');
  const meta = await sharp(src).metadata();
  const width = meta.width;
  const height = meta.height;
  if (!width || !height) throw new Error(`Could not read dimensions of ${src}`);

  const keepH = Math.round(height * LIFESTYLE_KEEP);
  const dest = path.join(OUT, `${slug}-lifestyle.png`);

  await sharp(src)
    .extract({ left: 0, top: 0, width, height: keepH })
    .png({ compressionLevel: 9 })
    .toFile(dest);

  return { width, height: keepH };
}

async function main() {
  await mkdir(OUT, { recursive: true });

  for (const slug of SLUGS) {
    const src = path.join(ASSETS, slug, '01.png');

    const { data, info } = await sharp(src)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { width, height, channels } = info;
    const bg = sampleGround(data, width, height, channels, Math.round(width * 0.08));

    // The renders carry a 1px hard edge; ignore it when measuring the jar.
    const border = arg('border', 3);

    const { out, minX, maxX, minY, maxY } = keyOutGround(
      data,
      width,
      height,
      channels,
      bg,
      border,
    );
    const cropW = maxX - minX + 1;
    const cropH = maxY - minY + 1;

    const dest = path.join(OUT, `${slug}.png`);
    await sharp(out, { raw: { width, height, channels: 4 } })
      .extract({ left: minX, top: minY, width: cropW, height: cropH })
      .png({ compressionLevel: 9 })
      .toFile(dest);

    const pct = (v, t) => `${Math.round((100 * v) / t)}%`;
    console.log(
      `cut ${slug.padEnd(18)} ground rgb(${bg.r},${bg.g},${bg.b})  ` +
        `jar ${cropW}x${cropH} (${pct(cropW, width)} x ${pct(cropH, height)} of frame)`,
    );

    const life = await writeLifestyleCrop(slug);
    console.log(
      `    ${''.padEnd(14)} lifestyle crop -> ${life.width}x${life.height} ` +
        `(top ${Math.round(LIFESTYLE_KEEP * 100)}%, headline removed)`,
    );
  }

  console.log(`\nWrote ${SLUGS.length} jar cut-outs + ${SLUGS.length} lifestyle crops to src/assets/cutouts/`);
}

main().catch((err) => {
  console.error(`\ncut-product-jars failed: ${err.message}`);
  process.exitCode = 1;
});
