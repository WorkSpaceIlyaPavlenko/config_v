import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { daemonPlatform, preflight, seed, volumeNames } from '../tools/docker.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const meta = { name: 'seed-test', dockerHost: 'unix:///dedicated-test/docker.sock' };
const names = volumeNames(meta.name);
const xray = { clients: ['test-device'], privateKey: 'example-test-key-not-a-real-secret' };
const rawXray = Buffer.from(JSON.stringify(xray, null, 4) + '\n');
const caddy = 'vpn.test {\n  tls internal\n  respond "test"\n}\n';

function fakeDaemon({ failValidation } = {}) {
  const volumes = new Map([
    [names.xray, { labels: { 'io.config-v.node': meta.name, 'io.config-v.managed': 'config' }, files: { 'xray.json': Buffer.from('original Xray configuration') } }],
    [names.caddy, { labels: { 'io.config-v.node': meta.name, 'io.config-v.managed': 'config' }, files: { Caddyfile: Buffer.from('original Caddy configuration') } }],
    ['other-application-data', { labels: {}, files: {} }]
  ]);
  const calls = [];
  const events = [];
  const execute = async (_meta, args, options = {}) => {
    assert.equal(_meta.dockerHost, meta.dockerHost);
    calls.push({ args, capture: options.capture, hasInput: options.input !== undefined });
    if (args[0] === 'info') return 'linux/x86_64\n';
    if (args[0] === 'volume') {
      const name = args.at(-1);
      if (args[1] === 'ls') return [...volumes.keys()].join('\n') + '\n';
      if (args[1] === 'create') {
        const labels = {};
        for (let index = 0; index < args.length; index++) {
          if (args[index] === '--label') {
            const [key, value] = args[++index].split('=');
            labels[key] = value;
          }
        }
        volumes.set(name, { labels, files: {} });
        return name;
      }
      if (args[1] === 'inspect') return JSON.stringify([{ Labels: volumes.get(name)?.labels }]);
      if (args[1] === 'rm') {
        assert.equal(volumes.get(name)?.labels['io.config-v.managed'], 'candidate');
        volumes.delete(name);
        events.push('cleanup');
        return name;
      }
    }
    if (args[0] !== 'run') throw new Error('Unexpected fake Docker operation: ' + args.join(' '));
    const mounts = {};
    for (let index = 0; index < args.length; index++) {
      if (args[index] === '--mount') {
        const fields = Object.fromEntries(args[++index].split(',').map(field => field.split('=')));
        mounts[fields.dst] = fields.src;
      }
    }
    if (args.includes('sha256sum')) {
      return sha256(volumes.get(mounts['/xray']).files['xray.json']) + '  /xray/xray.json\n' + sha256(volumes.get(mounts['/caddy']).files.Caddyfile) + '  /caddy/Caddyfile\n';
    }
    if (args.includes('-test')) {
      events.push('validate-xray');
      if (failValidation === 'xray') throw new Error('Parser diagnostic with example-test-key-not-a-real-secret');
      return 'Configuration OK';
    }
    if (args.includes('validate')) {
      events.push('validate-caddy');
      if (failValidation === 'caddy') throw new Error('Invalid Caddy directive');
      return 'Valid configuration';
    }
    if (options.input !== undefined) {
      // Use the platform tar implementation to consume the actual archive sent
      // on stdin. No shell is involved and no credentials enter command args.
      volumes.get(mounts['/xray']).files['xray.json'] = execFileSync('tar', ['-xOf', '-', 'xray.json'], { input: options.input });
      volumes.get(mounts['/caddy']).files.Caddyfile = execFileSync('tar', ['-xOf', '-', 'Caddyfile'], { input: options.input });
      events.push('stage');
      return '';
    }
    if (args.at(-1).includes('owner=$(stat')) return '';
    if (args.at(-1).includes('cp /candidate-xray/xray.json')) {
      volumes.get(mounts['/xray']).files['xray.json'] = volumes.get(mounts['/candidate-xray']).files['xray.json'];
      volumes.get(mounts['/caddy']).files.Caddyfile = volumes.get(mounts['/candidate-caddy']).files.Caddyfile;
      events.push('publish');
      return '';
    }
    throw new Error('Unrecognized fake container');
  };
  return { execute, volumes, calls, events };
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'config-v-seed-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'xray.json'), rawXray, { mode: 0o600 });
  return { directory, bundle: { deployment: meta, xray, caddy } };
}

