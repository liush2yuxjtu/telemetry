import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Generate ephemeral localhost-only TLS material. No static private key is stored.
test('real HTTPS, cross-process dedupe, redirects, deadline and CLI exit', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'telemetry-tls-'));
  let server;
  try {
    execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'], { stdio: 'pipe' });
    const received = []; let mode = 'ok';
    server = createServer({ key: await readFile(join(dir,'key.pem')), cert: await readFile(join(dir,'cert.pem')) }, (req, res) => {
      let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => {
        received.push({ path: req.url, headers: req.headers, body: JSON.parse(body) });
        if (mode === 'stall') return;
        res.writeHead(mode === 'redirect' ? 302 : 204, { location: '/must-not-follow' }); res.end();
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `https://localhost:${server.address().port}/events`;
    const module = new URL('../dist/index.js', import.meta.url).href;
    const run = (action, hold = true, state = 'state', trust = true) => new Promise((resolve, reject) => {
      const code = `import {createTelemetry} from ${JSON.stringify(module)};
      ${hold ? 'const hold = setInterval(() => {}, 1000);' : ''}
      const c = createTelemetry(${JSON.stringify({ package: 'test-package', version: '1.0.0', enabled: true, allowCI: true, collectorPrivacyAcknowledged: true, endpoint, stateDirectory: join(dir,state), timeoutMs: mode === 'stall' ? 100 : 1000 })});
      ${action}
      ${hold ? 'clearInterval(hold);' : ''}`;
      const env = { ...process.env, DO_NOT_TRACK: '0', PI_TELEMETRY_DISABLED: '0' };
      if (trust) env.NODE_EXTRA_CA_CERTS = join(dir,'cert.pem'); else delete env.NODE_EXTRA_CA_CERTS;
      delete env.NODE_TLS_REJECT_UNAUTHORIZED;
      const child = spawn(process.execPath, ['--input-type=module','-e',code], { env });
      let stderr = ''; child.stderr.on('data', b => { stderr += b; });
      const timer = setTimeout(() => { child.kill(); reject(Error('child exceeded 3 seconds')); }, 3000);
      child.on('error', reject); child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error(stderr)); });
    });
    await Promise.all(Array.from({ length: 12 }, () => run('await c.install();')));
    assert.equal(received.length, 1); assert.equal(received[0].body.event, 'install');
    assert.equal(received[0].headers['user-agent'], undefined); assert.equal(received[0].headers.cookie, undefined);
    const id = received[0].body.anonymous_install_id;
    await run('await c.success();'); assert.equal(received.length, 3);
    assert.ok(received.every(x => x.body.anonymous_install_id === id));
    mode = 'redirect'; await run("await c.feedback('positive');"); assert.equal(received.length, 4); assert.ok(received.every(x => x.path === '/events'));
    mode = 'stall'; const start = performance.now(); await run("await c.feedback('neutral');"); assert.ok(performance.now() - start < 1500);
    await run("void c.feedback('negative');", false); // unref socket/timer cannot hold CLI open
    const before = received.length; await run('await c.install();', true, 'untrusted', false); assert.equal(received.length, before);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await rm(dir, { recursive: true, force: true });
  }
});
