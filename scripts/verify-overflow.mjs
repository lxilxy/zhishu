/**
 * Detects horizontal overflow at multiple viewport widths.
 * Overflow is the classic cause of a page that looks "cut off" on mobile.
 *
 * Usage:  node scripts/verify-overflow.mjs [baseUrl]
 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:4321';
const PORT = 9334;

const { spawn } = await import('node:child_process');
const { mkdtemp } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const path = await import('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const userDataDir = await mkdtemp(path.join(tmpdir(), 'fn-overflow-'));

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
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('DevTools endpoint unavailable');
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

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
  return r.result.value;
}

await send('Page.enable');
await send('Runtime.enable');

const ROUTES = [
  ['home', '/'],
  ['shop', '/shop'],
  ['pdp', '/shop/flora-balance'],
  ['about', '/about'],
  ['contact', '/contact'],
  ['faq', '/faq'],
];

const WIDTHS = [
  [360, 'small phone'],
  [390, 'phone'],
  [639, 'phone (breakpoint edge)'],
  [768, 'tablet'],
  [1023, 'tablet (breakpoint edge)'],
  [1280, 'desktop'],
];

let failures = 0;

for (const [routeName, route] of ROUTES) {
  for (const [width, label] of WIDTHS) {
    await send('Emulation.setDeviceMetricsOverride', {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: width < 640,
    });

    await send('Page.navigate', { url: BASE + route });
    await new Promise((r) => setTimeout(r, 900));

    const report = await evaluate(`
      (() => {
        const de = document.documentElement;
        const overflowing = [];
        const vw = de.clientWidth;
        for (const el of document.querySelectorAll('body *')) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          // Ignore elements that are legitimately off-canvas (closed drawers).
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          const isDrawer = el.closest('[data-cart-drawer], [data-nav-drawer], [data-lightbox]');
          if (isDrawer) continue;
          if (r.right > vw + 1 || r.left < -1) {
            overflowing.push({
              tag: el.tagName.toLowerCase(),
              cls: (el.className && typeof el.className === 'string')
                ? el.className.split(' ').filter(Boolean).slice(0, 3).join('.')
                : '',
              left: Math.round(r.left),
              right: Math.round(r.right),
              w: Math.round(r.width),
            });
          }
        }
        return {
          scrollW: de.scrollWidth,
          clientW: vw,
          hasHorizontalScroll: de.scrollWidth > vw + 1,
          offenders: overflowing.slice(0, 4),
        };
      })()
    `);

    if (report.hasHorizontalScroll) {
      failures++;
      console.log(
        `OVERFLOW  ${routeName} @ ${width}px (${label})  scrollW=${report.scrollW} clientW=${report.clientW}`,
      );
      for (const o of report.offenders) {
        console.log(`            <${o.tag} class="${o.cls}"> left=${o.left} right=${o.right} w=${o.w}`);
      }
    }
  }
}

console.log(failures === 0 ? '\nNo horizontal overflow detected at any tested width.' : `\n${failures} overflow case(s).`);

ws.close();
edge.kill();
process.exit(failures ? 1 : 0);
