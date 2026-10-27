#!/usr/bin/env node
/**
 * ingest-assets.mjs
 * ---------------------------------------------------------------------------
 * Copies the read-only source artwork into `src/assets/` under normalized
 * filenames, and writes a provenance manifest with SHA-256 hashes.
 *
 * The originals are NEVER modified — this script only reads from SOURCE_ROOT.
 *
 * Source naming is irregular (leading spaces, `+`, double dots `..`, and
 * `-17`..`-21` suffixes). Everything is normalized to `01.png` … `06.png`
 * inside a per-product folder.
 *
 * Usage:  npm run assets:ingest
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const ASSETS_DIR = path.join(PROJECT_ROOT, 'src', 'assets');

// Read-only handoff folder (see 交接清单.md).
const SOURCE_ROOT =
  process.env.FUTURENUTRA_SOURCE ??
  'C:/Users/u/Desktop/程序大赛/产品展示网站';

const BOARD_DIR = path.join(SOURCE_ROOT, '新建文件夹(1)', '新建文件夹');
const CAROUSEL_DIR = path.join(SOURCE_ROOT, 'Product Carousel');

/** Product carousel folders -> normalized output slugs. */
const CAROUSEL_SETS = [
  { dir: 'Flora Balance', slug: 'flora-balance' },
  { dir: 'MagniShield Trio', slug: 'magnishield-trio' },
  { dir: 'PhytoMoss+', slug: 'phyto-moss' },
  { dir: 'Synbiotica Daily', slug: 'synbiotica-daily' },
];

/** Boards (画板 1..5) -> normalized output names. */
const BOARD_MAP = [
  { src: '画板 1.jpg', out: '01.png', role: 'Immunity Shield hero visual' },
  { src: '画板 2.jpg', out: '02.png', role: 'Selling points: serif headline + 4 icons' },
  { src: '画板 3.jpg', out: '03.png', role: 'Lifestyle: person holding product' },
  { src: '画板 4.jpg', out: '04.png', role: 'Ingredient narrative / brand block' },
  { src: '画板 5.jpg', out: '05.png', role: 'Supplement Facts table (never crop)' },
];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex').toUpperCase();

/** Natural sort so `10` follows `9` rather than `1`. */
const natural = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/**
 * The carousel folders contain exactly 6 images, but their prefixes are
 * inconsistent. Sort numerically by the leading `<n>.` index, falling back to
 * natural filename order when no numeric prefix is present.
 */
function orderCarouselFiles(files) {
  return [...files].sort((a, b) => {
    const na = Number.parseInt(/^\s*(\d+)\s*[.\-]/.exec(a)?.[1] ?? '', 10);
    const nb = Number.parseInt(/^\s*(\d+)\s*[.\-]/.exec(b)?.[1] ?? '', 10);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    if (Number.isFinite(na) && !Number.isFinite(nb)) return -1;
    if (!Number.isFinite(na) && Number.isFinite(nb)) return 1;
    return natural.compare(a, b);
  });
}

const isImage = (name) => /\.(png|jpe?g|webp|avif)$/i.test(name);

async function listImages(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && isImage(e.name))
    .map((e) => e.name);
}

async function ingest() {
  if (!existsSync(SOURCE_ROOT)) {
    throw new Error(`Source artwork folder not found: ${SOURCE_ROOT}`);
  }

  const manifest = { generatedAt: new Date().toISOString(), sourceRoot: SOURCE_ROOT, files: [] };
  let copied = 0;

  /** Copy one file, recording provenance. */
  async function copyOne(srcPath, outPath, role) {
    const buf = await readFile(srcPath);
    await copyFile(srcPath, outPath);
    const stat = { bytes: buf.byteLength, sha256: sha256(buf) };
    manifest.files.push({
      out: path.relative(PROJECT_ROOT, outPath).replaceAll('\\', '/'),
      source: path.relative(SOURCE_ROOT, srcPath).replaceAll('\\', '/'),
      role,
      ...stat,
    });
    copied += 1;
  }

  // ---- Boards -------------------------------------------------------------
  const boardOutDir = path.join(ASSETS_DIR, 'boards');
  await mkdir(boardOutDir, { recursive: true });
  for (const board of BOARD_MAP) {
    const srcPath = path.join(BOARD_DIR, board.src);
    if (!existsSync(srcPath)) {
      console.warn(`  ! missing board: ${board.src}`);
      continue;
    }
    await copyOne(srcPath, path.join(boardOutDir, board.out), board.role);
  }
  console.log(`boards/  -> ${BOARD_MAP.length} files`);

  // ---- Product carousels --------------------------------------------------
  for (const set of CAROUSEL_SETS) {
    const srcDir = path.join(CAROUSEL_DIR, set.dir);
    if (!existsSync(srcDir)) {
      console.warn(`  ! missing carousel folder: ${set.dir}`);
      continue;
    }
    const outDir = path.join(ASSETS_DIR, set.slug);
    await mkdir(outDir, { recursive: true });

    const files = orderCarouselFiles(await listImages(srcDir));
    for (const [i, name] of files.entries()) {
      const out = `${String(i + 1).padStart(2, '0')}.png`;
      await copyOne(path.join(srcDir, name), path.join(outDir, out), `${set.slug} carousel #${i + 1}`);
    }
    console.log(`${set.slug}/  -> ${files.length} files`);
  }

  const manifestPath = path.join(ASSETS_DIR, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  console.log(`\nDone: ${copied} files copied into src/assets/`);
  console.log(`Manifest: ${path.relative(PROJECT_ROOT, manifestPath)}`);
}

ingest().catch((err) => {
  console.error('\nAsset ingest failed:\n', err.message);
  process.exitCode = 1;
});
