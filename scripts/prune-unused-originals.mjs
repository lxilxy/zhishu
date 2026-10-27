#!/usr/bin/env node
/**
 * prune-unused-originals.mjs
 * ---------------------------------------------------------------------------
 * Removes source-format originals that Astro copies into `dist/_astro/` but
 * that no page references.
 *
 * Why this is needed: `import.meta.glob` imports each asset, and Astro emits
 * the original file alongside the optimized derivatives. Because every
 * `<Picture>` supplies AVIF/WebP plus a JPEG fallback, the multi-megabyte PNG
 * originals are never referenced by any emitted HTML/CSS/JS — they would just
 * inflate the deploy by ~31 MB.
 *
 * The script only deletes files it can prove are unreferenced, and it fails
 * loudly if nothing is referenced (a sign the reference scan itself broke).
 *
 * Usage:  node scripts/prune-unused-originals.mjs   (runs automatically after `astro build`)
 */
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');
const ASTRO_DIR = path.join(DIST, '_astro');

/** Text outputs that can reference an asset. */
const REFERENCING_EXT = new Set(['.html', '.css', '.js', '.mjs', '.json', '.xml', '.txt', '.map']);

/** Originals worth pruning once unreferenced. */
const PRUNABLE_EXT = new Set(['.png', '.jpg', '.jpeg', '.avif', '.webp']);

/** Collect every file under `dir`. */
async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

async function main() {
  let distStat;
  try {
    distStat = await stat(DIST);
  } catch {
    throw new Error(`dist/ not found — run \`npm run build\` first.`);
  }
  if (!distStat.isDirectory()) throw new Error('dist/ is not a directory.');

  const all = await walk(DIST);
  const textFiles = all.filter((f) => REFERENCING_EXT.has(path.extname(f).toLowerCase()));

  if (textFiles.length === 0) {
    throw new Error('No HTML/CSS/JS found in dist/ — refusing to prune.');
  }

  // Concatenate every referencing output into one haystack for lookup.
  const haystack = (await Promise.all(textFiles.map((f) => readFile(f, 'utf8')))).join('\n');

  const assets = all.filter(
    (f) => path.dirname(f) === ASTRO_DIR && PRUNABLE_EXT.has(path.extname(f).toLowerCase()),
  );

  const removed = [];
  let removedBytes = 0;
  let kept = 0;

  for (const file of assets) {
    const name = path.basename(file);
    if (haystack.includes(name)) {
      kept += 1;
      continue;
    }
    const { size } = await stat(file);
    await rm(file);
    removed.push(name);
    removedBytes += size;
  }

  if (kept === 0 && assets.length > 0) {
    throw new Error(
      `Refusing to prune: none of the ${assets.length} candidate assets were referenced. ` +
        'The reference scan is probably broken.',
    );
  }

  const mb = (removedBytes / 1024 / 1024).toFixed(2);
  console.log(
    `prune: removed ${removed.length} unreferenced original(s) (${mb} MB), kept ${kept}.`,
  );
  if (removed.length > 0 && process.env.VERBOSE) {
    for (const name of removed) console.log(`  - ${name}`);
  }
}

main().catch((err) => {
  console.error(`\nprune-unused-originals failed: ${err.message}`);
  process.exitCode = 1;
});
