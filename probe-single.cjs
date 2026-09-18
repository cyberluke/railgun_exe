const net = require('net');
const fs = require('fs');
const state = JSON.parse(fs.readFileSync('C:/git/new-chat/.railgun/daemon.json', 'utf8'));
console.log('pipe=' + state.pipe, 'pid=' + state.pid);
function frame(msg, body) {
  const b = Buffer.from(body, 'utf8');
  const h = Buffer.alloc(32);
  [0x52, 0x47, 0x4e, 0x32].forEach((x, i) => { h[i] = x; });
  h[4] = 2; h[5] = msg; h.writeUInt32LE(1, 8); h.writeUInt32LE(b.length, 28);
  return Buffer.concat([h, b]);
}
const s = net.connect(state.pipe);
let acc = Buffer.alloc(0);
s.on('data', (c) => {
  acc = Buffer.concat([acc, c]);
  console.log('chunk', c.length, 'acc', acc.length, 'len-field', acc.length >= 32 ? acc.readUInt32LE(28) : '-');
});
s.on('error', (e) => console.log('ERR', e.message));
s.on('close', () => {
  console.log('close total', acc.length);
  if (acc.length >= 32) {
    console.log('msg', acc[5], 'status', acc[7], 'body', acc.subarray(32, Math.min(acc.length, 32 + acc.readUInt32LE(28))).toString('utf8'));
  }
  process.exit(0);
});
s.on('connect', () => s.write(frame(2, JSON.stringify(['packages/feature-chat', '--type-aware', '--type-check', '--agent', '--summary-only', '--quiet']))));
setTimeout(() => { console.log('TIMEOUT acc=' + acc.length); process.exit(0); }, 120000);
