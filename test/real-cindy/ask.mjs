// Host side: ask a Cindy agent (in the guest, over CDP) to do something, wait until its turn is over, return what it wrote.
//   node test/real-cindy/ask.mjs <scratch> "<prompt>" [--new] [--redact <word>]... [--max-wait <seconds>] [--save <file>]
// --new opens a new dialogue first and sets its approval mode to "完全访问" (Full access), so tool calls are not held for approval.
// --redact removes a word (an account name, an address) from the text before it is printed or saved.
// As a library: `import { ask } from './ask.mjs'`.
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { clickExpression, connect } from './cdp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODES = '默认权限|允许编辑|自动审批|完全访问';

export function scrub(text, words = []) {
  let t = String(text).replace(/[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>');
  for (const w of words) if (w) t = t.split(w).join('<redacted>');
  return t;
}

export async function ask(scratch, prompt, { fresh = false, redact = [], maxWaitS = 240, approve = true } = {}) {
  const page = await connect(scratch);
  try {
    if (fresh) {
      await page.eval(clickExpression('新建'));
      await sleep(2000);
      const mode = await page.eval(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>new RegExp('^(${MODES})$').test((e.innerText||'').trim()));return b?b.innerText.trim():null})()`);
      if (mode && mode !== '完全访问') {
        await page.eval(clickExpression(mode)); await sleep(800); await page.eval(clickExpression('完全访问')); await sleep(800);
      }
    }
    const marker = `[[${Math.random().toString(36).slice(2, 8)}]]`;
    await page.type(`${prompt} ${marker}`, { enter: true });
    const t0 = Date.now(); let idle = 0; let text = '';
    while (Date.now() - t0 < maxWaitS * 1000) {
      await sleep(4000);
      if (approve) await page.eval(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>/^允许一次/.test((e.innerText||'').trim()));if(b){b.click();return true}return false})()`);
      const body = await page.eval('document.body.innerText');
      text = body.slice(body.lastIndexOf(marker) + marker.length);
      const busy = /正在工作|运行中…|等待授权|等待插件设置/.test(text);
      idle = busy ? 0 : idle + 1;
      if (idle >= 3) break;
    }
    const end = text.search(/继续聊一聊…|对话 [0-9a-f]{8}/);
    const out = scrub(end > 0 ? text.slice(0, end) : text, redact).trim();
    return { text: out, seconds: Math.round((Date.now() - t0) / 1000), timedOut: Date.now() - t0 >= maxWaitS * 1000 };
  } finally { page.close(); }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const [scratch, prompt] = argv;
  const all = (flag) => argv.flatMap((a, i) => (a === flag ? [argv[i + 1]] : []));
  const one = (flag) => all(flag)[0];
  const r = await ask(scratch, prompt, { fresh: argv.includes('--new'), redact: all('--redact'), maxWaitS: Number(one('--max-wait') || 240) });
  if (one('--save')) writeFileSync(one('--save'), r.text);
  process.stdout.write(`${r.text}\n--- ${r.seconds}s${r.timedOut ? ' TIMED OUT' : ''}\n`);
}
