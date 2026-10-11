import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { renderNode, validateNode, saveNode, loadNode, identifier, domain, dockerHost, LOCAL_DOCKER_HOST, clientURI, keyPair, publicFromPrivate, configurationRevision, terraformConfiguration, contentHash, assertPlanMatches } from '../tools/config.mjs';
import { archive, cleanEnvironment } from '../tools/docker.mjs';

const local = () => renderNode({ node: 'local-test', local: true });
test('REALITY keys agree, and separate nodes have separate credentials', async () => {
  const first = await local(); const second = await local();
  assert.equal(validateNode(first), true);
  assert.equal(publicFromPrivate(first.xray.inbounds[0].streamSettings.realitySettings.privateKey), first.deployment.publicKey);
  assert.notEqual(first.deployment.publicKey, second.deployment.publicKey);
  assert.notEqual(first.deployment.clients[0].id, second.deployment.clients[0].id);
  assert.notEqual(first.deployment.shortId, second.deployment.shortId);
});
test('public client URI contains matching parameters but never the server private key', async () => {
  const bundle = await local(); const meta = bundle.deployment;
  const uri = new URL(clientURI(meta, meta.clients[0]));
  assert.equal(uri.protocol, 'vless:');
  assert.equal(uri.username, meta.clients[0].id);
  assert.equal(uri.searchParams.get('pbk'), meta.publicKey);
  assert.equal(uri.searchParams.get('sni'), 'vpn.test');
  assert.equal(uri.searchParams.get('flow'), 'xtls-rprx-vision');
  assert.equal(uri.searchParams.get('sid'), meta.shortId);
  assert.equal(uri.port, '8443');
  assert.equal(uri.href.includes(bundle.xray.inbounds[0].streamSettings.realitySettings.privateKey), false);
});
test('credentials and configs survive a private on-disk round trip', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'config-v-test-'));
  const bundle = await local();
  await saveNode(directory, bundle);
  assert.deepEqual(await loadNode(directory), bundle);
  for (const path of ['deployment.json', 'xray.json', 'Caddyfile', 'clients/device-one.txt', 'clients/device-one.json']) {
    assert.equal((await stat(join(directory, path))).mode & 0o777, 0o600);
  }
  assert.equal((await stat(join(directory, 'clients'))).mode & 0o777, 0o700);
});
test('rejects credential mismatch, debug endpoints and insecure production certificate', async () => {
  const bundle = await local();
  const changed = structuredClone(bundle);
  changed.deployment.publicKey = keyPair().publicKey;
  assert.throws(() => validateNode(changed), /does not match/);
  const debug = structuredClone(bundle); debug.xray.metrics = {};
  assert.throws(() => validateNode(debug), /must remain disabled/);
  const production = structuredClone(bundle); production.deployment.mode = 'production';
  assert.throws(() => validateNode(production), /publicly trusted/);
});
test('production uses own public domain and public certificate issuer', async () => {
  const bundle = await renderNode({ node: 'de-main', domain: 'vpn.example.com', 'docker-host': 'ssh://deploy@vpn.example.com' });
  assert.equal(validateNode(bundle), true);
  assert.equal(bundle.deployment.vpnPort, 443);
  assert.equal(bundle.deployment.httpPort, 80);
  assert.equal(bundle.deployment.bindAddress, '0.0.0.0');
  assert.match(bundle.caddy, /disable_tlsalpn_challenge/);
  assert.doesNotMatch(bundle.caddy, /tls internal/);
});
test('names, hostnames and Docker endpoints cannot inject paths, config or credentials', () => {
  for (const value of ['../other', 'x/y', 'x\nroot', 'x;id', '', '-root']) assert.throws(() => identifier(value));
  for (const value of ['https://vpn.example.com', 'vpn.example.com:443', 'x.example.com\n{ debug }', '127.0.0.1']) assert.throws(() => domain(value));
  for (const value of ['tcp://127.0.0.1:2375', 'unix:///var/run/docker.sock', 'ssh://root:password@example.com', 'ssh://root@example.com/path']) assert.throws(() => dockerHost(value));
  assert.equal(dockerHost(LOCAL_DOCKER_HOST), LOCAL_DOCKER_HOST);
  assert.equal(dockerHost('ssh://deploy@example.com'), 'ssh://deploy@example.com');
});
test('Terraform data includes neither UUID nor key, and uses a separate module per runtime directory', async () => {
  const bundle = await local();
  const revision = configurationRevision(bundle.xray, bundle.caddy);
  const tf = terraformConfiguration(bundle.deployment, revision, 'linux/arm64');
  const content = JSON.stringify(tf);
  for (const secret of [bundle.deployment.clients[0].id, bundle.deployment.publicKey, bundle.xray.inbounds[0].streamSettings.realitySettings.privateKey]) assert.equal(content.includes(secret), false);
  assert.equal(tf.module.node.source, '../../../infra/node');
  assert.equal(tf.module.node.config_revision, revision);
  assert.equal(tf.provider.docker.host, LOCAL_DOCKER_HOST);
  assert.throws(() => terraformConfiguration(bundle.deployment, revision, 'darwin/arm64'));
});
test('archive interoperates with system tar and refuses arbitrary filenames', () => {
  const input = archive({ 'xray.json': 'private fixture\n', Caddyfile: 'server.test {}\n' });
  const output = spawnSync('tar', ['-xOf', '-', 'xray.json'], { input });
  assert.equal(output.status, 0, output.stderr.toString());
  assert.equal(output.stdout.toString(), 'private fixture\n');
  assert.throws(() => archive({ '../secret': 'bad' }));
});
test('deployment CLI does not inherit global Docker contexts or Terraform command overrides', () => {
  const previous = process.env.DOCKER_CONTEXT;
  process.env.DOCKER_CONTEXT = 'unrelated';
  try { assert.equal(cleanEnvironment().DOCKER_CONTEXT, undefined); }
  finally { if (previous === undefined) delete process.env.DOCKER_CONTEXT; else process.env.DOCKER_CONTEXT = previous; }
});
test('private destinations are blocked without depending on optional GeoIP assets', async () => {
  const bundle = await local();
  assert.equal(bundle.xray.routing.domainStrategy, 'IPOnDemand');
  const rules = bundle.xray.routing.rules;
  assert.ok(rules.some(rule => rule.ip?.includes('127.0.0.0/8') && rule.outboundTag === 'blocked'));
  assert.ok(rules.some(rule => rule.ip?.includes('fc00::/7')));
  assert.equal(JSON.stringify(bundle.xray).includes('geoip:'), false);
});

