// Real-app smoke test over the WebView2 DevTools protocol (Node 24: global fetch + WebSocket).
const port = process.argv[2] ?? '9333';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let target;
for (let i = 0; i < 60 && !target; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    target = list.find((t) => t.type === 'page' && t.url.includes('1460'));
  } catch {
    /* not up yet */
  }
  if (!target) await sleep(500);
}
if (!target) {
  console.log('NO_TARGET');
  process.exit(2);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
const problems = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  } else if (m.method === 'Runtime.exceptionThrown') {
    problems.push(`exception: ${m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text}`);
  } else if (m.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(m.params.type)) {
    problems.push(`console.${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
  } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    problems.push(`log: ${m.params.entry.text} ${m.params.entry.url ?? ''}`);
  }
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;

await send('Runtime.enable');
await send('Log.enable');
await send('Page.reload', { ignoreCache: true });
await sleep(4000);

const key = (code, keyName, mods = {}) => `window.dispatchEvent(new KeyboardEvent('keydown', { code: '${code}', key: '${keyName}', ctrlKey: ${!!mods.ctrl}, shiftKey: ${!!mods.shift}, altKey: false, bubbles: true }))`;
const results = {};
results.shell = await evaluate(`!!document.querySelector('.app-shell')`);
results.title = await evaluate('document.title');
results.statusbar = await evaluate(`document.querySelector('.statusbar')?.innerText.replace(/\\s+/g, ' ').slice(0, 160)`);
results.activity = await evaluate(`[...document.querySelectorAll('.activity-bar [aria-label], .activitybar [aria-label]')].map((b) => b.getAttribute('aria-label')).join(', ')`);
await evaluate(key('KeyP', 'P', { ctrl: true, shift: true }));
await sleep(500);
results.palette = await evaluate(`document.querySelector('.quick-pick__input')?.value + ' | ' + document.querySelectorAll('.quick-pick__item').length + ' items'`);
await evaluate(`(() => { const i = document.querySelector('.quick-pick__input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, '>Show Backups'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await sleep(500);
await evaluate(`document.querySelector('.quick-pick__input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
await sleep(1500);
results.backupsPage = await evaluate(`document.querySelector('.tools-page h1')?.innerText`);
// Run a command by picking the palette entry whose label contains `title` (no reliance on ranking).
async function runFromPalette(title) {
  await evaluate(key('KeyP', 'P', { ctrl: true, shift: true }));
  await sleep(400);
  await evaluate(`(() => { const i = document.querySelector('.quick-pick__input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, '>' + ${JSON.stringify(title)}); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  for (let i = 0; i < 20; i++) {
    const ok = await evaluate(`(() => { const it = [...document.querySelectorAll('.quick-pick__item')].find((x) => x.innerText.includes(${JSON.stringify(title)})); if (!it) return false; it.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return true; })()`);
    if (ok) return true;
    await sleep(150);
  }
  return false;
}
for (const [title, label, wait] of [['About Ivily Center', 'about', 1500], ['Show Ivily Ecosystem', 'ecosystem', 6000], ['Open Keyboard Shortcuts', 'keybindings', 1500]]) {
  const ran = await runFromPalette(title);
  await sleep(wait);
  results[label] = (ran ? '' : 'NOT RUN: ') + (await evaluate(`(document.querySelector('.tools-page h1, .kb-page h1')?.innerText ?? '') + ' / ' + [...document.querySelectorAll('.module-card__head .badge')].map((b) => b.innerText).join(',')`));
}
for (const view of ['Search', 'Run and Debug', 'Extensions', 'Notes']) {
  results[`view:${view}`] = await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === ${JSON.stringify(view)} || x.title === ${JSON.stringify(view)}); if (!b) return 'no button'; b.click(); return 'clicked'; })()`);
  await sleep(700);
  results[`view:${view}`] += ' → ' + (await evaluate(`document.querySelector('.sidebar__header')?.innerText`));
}
console.log(JSON.stringify(results, null, 1));
// The dev server has no favicon; everything else counts.
const real = problems.filter((p) => !/favicon\.ico/.test(p));
console.log(real.length ? `PROBLEMS:\n${real.join('\n')}` : 'NO_PROBLEMS');
ws.close();
process.exit(0);
