/**
 * boxes.mjs — print the border-box geometry of several selectors on one page
 * so overlapping margins / grid gaps can be read off directly.
 *
 * Usage: node scripts/boxes.mjs <path> <selector> [selector...]
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = process.env.BASE ?? 'http://127.0.0.1:4321';
const PORT = 9333;

const [, , route = '/', ...selectors] = process.argv;

const edge = spawn(EDGE, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  '--no-first-run',
  '--user-data-dir=' + process.env.TEMP + '\\fn-boxes',
  'about:blank',
]);
edge.on('error', (e) => {
  console.error('edge launch failed:', e.message);
  process.exit(1);
});

async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('no target');
}

const ws = new WebSocket(await target());
await new Promise((res) => (ws.onopen = res));

let id = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
const send = (method, params = {}) =>
  new Promise((res) => {
    const myId = ++id;
    pending.set(myId, res);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: 1280,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
});
await send('Page.navigate', { url: BASE + route });
await sleep(2200);

const selJson = JSON.stringify(selectors);
const r = await send('Runtime.evaluate', {
  expression: `(() => {
    const sels = ${selJson};
    const out = [];
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (!el) { out.push({ sel, missing: true }); continue; }
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const prev = el.previousElementSibling;
      out.push({
        sel,
        cls: el.className,
        top: Math.round(r.top + scrollY),
        bottom: Math.round(r.bottom + scrollY),
        h: Math.round(r.height),
        left: Math.round(r.left),
        w: Math.round(r.width),
        marginTop: cs.marginTop,
        marginBottom: cs.marginBottom,
        paddingTop: cs.paddingTop,
        rowGap: cs.rowGap,
        colGap: cs.columnGap,
        display: cs.display,
        gridRow: cs.gridRow,
        gridColumn: cs.gridColumn,
      });
    }
    return out;
  })()`,
  returnByValue: true,
});

for (const e of r.result?.result?.value ?? []) {
  if (e.missing) { console.log(`${e.sel}  MISSING`); continue; }
  console.log(
    `${e.sel}\n` +
      `   box   top=${e.top} bottom=${e.bottom} h=${e.h}  left=${e.left} w=${e.w}\n` +
      `   grid  row=${e.gridRow} col=${e.gridColumn}  gap=${e.rowGap}/${e.colGap}\n` +
      `   space margin=${e.marginTop}/${e.marginBottom} paddingTop=${e.paddingTop}`,
  );
}

ws.close();
edge.kill();
