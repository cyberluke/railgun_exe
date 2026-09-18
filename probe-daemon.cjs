const net = require('net');
const fs = require('fs');
const state = JSON.parse(fs.readFileSync('C:/git/new-chat/.railgun/daemon.json', 'utf8'));
function frame(msg, body) {
  const b = Buffer.from(body, 'utf8');
  const h = Buffer.alloc(32);
  [0x52, 0x47, 0x4e, 0x32].forEach((x, i) => { h[i] = x; });
  h[4] = 2; h[5] = msg; h.writeUInt32LE(1, 8); h.writeUInt32LE(b.length, 28);
  return Buffer.concat([h, b]);
}
function one(msg, payload) {
  return new Promise((resolve) => {
    const s = net.connect(state.pipe);
    let acc = Buffer.alloc(0);
    const t0 = Date.now();
    s.on('data', (c) => {
      acc = Buffer.concat([acc, c]);
      if (acc.length >= 32) {
        const len = acc.readUInt32LE(28);
        if (acc.length >= 32 + len) {
          s.destroy();
          resolve({ status: acc[7], gen: Number(acc.readBigUInt64LE(12)), body: acc.subarray(32, 32 + len).toString('utf8'), ms: Date.now() - t0 });
        }
      }
    });
    s.on('error', () => resolve(null));
    s.on('connect', () => s.write(frame(msg, payload)));
    setTimeout(() => { s.destroy(); resolve(null); }, 120000);
  });
}
const ARGS = ['packages/feature-chat', '--type-aware', '--type-check', '--agent', '--summary-only', '--quiet'];
(async () => {
  for (let round = 1; round <= 4; round++) {
    const f = 'C:/git/new-chat/packages/feature-chat/package.json';
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8'));
    const a = await one(2, JSON.stringify(ARGS));
    const inner = ((a && a.body) || '').split('\n')[1] || '';
    console.log(`round ${round}: one-file wall=${a && a.ms}ms status=${a && a.status} gen=${a && a.gen} :: ${inner}`);
    const b = await one(2, JSON.stringify(ARGS));
    console.log(`  replay=${b && b.ms}ms status=${b && b.status} :: ${((b && b.body) || '').split('\n')[1] || ''}`);
  }
})();
