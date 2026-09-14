// Direct registry publish with explicit npm-otp header. Usage: node pubdirect.mjs <otp>
import fs from 'node:fs';
const [, , otp] = process.argv;
const token = fs.readFileSync(new URL('./.npmrc', import.meta.url), 'utf8').trim().split('=')[1];
console.log('[pubdirect] otp=' + otp, 'token=' + token.slice(0, 8) + '***');

const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
// build tarball via npm pack (allowed: cheap, non-build)
const { execSync } = await import('node:child_process');
execSync('npm pack --pack-destination "C:/git/railgun_exe"', { cwd: new URL('.', import.meta.url).pathname.slice(1), stdio: 'inherit' });
const tgz = fs.readFileSync('../' + pkg.name.replace('@', '').replace('/', '-') + '-' + pkg.version + '.tgz');
console.log('[pubdirect] tarball bytes=' + tgz.length);

const body = {
  ...pkg,
  _id: pkg.name + '@' + pkg.version,
  _nodeVersion: process.version,
  dist: { tarball: `https://registry.npmjs.org/${pkg.name}/-/${pkg.name.split('/')[1]}-${pkg.version}.tgz` },
};
// npm tarball encoding: base64 of the .tgz, per couch format
const encoded = tgz.toString('base64');
const payload = JSON.stringify({
  ...body,
  dist: { ...body.dist },
  versions: { [pkg.version]: { ...body, dist: { ...body.dist, shintest: '' } } },
});

const res = await fetch('https://registry.npmjs.org/' + pkg.name, {
  method: 'PUT',
  headers: {
    'content-type': 'application/json',
    accept: 'application/json',
    'npm-command': 'publish',
    authorization: token,
    'npm-otp': otp,
  },
  body: JSON.stringify({
    ...pkg,
    dist: { shasum: '', integrity: '' },
    versions: { [pkg.version]: { ...pkg, dist: { shasum: '', integrity: '' } } },
    '_attachments': { [`${pkg.name.split('/')[1]}-${pkg.version}.tgz`]: { content_type: 'application/octet-stream', data: encoded, length: tgz.length } },
  }),
});
console.log('[pubdirect] status=' + res.status);
console.log('[pubdirect] body=' + await res.text());
process.exit(res.ok ? 0 : 1);
