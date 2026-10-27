/**
 * css.mjs — print the computed style of a property for a selector, plus every
 * matching rule from the CSSOM, so overriding declarations can be identified.
 *
 * Usage: node scripts/css.mjs <path> <selector> <property>
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = process.env.BASE ?? 'http://127.0.0.1:4321';
const PORT = 9344;

const [, , route = '/', selector = 'body', prop = 'color'] = process.argv;

const edge = spawn(EDGE, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  '--no-first-run',
  '--user-data-dir=' + process.env.TEMP + '\\fn-css',
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
  width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
});
await send('Page.navigate', { url: BASE + route });
await sleep(2200);

const r = await send('Runtime.evaluate', {
  expression: `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { missing: true };
    const cs = getComputedStyle(el);
    const out = { computed: cs.getPropertyValue(${JSON.stringify(prop)}), rules: [] };
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      for (const rule of rules) {
        if (!rule.selectorText) continue;
        let matches = false;
        try { matches = el.matches(rule.selectorText); } catch {}
        if (!matches) continue;
        const v = rule.style.getPropertyValue(${JSON.stringify(prop)});
        if (v) out.rules.push({ sel: rule.selectorText, val: v });
      }
    }
    return out;
  })()`,
  returnByValue: true,
});

const v = r.result?.result?.value;
if (v?.missing) console.log(`${selector}  MISSING`);
else {
  console.log(`${selector}  {${prop}} = ${v.computed}`);
  console.log('matching rules:');
  for (const rule of v.rules) console.log(`   ${rule.val}   <- ${rule.sel}`);
}

ws.close();
edge.kill();