test('saved plans reject changed listening ports, endpoints, source or plan bytes', async () => {
  const bundle = await renderNode({ node: 'de-main', domain: 'vpn.example.com', 'docker-host': 'ssh://deploy@vpn.example.com' });
  const revision = configurationRevision(bundle.xray, bundle.caddy);
  const fingerprint = meta => contentHash(JSON.stringify(terraformConfiguration(meta, revision, 'linux/amd64')));
  const planned = { revision, dockerHost: bundle.deployment.dockerHost, platform: 'linux/amd64', configurationHash: fingerprint(bundle.deployment), sourceHash: contentHash('reviewed source'), planHash: contentHash('reviewed plan') };
  assert.doesNotThrow(() => assertPlanMatches(planned, planned));
  for (const update of [{vpnPort: 8443}, {httpPort: 8080}, {bindAddress: '127.0.0.1'}]) {
    assert.throws(() => assertPlanMatches(planned, {...planned, configurationHash: fingerprint({...bundle.deployment, ...update})}));
  }
  for (const update of [{sourceHash: contentHash('changed source')}, {planHash: contentHash('changed plan')}, {dockerHost: 'ssh://deploy@other.example.com'}, {platform: 'linux/arm64'}]) {
    assert.throws(() => assertPlanMatches(planned, {...planned, ...update}));
  }
});
