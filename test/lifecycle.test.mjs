import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { ROOT, loadNode, configurationRevision, terraformConfiguration, contentHash } from '../tools/config.mjs';
import { readSettings, collectSettings, parseArguments } from '../tools/settings.mjs';
import { initialize, restartNode, withNodeLock } from '../tools/lifecycle.mjs';

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'config-v-lifecycle-'));
  await cp(resolve(ROOT, 'deploy'), resolve(root, 'deploy'), { recursive: true });
  const calls = [];
  const execute = async (cmd, args) => { calls.push({ cmd, args }); return ''; };
  const dependencies = { root, execute, getPlatform: async () => 'linux/arm64', ensureRuntime: async (...args) => calls.push({ runtime: args }), report: () => {} };
  return { root, calls, dependencies };
}
const actions = calls => calls.filter(call => call.args?.[0]?.endsWith('vpn.mjs')).map(call => call.args[1]);

test('env is data, CLI overrides environment, and explicit missing env file fails', async () => {
  const { root } = await fixture();
  await writeFile(resolve(root, '.env'), 'VPN_NODE=from-file\nVPN_MODE=production\nVPN_DOMAIN="$(echo should-not-run).example.com"\nVPN_PORT=443\nVPN_DNS_SERVERS=\n');
  const { options } = await readSettings(['--node', 'from-cli', '--local'], { root, env: { VPN_NODE: 'from-env', VPN_PORT: '8443' } });
  assert.equal(options.node, 'from-cli');
  assert.equal(options.local, true);
  assert.equal(options.port, '8443');
  assert.equal(options.domain, '$(echo should-not-run).example.com');
  assert.equal(options['dns-servers'], '');
  await assert.rejects(readSettings(['--env-file', 'absent'], { root, env: {} }), /ENOENT/);
  await assert.rejects(readSettings([], { root, env: { VPN_DNS_SERVER: '1.1.1.1' } }), /Unknown VPN_/);
});

test('existing node can resume without repeating required settings; no-TTY missing production input fails', async () => {
  const options = await collectSettings({ node: 'saved' }, { exists: async name => name === 'saved' });
  assert.deepEqual(options, { node: 'saved' });
  await assert.rejects(collectSettings({ node: 'new' }, { exists: async () => false }), /Choose --local/);
  await assert.rejects(collectSettings({ node: 'new', local: false }, { exists: async () => false }), /requires/);
  assert.throws(() => parseArguments(['--node', 'one', '--node', 'two']), /repeated/);
  assert.throws(() => parseArguments(['--domain', 'other.example.com'], 'restart'), /restart accepts/);
});

test('prepare-only performs no infrastructure calls and preserves credentials during repeat configuration', async () => {
  const { root, calls, dependencies } = await fixture();
  await initialize({ node: 'test', local: true }, { 'prepare-only': true }, dependencies);
  const original = await loadNode(resolve(root, 'runtime/test'));
  await initialize({ node: 'test', port: '9443', 'xray-memory-mb': '512' }, { 'prepare-only': true }, dependencies);
  const updated = await loadNode(resolve(root, 'runtime/test'));
  assert.deepEqual(updated.deployment.clients, original.deployment.clients);
  assert.equal(updated.xray.inbounds[0].streamSettings.realitySettings.privateKey, original.xray.inbounds[0].streamSettings.realitySettings.privateKey);
  assert.equal(updated.deployment.vpnPort, 9443);
  assert.equal(updated.deployment.xrayMemoryMb, 512);
  assert.deepEqual(actions(calls), ['validate', 'validate']);
  assert.equal(calls.some(call => call.runtime || ['docker', 'terraform', 'colima'].includes(call.cmd)), false);
});

test('init executes all phases in order; plan-only stops before apply; a failure prevents subsequent phases', async () => {
  const full = await fixture();
  await initialize({ node: 'test', local: true }, {}, full.dependencies);
  assert.deepEqual(actions(full.calls), ['validate', 'seed', 'plan', 'apply', 'status']);
  assert.ok(full.calls.at(-1).args[0].endsWith('smoke.mjs'));
  const preview = await fixture();
  await initialize({ node: 'test', local: true }, { 'plan-only': true }, preview.dependencies);
  assert.deepEqual(actions(preview.calls), ['validate', 'seed', 'plan']);
  const failed = await fixture();
  const execute = async (cmd, args) => {
    failed.calls.push({ cmd, args });
    if (args[0]?.endsWith('vpn.mjs') && args[1] === 'seed') throw new Error('seed failed');
  };
  await assert.rejects(initialize({ node: 'test', local: true }, {}, { ...failed.dependencies, execute }), /seed failed/);
  assert.deepEqual(actions(failed.calls), ['validate', 'seed']);
  await initialize({ node: 'test' }, { 'prepare-only': true }, failed.dependencies); // failure released lock
});

