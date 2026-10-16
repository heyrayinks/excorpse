// Two scripted clients play a full DrawRun match against a running server.
// Usage: node dev/drawrun-test.js [port]
const WebSocket = require('ws');
const port = process.argv[2] || 3111;
const url = `ws://localhost:${port}/ws/drawrun`;
const log = (...a) => console.log(...a);
let failures = 0;
const check = (name, ok, extra) => { log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); if (!ok) failures++; };

function client(name) {
  const c = { name, msgs: [], ws: new WebSocket(url) };
  c.ready = new Promise(r => c.ws.on('open', r));
  c.ws.on('message', raw => { const m = JSON.parse(raw); c.msgs.push(m); (c.waiters || []).slice().forEach(w => w(m)); });
  c.send = o => c.ws.send(JSON.stringify(o));
  c.waiters = [];
  c.next = (type, ms = 8000) => new Promise((res, rej) => {
    const hit = c.msgs.find(m => m.type === type && !m._used);
    if (hit) { hit._used = true; return res(hit); }
    const to = setTimeout(() => rej(new Error(name + ' timed out waiting for ' + type)), ms);
    const w = m => { if (m.type === type && !m._used) { m._used = true; clearTimeout(to); c.waiters = c.waiters.filter(x => x !== w); res(m); } };
    c.waiters.push(w);
  });
  return c;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

(async () => {
  const A = client('A'), B = client('B');
  await Promise.all([A.ready, B.ready]);

  A.send({ type: 'create', name: 'Alice', avatar: tinyPng, hbH: 50 });
  const ja = await A.next('joined'); check('create -> joined with code', /^[A-Z0-9]{5}$/.test(ja.code), ja.code);
  B.send({ type: 'join', code: 'ZZZZZ', name: 'Bob' });
  check('bad code rejected', (await B.next('error')).msg.includes('No room'));
  B.send({ type: 'join', code: ja.code.toLowerCase(), name: 'Bob', avatar: tinyPng, hbH: 50 });
  const jb = await B.next('joined');
  const lob = await A.next('lobby'); const lob2 = await A.next('lobby');
  check('both players in lobby', lob2.players.length === 2, lob2.players.map(p => p.name));

  B.send({ type: 'start' }); await sleep(100);
  check('non-host cannot start', !A.msgs.some(m => m.type === 'round'));
  A.send({ type: 'start' });
  const rA = await A.next('round'), rB = await B.next('round');
  check('round 1 roles assigned', rA.runnerId !== rA.builderId && rA.n === 1, { n: rA.n });
  const runner = rA.runnerId === ja.id ? A : B, builder = runner === A ? B : A;
  const runnerRole = runner === A ? 'A' : 'B';
  log('  round 1: runner =', runnerRole);
  await A.next('go'); await B.next('go'); check('go after countdown', true);

  // builder tries to build inside the runner's view -> rejected
  builder.send({ type: 'place', kind: 'wall', x: 300, y: 300 });
  check('wall inside runner view denied', (await builder.next('deny')).reason.includes('open zone'));
  // runner can't build
  runner.send({ type: 'place', kind: 'wall', x: 2000, y: 300 }); await sleep(100);
  check('runner cannot build', !runner.msgs.some(m => m.type === 'obs'));
  // valid wall
  builder.send({ type: 'place', kind: 'wall', x: 1500, y: 300 });
  const o1 = await runner.next('obs'); await builder.next('obs');
  check('valid wall broadcast to both', o1.o.t === 'wall' && o1.o.id === 1, o1.o);
  await sleep(300);
  builder.send({ type: 'place', kind: 'wall', x: 1560, y: 300 });
  check('wall too close denied', (await builder.next('deny')).reason.includes('another obstacle'));
  await sleep(300);
  builder.send({ type: 'gap', x0: 2000, x1: 2300 });
  const g = await runner.next('gap'); check('gap clamped to <=100px', (g.i1 - g.i0) * 4 <= 104, g);
  builder.send({ type: 'sculpt', ax: 2800, sigma: 50, dy: -20 });
  const h = await runner.next('h'); check('sculpt broadcast', h.vals.length > 10, { a: h.a, n: h.vals.length });
  await sleep(300);
  builder.send({ type: 'place', kind: 'bullet', x: 1700, y: 320 });
  const bl = await runner.next('bullet'); check('bullet relayed to runner', bl.x === 1700);
  await sleep(400); const ens = builder.msgs.filter(m => m.type === 'energy'); const en = ens[ens.length - 1]; check('energy reported to builder (spent some)', en && en.e < 100, en && en.e);

  // runner state relays to builder
  runner.send({ type: 'state', px: 500, py: 336, t: 3, crouch: 1, bul: [[900, 320]] });
  const st = await builder.next('state'); check('runner state relayed to builder', st.px === 500 && st.bul.length === 1);
  // cheating: impossible distance ignored
  runner.send({ type: 'state', px: 9e7, py: 336, t: 4 }); await sleep(100);
  // builder cannot send runner messages
  builder.send({ type: 'dead', dist: 5, t: 1, reason: 'x' }); await sleep(100);
  check('builder cannot end the round', !A.msgs.concat(B.msgs).some(m => m.type === 'result'));

  runner.send({ type: 'dead', dist: 520, t: 3.4, reason: 'Hit a wall' });
  const res = await A.next('result'); await B.next('result');
  check('result broadcast', res.dist === 520 && res.round === 1, res);

  // round 2 swaps roles
  const r2 = await A.next('round', 9000); await B.next('round');
  check('round 2 swaps roles', r2.runnerId === rA.builderId && r2.n === 2);
  await A.next('go'); await B.next('go');
  const runner2 = runner === A ? B : A;
  runner2.send({ type: 'state', px: 300, py: 336, t: 2 }); await sleep(50);
  runner2.send({ type: 'dead', dist: 800, t: 5.1, reason: 'Fell into a gap' });
  await A.next('result'); await B.next('result');
  const fin = await A.next('final', 9000); await B.next('final');
  check('final: winner is round-2 runner (800 > 520)', fin.winner === r2.runnerId, fin.rows.map(r => r.dist));

  // rematch -> lobby (host only)
  const host = A;
  host.send({ type: 'rematch' });
  const lob3 = await B.next('lobby'); check('rematch returns to lobby', lob3.phase === 'lobby');

  // mid-game disconnect + rejoin
  A.send({ type: 'start' }); await A.next('round'); await B.next('round');
  const tok = jb.token; B.ws.close(); await sleep(200);
  const B2 = client('B2'); await B2.ready;
  B2.send({ type: 'rejoin', code: ja.code, token: tok });
  await B2.next('joined'); const rr = await B2.next('round');
  check('rejoin restores the round', rr.rejoin === true);

  // flood / garbage doesn't crash the server
  const X = client('X'); await X.ready; X.ws.send('not json'); X.send({ type: 'sculpt', ax: 'NaN' }); X.send({ nope: 1 });
  for (let i = 0; i < 500; i++) X.send({ type: 'state', px: 1 });
  await sleep(200);
  const Y = client('Y'); await Y.ready; Y.send({ type: 'create', name: '<b>Eve</b>\u0001' });
  const jy = await Y.next('joined'); check('server alive after garbage; names sanitised', !!jy.code);
  const ly = await Y.next('lobby'); check('name sanitised', ly.players[0].name === 'bEve/b' || !/[<>]/.test(ly.players[0].name), ly.players[0].name);

  log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('TEST ERROR:', e.message); process.exit(2); });