for (const nativeParser of ['xray', 'caddy']) {
  test(`failed ${nativeParser} validation preserves both active configurations and removes only candidates`, async t => {
    const { directory, bundle } = await fixture(t);
    const daemon = fakeDaemon({ failValidation: nativeParser });
    await assert.rejects(seed(bundle, directory, { execute: daemon.execute }), error => {
      assert.match(error.message, /rejected the candidate configuration; active files were not changed/);
      assert.doesNotMatch(error.message, /example-test-key/);
      return true;
    });
    assert.equal(daemon.volumes.get(names.xray).files['xray.json'].toString(), 'original Xray configuration');
    assert.equal(daemon.volumes.get(names.caddy).files.Caddyfile.toString(), 'original Caddy configuration');
    assert.ok(!daemon.events.includes('publish'));
    assert.deepEqual([...daemon.volumes.keys()].sort(), [names.xray, names.caddy, 'other-application-data'].sort());
    assert.equal(daemon.events.filter(event => event === 'cleanup').length, 2);
    assert.ok(daemon.calls.filter(call => call.args[0] === 'run').every(call => !call.args.some(argument => argument.includes('src=' + names.xray + ',') || argument.includes('src=' + names.caddy + ','))));
  });
}

test('successful seed validates both candidates before publishing and keeps configuration out of arguments', async t => {
  const { directory, bundle } = await fixture(t);
  const daemon = fakeDaemon();
  await seed(bundle, directory, { execute: daemon.execute });
  assert.deepEqual(daemon.events, ['stage', 'validate-xray', 'validate-caddy', 'publish', 'cleanup', 'cleanup']);
  assert.deepEqual(daemon.volumes.get(names.xray).files['xray.json'], rawXray);
  assert.equal(daemon.volumes.get(names.caddy).files.Caddyfile.toString(), caddy);
  const transferred = daemon.calls.filter(call => call.hasInput);
  assert.equal(transferred.length, 1);
  assert.equal(transferred[0].args[transferred[0].args.indexOf('--user') + 1], '65532:65532');
  assert.ok(!transferred[0].args.includes('--cap-add'));
  assert.doesNotMatch(JSON.stringify(daemon.calls), /example-test-key|test-device/);
  assert.ok(daemon.calls.filter(call => call.args.includes('-test') || call.args.includes('validate')).every(call => call.capture));
  assert.ok(daemon.volumes.has('other-application-data'));
});

test('preflight detects changed mounted bytes even when parsed Xray JSON is equivalent', async () => {
  const daemon = fakeDaemon();
  daemon.volumes.get(names.xray).files['xray.json'] = rawXray;
  daemon.volumes.get(names.caddy).files.Caddyfile = Buffer.from(caddy);
  await preflight(meta, { xray: rawXray, caddy }, daemon.execute);
  daemon.volumes.get(names.xray).files['xray.json'] = Buffer.from(JSON.stringify(xray));
  await assert.rejects(preflight(meta, { xray: rawXray, caddy }, daemon.execute), /Mounted configuration differs/);
});

test('preflight rejects a foreign volume instead of reading its contents', async () => {
  const daemon = fakeDaemon();
  daemon.volumes.get(names.xray).labels = {};
  await assert.rejects(preflight(meta, { xray: rawXray, caddy }, daemon.execute), /Refusing an unmanaged configuration volume/);
  assert.ok(daemon.calls.every(call => call.args[0] !== 'run'));
});

test('seed rejects a local file changed after the bundle was loaded before contacting Docker', async t => {
  const { directory, bundle } = await fixture(t);
  await writeFile(join(directory, 'xray.json'), JSON.stringify({ changed: true }));
  const daemon = fakeDaemon();
  await assert.rejects(seed(bundle, directory, { execute: daemon.execute }), /Local Xray configuration changed/);
  assert.equal(daemon.calls.length, 0);
});

test('daemon discovery reports an inaccessible daemon when Docker prints empty info with exit zero', async () => {
  await assert.rejects(daemonPlatform(meta, async () => '/\n'), /Cannot read Docker daemon info; check Colima is running and socket access is permitted/);
});
