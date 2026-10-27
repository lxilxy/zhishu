/**
 * Captures screenshots at true emulated viewport sizes via CDP.
 * (Edge's --window-size cannot go below its minimum window width, so the
 *  screenshot CLI flag produces cropped, misleading mobile images.)
 *
 * Usage:  node scripts/shoot.mjs <outDir> [baseUrl]
 */
const OUT = process.argv[2] ?? '.shots';
const BASE = process.argv[3] ?? 'http://127.0.0.1:4321';
const PORT = 9335;

const { spawn } = await import('node:child_process');
const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const path = await import('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const userDataDir = await mkdtemp(path.join(tmpdir(), 'fn-shoot-'));
await mkdir(OUT, { recursive: true });

const edge = spawn(
  EDGE,
  [
    '--headless=new',
    '--disable-gpu',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

async function waitForTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('DevTools unavailable');
}

const ws = new WebSocket(await waitForTarget());
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let msgId = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

await send('Page.enable');
await send('Runtime.enable');

/** Capture one full-page screenshot at a given width. */
async function shoot(name, route, width, { mobile = false, fullPage = true } = {}) {
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height: 1000,
    deviceScaleFactor: 1,
    mobile,
  });
  await send('Page.navigate', { url: BASE + route });
  await new Promise((r) => setTimeout(r, 1400));

  // Scroll through the page so lazy images decode before capture.
  await send('Runtime.evaluate', {
    expression: `
      (async () => {
        // Defeat lazy-loading: every image must be painted in the capture.
        document.querySelectorAll('img[loading="lazy"]').forEach((img) => {
          img.loading = 'eager';
        });
        const step = window.innerHeight;
        for (let y = 0; y < document.body.scrollHeight; y += step) {
          window.scrollTo(0, y);
          await new Promise(r => setTimeout(r, 120));
        }
        window.scrollTo(0, 0);
        // High-res JPEGs decode slowly — wait until every image is complete
        // and decoded, with a hard per-image timeout so we never hang.
        const imgs = [...document.images];
        await Promise.all(
          imgs.map((img) =>
            img.complete
              ? Promise.resolve()
              : new Promise((res) => {
                  img.addEventListener('load', res, { once: true });
                  img.addEventListener('error', res, { once: true });
                  setTimeout(res, 4000);
                }),
          ),
        );
        await Promise.all(imgs.map((img) => img.decode().catch(() => {})));
        await new Promise(r => setTimeout(r, 500));
      })()
    `,
    awaitPromise: true,
  });

  const result = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: fullPage,
    ...(fullPage ? {} : {}),
  });

  const file = path.join(OUT, `${name}.png`);
  await writeFile(file, Buffer.from(result.data, 'base64'));
  console.log(`${file}  (${width}px)`);
}

const target = process.argv[4] ?? 'all';

if (target === 'all' || target === 'desktop') {
  await shoot('d-home', '/', 1280);
  await shoot('d-shop', '/shop', 1280);
  await shoot('d-pdp', '/shop/flora-balance', 1280);
  await shoot('d-about', '/about', 1280);
  await shoot('d-contact', '/contact', 1280);
  await shoot('d-faq', '/faq', 1280);
}

if (target === 'all' || target === 'mobile') {
  await shoot('m-home', '/', 390, { mobile: true });
  await shoot('m-shop', '/shop', 390, { mobile: true });
  await shoot('m-pdp', '/shop/flora-balance', 390, { mobile: true });
  await shoot('m-contact', '/contact', 390, { mobile: true });
}

if (target === 'tablet') {
  await shoot('t-home', '/', 820, { mobile: true });
  await shoot('t-shop', '/shop', 820, { mobile: true });
}

ws.close();
edge.kill();
