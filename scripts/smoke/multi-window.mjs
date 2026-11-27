// Multi-window smoke test over the WebView2 DevTools protocol.
const port = process.argv[2] ?? '9333';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pages = async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).filter((t) => t.type === 'page' && t.url.includes('1460'));

async function connect(target) {
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
    } else if (m.method === 'Runtime.exceptionThrown') problems.push(`exception: ${m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text}`);
    else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') problems.push(`console.error: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
  });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable');
  const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
  return { ws, evaluate, problems };
}

let list = [];
for (let i = 0; i < 60 && !list.length; i++) {
  try { list = await pages(); } catch { /* starting */ }
  if (!list.length) await sleep(500);
}
if (!list.length) { console.log('NO_TARGET'); process.exit(2); }
await sleep(3000);
const main = await connect(list[0]);
await main.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyN', key: 'N', ctrlKey: true, shiftKey: true, bubbles: true }))`);
let second;
for (let i = 0; i < 30 && !second; i++) {
  await sleep(500);
  second = (await pages()).find((p) => p.id !== list[0].id);
}
const out = { windows: (await pages()).length };
if (second) {
  await sleep(3500);
  const w2 = await connect(second);
  out.secondUrl = second.url;
  out.secondPage = await w2.evaluate(`(document.querySelector('.launcher h1, .launcher__title, h1')?.innerText ?? '') + ' | shell=' + !!document.querySelector('.app-shell')`);
  out.secondProblems = w2.problems;
  w2.ws.close();
}
out.mainShell = await main.evaluate(`!!document.querySelector('.app-shell')`);
out.mainProblems = main.problems;
console.log(JSON.stringify(out, null, 1));
main.ws.close();
process.exit(0);
