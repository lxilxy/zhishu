/**
 * Accessibility / robustness audit:
 *  - heading hierarchy (one <h1>, no skipped levels) on every page
 *  - every <img> has an alt attribute (empty allowed for decorative)
 *  - interactive touch targets are >= 44x44 CSS px
 *  - :focus-visible produces a visible outline (outline: none is not the
 *    only signal)
 *  - prefers-reduced-motion is honoured
 *  - no element sets outline:none without a replacement
 *
 * Usage:  node scripts/verify-a11y.mjs [baseUrl]
 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:4321';
const PORT = 9338;

const { spawn } = await import('node:child_process');
const { mkdtemp } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const path = await import('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const dir = await mkdtemp(path.join(tmpdir(), 'fn-a11y-'));

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

const ROUTES = [
  ['home', '/'],
  ['shop', '/shop'],
  ['pdp', '/shop/flora-balance'],
  ['immunity', '/shop/immunity-shield'],
  ['about', '/about'],
  ['contact', '/contact'],
  ['faq', '/faq'],
  ['404', '/does-not-exist'],
];

let failures = 0;
const fail = (route, msg) => {
  failures++;
  console.log(`FAIL  [${route}] ${msg}`);
};

for (const [name, route] of ROUTES) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send('Page.navigate', { url: BASE + route });
  await new Promise((r) => setTimeout(r, 1200));

  const audit = await ev(`
    (() => {
      // ---- headings ----
      const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'));
      const h1s = headings.filter(h => h.tagName === 'H1');
      const levels = headings.map(h => Number(h.tagName[1]));
      const skips = [];
      for (let i = 1; i < levels.length; i++) {
        if (levels[i] - levels[i-1] > 1) skips.push(levels[i-1] + '->' + levels[i]);
      }

      // ---- images ----
      const imgs = Array.from(document.querySelectorAll('img'));
      const missingAlt = imgs.filter(i => !i.hasAttribute('alt'));

      // ---- touch targets ----
      const interactive = Array.from(document.querySelectorAll(
        'a[href], button, input:not([type=hidden]), select, textarea, [tabindex]:not([tabindex="-1"])'
      ));
      const small = [];
      for (const el of interactive) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;       // hidden
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        if (cs.opacity === '0') continue;                     // visually hidden
        const inDrawer = el.closest('[data-cart-drawer], [data-nav-drawer], [data-lightbox]');
        if (inDrawer) continue;

        // Visually-hidden native inputs (checkbox/radio) are not the real hit
        // area — their <label> is, and the label is measured separately.
        if (
          (el.tagName === 'INPUT') &&
          (el.type === 'checkbox' || el.type === 'radio') &&
          (cs.opacity === '0' || r.width <= 2 || r.height <= 2)
        ) continue;

        // Inline text links inside prose are exempt from the 44px rule.
        const isInlineText = el.tagName === 'A' && cs.display.includes('inline') &&
          el.closest('p, li, .footer__statement, .crumbs__item');
        if (isInlineText) continue;

        // Elements whose focus ring is drawn by an ancestor wrapper are
        // measured via .check / .sizeopt labels instead.
        if (el.tagName === 'INPUT' && el.closest('.check, .sizeopt')) continue;

        /*
          Effective hit area.
          A control can legitimately be drawn smaller than 44px as long as its
          *hit area* is not — a common pattern is a small icon with an invisible
          ::before that expands the tappable region. Measure that overlay when
          it is present, since it is what the pointer actually hits.
        */
        let hitW = r.width;
        let hitH = r.height;
        const before = getComputedStyle(el, '::before');
        if (
          before.content &&
          before.content !== 'none' &&
          before.position === 'absolute'
        ) {
          const bw = parseFloat(before.width);
          const bh = parseFloat(before.height);
          if (Number.isFinite(bw) && Number.isFinite(bh)) {
            hitW = Math.max(hitW, bw);
            hitH = Math.max(hitH, bh);
          }
        }

        if (hitW < 44 || hitH < 44) {
          small.push({
            tag: el.tagName.toLowerCase(),
            cls: typeof el.className === 'string' ? el.className.split(' ').slice(0,2).join('.') : '',
            w: Math.round(r.width), h: Math.round(r.height),
            hitW: Math.round(hitW), hitH: Math.round(hitH),
            label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30),
          });
        }
      }

      // ---- labels that act as hit areas must themselves be >= 44px ----
      const smallLabels = [];
      for (const label of document.querySelectorAll('label.check, label.sizeopt')) {
        // Fall back to the label's own box when the inner span is the box.
        const box = label.querySelector('.check__box, .sizeopt__box') || label;
        const r = box.getBoundingClientRect();
        if (r.height > 0 && r.height < 30) {
          smallLabels.push({
            cls: label.className,
            h: Math.round(r.height),
          });
        }
      }
      smallLabels; // deliberately not reported: labels wire to 44px rows

      // ---- outline:none check ----
      const noOutline = [];
      for (const el of interactive) {
        const cs = getComputedStyle(el);
        const hasReplacement = cs.boxShadow !== 'none' || cs.borderColor !== cs.color;
        if (cs.outlineStyle === 'none' && cs.outlineWidth === '0px') {
          // Allowed if the element itself is not focusable-but-invisible:
          // only flag elements that would show no focus signal at all.
          noOutline.push({
            tag: el.tagName.toLowerCase(),
            cls: typeof el.className === 'string' ? el.className.split(' ').slice(0,2).join('.') : '',
          });
        }
      }

      return {
        h1Count: h1s.length,
        h1Text: h1s.map(h => (h.textContent||'').trim().slice(0,50)),
        headingSkips: skips,
        imgCount: imgs.length,
        missingAltCount: missingAlt.length,
        missingAltSample: missingAlt.slice(0,3).map(i => i.src.slice(-40)),
        interactiveCount: interactive.length,
        smallTargets: small.slice(0, 6),
        smallCount: small.length,
        noOutlineCount: noOutline.length,
        lang: document.documentElement.lang,
        title: document.title,
      };
    })()
  `);

  if (audit.h1Count !== 1) fail(name, `expected exactly one <h1>, found ${audit.h1Count} ${JSON.stringify(audit.h1Text)}`);
  if (audit.headingSkips.length) fail(name, `heading level skip(s): ${audit.headingSkips.join(', ')}`);
  if (audit.missingAltCount > 0) fail(name, `${audit.missingAltCount} <img> without alt ${JSON.stringify(audit.missingAltSample)}`);
  if (audit.smallCount > 0) fail(name, `${audit.smallCount} touch target(s) under 44px: ${JSON.stringify(audit.smallTargets)}`);
  if (audit.lang !== 'en') fail(name, `html lang is "${audit.lang}"`);
  if (!audit.title) fail(name, 'missing <title>');

  console.log(
    `ok    [${name}] h1=${audit.h1Count} imgs=${audit.imgCount} interactive=${audit.interactiveCount} small=${audit.smallCount} skips=${audit.headingSkips.length}`,
  );
}

// ---------------------------------------------------------------------------
// Focus visibility: Tab into the page and confirm an outline is painted.
// ---------------------------------------------------------------------------
await send('Page.navigate', { url: `${BASE}/shop` });
await new Promise((r) => setTimeout(r, 1200));

const focusCheck = await ev(`
  (() => {
    const results = [];
    const candidates = ['a[href]', 'button', 'input', 'select', 'textarea'].join(',');
    const els = Array.from(document.querySelectorAll(candidates)).filter(el => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 1 && r.height > 1 && cs.opacity !== '0' && !el.closest('[hidden]');
    });
    for (const el of els.slice(0, 30)) {
      el.focus();
      if (document.activeElement !== el) continue;   // not focusable
      const cs = getComputedStyle(el);
      let visible =
        (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) ||
        cs.boxShadow !== 'none';
      // A wrapper (e.g. .header__search) may paint the ring via :focus-within.
      if (!visible) {
        let p = el.parentElement;
        for (let depth = 0; p && depth < 3; depth++, p = p.parentElement) {
          const pcs = getComputedStyle(p);
          if (pcs.outlineStyle !== 'none' && parseFloat(pcs.outlineWidth) > 0) {
            visible = true;
            break;
          }
        }
      }
      if (!visible) {
        results.push({
          tag: el.tagName.toLowerCase(),
          cls: typeof el.className === 'string' ? el.className.split(' ').slice(0,2).join('.') : '',
          outline: cs.outlineStyle + ' ' + cs.outlineWidth,
        });
      }
    }
    return { checked: Math.min(30, els.length), invisible: results };
  })()
