/**
 * Measures the real network cost of a first visit and the LCP/CLS metrics,
 * by loading each page cold and summing the transfer sizes of what the
 * browser actually requests.
 *
 * Usage:  node scripts/measure-payload.mjs [baseUrl]
 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:4321';
const PORT = 9339;

const { spawn } = await import('node:child_process');
const { mkdtemp } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const path = await import('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const dir = await mkdtemp(path.join(tmpdir(), 'fn-payload-'));

const edge = spawn(
  EDGE,
  [
    '--headless=new',
    '--disable-gpu',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${dir}`,
    '--no-first-run',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

async function waitTarget() {
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
  throw new Error('no target');
}

const ws = new WebSocket(await waitTarget());
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let id = 0;
const pend = new Map();
const events = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) {
    const { resolve, reject } = pend.get(m.id);
    pend.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  } else if (m.method) {
    events.push(m);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const i = ++id;
    pend.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params }));
  });

async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
  return r.result.value;
}

await send('Page.enable');
await send('Network.enable');
await send('Runtime.enable');

const ROUTES = [
  ['home', '/'],
  ['shop', '/shop'],
  ['pdp', '/shop/flora-balance'],
  ['about', '/about'],
  ['contact', '/contact'],
  ['faq', '/faq'],
];

console.log('route     requests   transferred   LCP(ms)   CLS     TTFB(ms)');
console.log('----------------------------------------------------------------');

for (const [name, route] of ROUTES) {
  events.length = 0;
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  // Emulate a fast 3G-ish pipe so image weight is visible.
  await send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 40,
    downloadThroughput: (10 * 1024 * 1024) / 8,
    uploadThroughput: (3 * 1024 * 1024) / 8,
  });
  await send('Network.setCacheDisabled', { cacheDisabled: true });

  await send('Page.navigate', { url: BASE + route });
  // Wait for the load event plus a settling period for lazy images.
  await new Promise((r) => setTimeout(r, 3500));

  const metrics = await ev(`
    (() => new Promise(resolve => {
      let lcp = 0;
      try {
        new PerformanceObserver(list => {
          const entries = list.getEntries();
          if (entries.length) lcp = entries[entries.length - 1].startTime;
        }).observe({ type: 'largest-contentful-paint', buffered: true });
      } catch {}
      let cls = 0;
      const shifts = [];
      try {
        new PerformanceObserver(list => {
          for (const e of list.getEntries()) {
            if (e.hadRecentInput) continue;
            cls += e.value;
            // Record what moved, so an unexpected CLS can be traced to an
            // element instead of being guessed at.
            shifts.push({
              value: Number(e.value.toFixed(4)),
              time: Math.round(e.startTime),
              sources: (e.sources || []).map(function (s) {
                var name = s.node ? s.node.nodeName : '?';
                if (s.node && s.node.className) {
                  name += '.' + String(s.node.className).split(' ').join('.');
                }
                return {
                  node: name,
                  prev: s.previousRect ? [Math.round(s.previousRect.x), Math.round(s.previousRect.y)] : null,
                  curr: s.currentRect ? [Math.round(s.currentRect.x), Math.round(s.currentRect.y)] : null,
                };
              }),
            });
          }
        }).observe({ type: 'layout-shift', buffered: true });
      } catch {}
      const nav = performance.getEntriesByType('navigation')[0];
      setTimeout(() => resolve({
        lcp: Math.round(lcp),
        cls: Number(cls.toFixed(4)),
        shifts: shifts.sort((a, b) => b.value - a.value).slice(0, 5),
        ttfb: nav ? Math.round(nav.responseStart) : null,
      }), 700);
    }))()
  `);

  // Sum the encoded sizes of everything the browser actually fetched.
  const reqs = events
    .filter((e) => e.method === 'Network.responseReceived')
    .map((e) => e.params.response);

  const total = await ev(`
    (() => {
      const rs = performance.getEntriesByType('resource');
      let bytes = 0, count = 0, imgBytes = 0, imgCount = 0;
      for (const r of rs) {
        const size = r.encodedBodySize || 0;
        bytes += size; count++;
        if (r.initiatorType === 'img' || /\\.(avif|webp|jpe?g|png)(\\?|$)/i.test(r.name)) {
          imgBytes += size; imgCount++;
        }
      }
      const nav = performance.getEntriesByType('navigation')[0];
      const doc = nav ? (nav.encodedBodySize || 0) : 0;
      return {
        bytes: bytes + doc,
        count: count + 1,
        imgBytes, imgCount, doc,
      };
    })()
  `);

  void reqs;
  const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
  console.log(
    `${name.padEnd(9)} ${String(total.count).padStart(6)}   ${kb(total.bytes).padStart(9)}   ` +
      `${String(metrics.lcp).padStart(6)}   ${String(metrics.cls).padStart(5)}   ${String(metrics.ttfb).padStart(6)}` +
      `   (images: ${total.imgCount} / ${kb(total.imgBytes)})`,
  );

  // When CLS is non-zero, list the elements responsible so the shift can be
  // fixed at its source rather than guessed at.
  if (metrics.shifts?.length) {
    for (const s of metrics.shifts) {
      const nodes = s.sources
        .map((x) => x.node + (x.prev && x.curr ? ' ' + x.prev + '->' + x.curr : ''))
        .join(', ');
      console.log('          shift ' + s.value + ' @' + s.time + 'ms  ' + (nodes || '(no source recorded)'));
    }
  }
}

ws.close();
edge.kill();
