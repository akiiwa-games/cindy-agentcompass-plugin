// Host side CDP driver for Cindy running in the guest (Electron, started with --remote-debugging-port; guest-setup.ps1
// exposes it on the guest address). Nothing here touches the host desktop.
//
//   node test/real-cindy/cdp.mjs <scratch> targets
//   node test/real-cindy/cdp.mjs <scratch> eval "<js expression>" [--target <substring of url>]
//   node test/real-cindy/cdp.mjs <scratch> shot <file.png> [--target <substring>]
//   node test/real-cindy/cdp.mjs <scratch> text [--target <substring>]            visible text of the page
//   node test/real-cindy/cdp.mjs <scratch> type "<text>" [--enter] [--target <substring>]   type into the composer, optionally send
//   node test/real-cindy/cdp.mjs <scratch> mouse <x>,<y>                                       real mouse click at viewport coordinates
//   node test/real-cindy/cdp.mjs <scratch> click "<button/link text>" [--target <substring>]
//
// As a library: `import { connect } from './cdp.mjs'`; `const page = await connect(scratch, {target})`;
// `await page.eval(expr)`, `page.shot(file)`, `page.close()`. The main window is the page whose URL has no `?...Window=1` query.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function guestHost(scratch) {
  const g = JSON.parse(readFileSync(join(scratch, 'guest.json'), 'utf8'));
  if (!g.ip) throw new Error('guest.json has no ip; run guest.mjs <scratch> ip');
  return `${g.ip}:9223`;
}

export async function targets(scratch) {
  const r = await fetch(`http://${guestHost(scratch)}/json`);
  return (await r.json()).filter((t) => t.type === 'page');
}

export async function connect(scratch, { target } = {}) {
  const list = await targets(scratch);
  const t = target ? list.find((x) => x.url.includes(target))
    : list.find((x) => !/[?&]\w+Window=1/.test(x.url)) ?? list[0];
  if (!t) throw new Error(`no page matches ${target ?? '(main window)'}: ${list.map((x) => x.url).join(', ')}`);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('websocket error')); });
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { const { res, rej } = pending.get(d.id); pending.delete(d.id); d.error ? rej(new Error(d.error.message)) : res(d.result); }
  };
  const send = (method, params = {}) => new Promise((res, rej) => { id += 1; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
  return {
    target: t,
    send,
    async eval(expression, { awaitPromise = true } = {}) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    // Type into the focused composer (ProseMirror) with real input events, then Enter sends.
    async type(text, { selector = '.ProseMirror', enter = false } = {}) {
      await this.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.focus(); return true; })()`);
      await send('Input.insertText', { text });
      if (enter) {
        for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: type === 'keyDown' ? String.fromCharCode(13) : undefined });
      }
    },
    // A real mouse click at viewport coordinates (for controls that ignore element.click()).
    async mouse(x, y) {
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
    },
    async shot(file) {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(file, Buffer.from(r.data, 'base64'));
      return file;
    },
    close() { ws.close(); },
  };
}

// Click the visible element (button, link, [role=button|menuitem|tab]) whose text equals or contains `text`.
export const clickExpression = (text) => `(() => {
  const want = ${JSON.stringify(text)};
  const els = [...document.querySelectorAll('button,a,[role=button],[role=menuitem],[role=tab],[role=option]')]
    .filter((e) => e.offsetParent !== null || e.getClientRects().length);
  const t = (e) => (e.innerText || e.textContent || '').trim();
  const el = els.find((e) => t(e) === want) || els.find((e) => t(e).includes(want));
  if (!el) return { clicked: false, candidates: els.map(t).filter(Boolean).slice(0, 40) };
  el.click(); return { clicked: true, text: t(el) };
})()`;

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [scratch, cmd, arg] = process.argv.slice(2);
  const ti = process.argv.indexOf('--target');
  const target = ti >= 0 ? process.argv[ti + 1] : undefined;
  if (cmd === 'targets') {
    process.stdout.write(JSON.stringify((await targets(scratch)).map((t) => ({ title: t.title, url: t.url.replace(/^file:.*?\/resources\//, 'file:…/resources/') })), null, 2) + '\n');
  } else {
    const page = await connect(scratch, { target });
    try {
      if (cmd === 'eval') process.stdout.write(JSON.stringify(await page.eval(arg), null, 2) + '\n');
      else if (cmd === 'shot') process.stdout.write(`${await page.shot(arg)}\n`);
      else if (cmd === 'text') process.stdout.write(`${await page.eval('document.body.innerText')}\n`);
      else if (cmd === 'mouse') await page.mouse(...arg.split(',').map(Number));
      else if (cmd === 'type') await page.type(arg, { enter: process.argv.includes('--enter') });
      else if (cmd === 'click') process.stdout.write(JSON.stringify(await page.eval(clickExpression(arg))) + '\n');
      else throw new Error(`unknown command ${cmd}`);
    } finally { page.close(); }
  }
}