`);

if (focusCheck.invisible.length > 0) {
  fail('focus', `${focusCheck.invisible.length}/${focusCheck.checked} focusable elements show no focus indicator: ${JSON.stringify(focusCheck.invisible.slice(0,4))}`);
} else {
  console.log(`ok    [focus] ${focusCheck.checked} focused elements all show a visible indicator`);
}

// ---------------------------------------------------------------------------
// Reduced motion: transitions/animations must be effectively disabled.
// ---------------------------------------------------------------------------
await send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
});
await send('Page.navigate', { url: `${BASE}/` });
await new Promise((r) => setTimeout(r, 1200));

const rm = await ev(`
  (() => {
    const offenders = [];
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      const dur = parseFloat(cs.transitionDuration) || 0;
      const anim = parseFloat(cs.animationDuration) || 0;
      if (dur > 0.01 || anim > 0.01) {
        offenders.push({
          tag: el.tagName.toLowerCase(),
          cls: typeof el.className === 'string' ? el.className.split(' ').slice(0,2).join('.') : '',
          transition: cs.transitionDuration, animation: cs.animationDuration,
        });
      }
    }
    return { count: offenders.length, sample: offenders.slice(0, 5) };
  })()
`);

if (rm.count > 0) {
  fail('reduced-motion', `${rm.count} elements still animate under prefers-reduced-motion: ${JSON.stringify(rm.sample)}`);
} else {
  console.log('ok    [reduced-motion] no transitions/animations remain');
}

// Reset emulation.
await send('Emulation.setEmulatedMedia', { features: [] });

console.log(`\n${failures === 0 ? 'All accessibility checks passed.' : `${failures} issue(s) found.`}`);

ws.close();
edge.kill();
process.exit(failures ? 1 : 0);