test('production goes only to the configured daemon and does not start a local VM', async () => {
  const { calls, dependencies } = await fixture();
  let endpoint;
  await initialize({ node: 'de-main', domain: 'connect.example.com', 'docker-host': 'ssh://deploy@server.example.com' }, {}, {
    ...dependencies, getPlatform: async meta => { endpoint = meta.dockerHost; return 'linux/amd64'; }
  });
  assert.equal(endpoint, 'ssh://deploy@server.example.com');
  assert.equal(calls.some(call => call.runtime), false);
  assert.equal(calls.some(call => call.args?.[0]?.endsWith('smoke.mjs')), false);
});

test('VM hostname and DNS persist for local init and are rejected for production before files are generated', async () => {
  const local = await fixture();
  await initialize({ node: 'test', local: true, 'vm-hostname': 'family-vm', 'vm-dns-servers': '1.1.1.1,9.9.9.9' }, {}, local.dependencies);
  assert.deepEqual(local.calls.find(call => call.runtime).runtime[1].vmOptions, { hostname: 'family-vm', dnsServers: ['1.1.1.1', '9.9.9.9'] });
  const production = await fixture();
  await assert.rejects(initialize({ node: 'test', domain: 'connect.example.com', 'docker-host': 'ssh://deploy@server.example.com', 'vm-hostname': 'bad' }, { 'prepare-only': true }, production.dependencies), /only to local Colima/);
  await assert.rejects(readFile(resolve(production.root, 'runtime/test/deployment.json')), /ENOENT/);
});

test('lifecycle lock prevents concurrent operations on one node', async () => {
  const { root } = await fixture();
  await withNodeLock(root, 'test', async () => {
    await assert.rejects(withNodeLock(root, 'test', async () => assert.fail('must not run')), /Another lifecycle operation/);
  });
});

async function deployed() {
  const fixtureData = await fixture();
  await initialize({ node: 'test', local: true }, { 'prepare-only': true }, fixtureData.dependencies);
  const directory = resolve(fixtureData.root, 'runtime/test');
  const bundle = await loadNode(directory);
  const revision = configurationRevision(bundle.xray, bundle.caddy);
  const dockerHost = bundle.deployment.dockerHost;
  const configurationHash = contentHash(JSON.stringify(terraformConfiguration(bundle.deployment, revision, 'linux/arm64'), null, 2) + '\n');
  await writeFile(resolve(directory, 'seeded.json'), JSON.stringify({ revision, dockerHost }));
  await writeFile(resolve(directory, 'applied.json'), JSON.stringify({ revision, dockerHost, configurationHash, platform: 'linux/arm64' }));
  return { ...fixtureData, directory, bundle };
}
function fakeDocker(calls, { wrongLabel = false, missingXray = false } = {}) {
  return async (meta, args) => {
    calls.push({ meta, args });
    if (args[0] === 'restart') return '';
    if (args.includes('--format')) return JSON.stringify({ Status: 'running' });
    const service = args.at(-1).endsWith('xray') ? 'xray' : 'caddy';
    if (service === 'xray' && missingXray) throw new Error('missing xray');
    return JSON.stringify([{ Id: (service === 'xray' ? 'a' : 'b').repeat(64), Name: '/config-v-test-' + service, Config: { Labels: { 'io.config-v.node': wrongLabel ? 'other' : 'test' } } }]);
  };
}
test('restart scopes select exact owned container IDs, preserving settings and key bytes', async () => {
  const { root, directory } = await deployed();
  const before = await readFile(resolve(directory, 'xray.json'));
  for (const [target, ids] of [['vpn', ['a'.repeat(64)]], ['client', ['b'.repeat(64)]], ['all', ['b'.repeat(64), 'a'.repeat(64)]]]) {
    const calls = [];
    await restartNode('test', { root, target, executeDocker: fakeDocker(calls), verify: async () => {}, report: () => {} });
    assert.deepEqual(calls.filter(call => call.args[0] === 'restart').map(call => call.args.at(-1)), ids);
    assert.ok(calls.every(call => call.meta.name === 'test'));
  }
  assert.deepEqual(await readFile(resolve(directory, 'xray.json')), before);
});
test('restart refuses unknown ownership, partial all targets, missing backend and configuration drift', async () => {
  const { root, directory } = await deployed();
  for (const settings of [{ wrongLabel: true }, { missingXray: true }]) {
    const calls = [];
    await assert.rejects(restartNode('test', { root, executeDocker: fakeDocker(calls, settings), verify: async () => {}, report: () => {} }));
    assert.equal(calls.some(call => call.args[0] === 'restart'), false);
  }
  await assert.rejects(restartNode('test', { root, target: 'back' }), /No persistent API backend/);
  const meta = JSON.parse(await readFile(resolve(directory, 'deployment.json')));
  meta.xrayMemoryMb = 512;
  await writeFile(resolve(directory, 'deployment.json'), JSON.stringify(meta));
  const calls = [];
  await assert.rejects(restartNode('test', { root, executeDocker: fakeDocker(calls) }), /last successful apply/);
  assert.equal(calls.length, 0);
});
