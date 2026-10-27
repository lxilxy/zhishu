/**
 * Ad-hoc layout probe: reports the geometry of specific elements so overlaps
 * and spacing can be verified numerically rather than by eye.
 *
 * Usage:  node scripts/probe.mjs <path> <cssSelector> [width]
 */
const PORT = 9337;
const BASE = 'http://127.0.0.1:4321';

const { spawn } = await import('node:child_process');
const { mkdtemp } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const path = await import('node:path');

const route = process.argv[2] ?? '/';
const selector = process.argv[3] ?? 'h1';
const width = Number(process.argv[4] ?? 390);

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const dir = await mkdtemp(path.join(tmpdir(), 'fn-probe-'));

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
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) {
    const { resolve, reject } = pend.get(m.id);
    pend.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
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
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width,
  height: 900,
  deviceScaleFactor: 1,
  mobile: width < 640,
});
await send('Page.navigate', { url: BASE + route });
await new Promise((r) => setTimeout(r, 1600));

const report = await ev(`
  (() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { error: 'selector not found: ' + ${JSON.stringify(selector)} };
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const hdr = document.querySelector('header');
    const hr = hdr ? hdr.getBoundingClientRect() : null;
    // Walk up to find what actually clips/overlaps.
    const parents = [];
    let p = el.parentElement;
    while (p && parents.length < 5) {
      const pr = p.getBoundingClientRect();
      parents.push({
        tag: p.tagName.toLowerCase(),
        cls: typeof p.className === 'string' ? p.className.split(' ').slice(0,2).join('.') : '',
        top: Math.round(pr.top), bottom: Math.round(pr.bottom),
        overflow: getComputedStyle(p).overflow,
        scrollHeight: p.scrollHeight, clientHeight: p.clientHeight,
      });
      p = p.parentElement;
    }
    return {
      viewportWidth: document.documentElement.clientWidth,
      scrollY: Math.round(window.scrollY),
      element: {
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || '').trim().slice(0, 60),
        top: Math.round(r.top), bottom: Math.round(r.bottom),
        left: Math.round(r.left), right: Math.round(r.right),
        w: Math.round(r.width), h: Math.round(r.height),
        display: cs.display, position: cs.position,
        overflow: cs.overflow, lineHeight: cs.lineHeight, fontSize: cs.fontSize,
      },
      header: hr ? { top: Math.round(hr.top), bottom: Math.round(hr.bottom), h: Math.round(hr.height) } : null,
      overlapWithHeaderPx: hr ? Math.round(hr.bottom - r.top) : null,
      parents,
    };
  })()
`);

console.log(JSON.stringify(report, null, 2));
ws.close();
edge.kill();
