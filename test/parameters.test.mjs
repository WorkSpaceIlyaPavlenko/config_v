import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderNode, reconfigureNode, validateNode, saveNode, loadNode, terraformConfiguration, configurationRevision, clientURI, LOCAL_DOCKER_HOST } from '../tools/config.mjs';

const production = options => renderNode({ node: 'de-main', domain: 'vpn.example.com', 'docker-host': 'ssh://deploy@server.example.com', ...options });

test('explicit network and resource options reach the Terraform module without client credentials', async () => {
  const bundle = await production({
    address: '203.0.113.20', port: '9443', 'http-port': '8080', 'bind-address': '192.0.2.10',
    'dns-servers': '1.1.1.1, 2606:4700:4700::1111',
    'xray-memory-mb': '512', 'caddy-memory-mb': '256', 'xray-cpus': '1.5', 'caddy-cpus': '0.75'
  });
  const tf = terraformConfiguration(bundle.deployment, configurationRevision(bundle.xray, bundle.caddy), 'linux/amd64');
  const node = tf.module.node;
  assert.equal(node.bind_address, '192.0.2.10');
  assert.equal(node.vpn_port, 9443);
  assert.equal(node.http_port, 8080);
  assert.deepEqual(node.dns_servers, ['1.1.1.1', '2606:4700:4700::1111']);
  assert.equal(node.xray_memory_mb, 512);
  assert.equal(node.caddy_memory_mb, 256);
  assert.equal(node.xray_cpus, 1.5);
  assert.equal(node.caddy_cpus, 0.75);
  const uri = new URL(clientURI(bundle.deployment, bundle.deployment.clients[0]));
  assert.equal(uri.hostname, '203.0.113.20');
  assert.equal(uri.port, '9443');
  assert.equal(uri.searchParams.get('sni'), 'vpn.example.com');
  const serialized = JSON.stringify(tf);
  for (const credential of [bundle.deployment.clients[0].id, bundle.deployment.shortId, bundle.deployment.publicKey, bundle.xray.inbounds[0].streamSettings.realitySettings.privateKey]) assert.equal(serialized.includes(credential), false);
});

test('reconfiguration preserves every client and REALITY credential while updating all generated connection details', async () => {
  const original = await production();
  const extra = { name: 'phone-two', id: randomUUID() };
  original.deployment.clients.push(extra);
  original.xray.inbounds[0].settings.clients.push({ id: extra.id, flow: 'xtls-rprx-vision' });
  const snapshot = structuredClone(original);
  const changed = await reconfigureNode(original, { domain: 'new.example.com', address: '203.0.113.30', port: '8443', 'http-port': '8080', 'dns-servers': '9.9.9.9', 'xray-memory-mb': '768' });
  assert.deepEqual(original, snapshot, 'input bundle must not be modified');
  assert.deepEqual(changed.deployment.clients, original.deployment.clients);
  assert.equal(changed.deployment.publicKey, original.deployment.publicKey);
  assert.equal(changed.deployment.shortId, original.deployment.shortId);
  assert.equal(changed.xray.inbounds[0].streamSettings.realitySettings.privateKey, original.xray.inbounds[0].streamSettings.realitySettings.privateKey);
  assert.deepEqual(changed.xray.inbounds[0].settings.clients, original.xray.inbounds[0].settings.clients);
  assert.deepEqual(changed.xray.inbounds[0].streamSettings.realitySettings.serverNames, ['new.example.com']);
  assert.match(changed.caddy, /new\.example\.com \{/);
  assert.doesNotMatch(changed.caddy, /vpn\.example\.com/);
  assert.equal(changed.deployment.xrayMemoryMb, 768);
  assert.equal(changed.deployment.caddyMemoryMb, 128);
  const directory = await mkdtemp(join(tmpdir(), 'config-v-reconfigure-'));
  await saveNode(directory, changed);
  assert.deepEqual(await loadNode(directory), changed);
  for (const client of changed.deployment.clients) {
    const uri = new URL((await readFile(join(directory, 'clients', client.name + '.txt'), 'utf8')).trim());
    assert.equal(uri.username, client.id);
    assert.equal(uri.hostname, '203.0.113.30');
    assert.equal(uri.port, '8443');
    assert.equal(uri.searchParams.get('sni'), 'new.example.com');
  }
});

test('repeating configuration is stable and changing node identity requires separate state', async () => {
  const original = await production();
  const repeated = await reconfigureNode(original, { node: 'de-main', local: false, 'docker-host': original.deployment.dockerHost, client: original.deployment.clients[0].name });
  assert.deepEqual(repeated, original);
  for (const options of [{ node: 'de-other' }, { local: true }, { local: 'false' }, { 'docker-host': 'ssh://deploy@other.example.com' }, { 'docker-host': LOCAL_DOCKER_HOST }]) {
    await assert.rejects(reconfigureNode(original, options), /new node directory/);
  }
  await assert.rejects(reconfigureNode(original, { client: 'replacement' }), /add-client/);
});

test('local mode cannot expose its ports or target a remote Docker daemon', async () => {
  await assert.rejects(renderNode({ node: 'local', local: true, 'bind-address': '0.0.0.0' }), /Colima loopback/);
  await assert.rejects(renderNode({ node: 'local', local: true, 'docker-host': 'ssh://deploy@server.example.com' }), /Colima loopback/);
  await assert.rejects(production({ 'docker-host': LOCAL_DOCKER_HOST }), /remote SSH/);
  const local = await renderNode({ node: 'local', local: true });
  await assert.rejects(reconfigureNode(local, { 'bind-address': '192.0.2.10' }), /Colima loopback/);
});

test('invalid resolver addresses, resource limits and listening values fail before deployment', async () => {
  for (const value of ['https://1.1.1.1', 'dns.example.com', '1.1.1.1:53', '1.1.1.1,', '1.1.1.1/32', 'fe80::1%en0']) await assert.rejects(production({ 'dns-servers': value }), /DNS servers/);
  for (const option of ['xray-memory-mb', 'caddy-memory-mb']) {
    for (const value of ['63', '-1', '64.5', 'Infinity', 'NaN', '', true]) await assert.rejects(production({ [option]: value }), /[Mm]emory/);
  }
  for (const option of ['xray-cpus', 'caddy-cpus']) {
    for (const value of ['0', '-1', 'Infinity', 'NaN', '', true]) await assert.rejects(production({ [option]: value }), /CPU/);
  }
  for (const option of ['port', 'http-port']) {
    for (const value of ['0', '-1', '65536', '443.5', '', true]) await assert.rejects(production({ [option]: value }), /port/);
  }
  await assert.rejects(production({ port: '80' }), /must differ/);
  await assert.rejects(production({ 'bind-address': 'vpn.example.com' }), /IPv4/);
  for (const value of ['vpn.test', 'vpn.localhost', 'vpn.invalid', 'vpn.local', 'vpn.example', 'vpn.home.arpa']) await assert.rejects(production({ domain: value }), /public domain/);
});

test('older saved deployments receive compatible defaults without regenerating credentials', async () => {
  const original = await production();
  const directory = await mkdtemp(join(tmpdir(), 'config-v-legacy-'));
  await saveNode(directory, original);
  const legacy = structuredClone(original);
  for (const key of ['dnsServers', 'xrayMemoryMb', 'caddyMemoryMb', 'xrayCpus', 'caddyCpus']) delete legacy.deployment[key];
  assert.equal(validateNode(legacy), true);
  await writeFile(join(directory, 'deployment.json'), JSON.stringify(legacy.deployment), { mode: 0o600 });
  assert.deepEqual(await loadNode(directory), original);
  const inputs = terraformConfiguration(legacy.deployment, 'initial', 'linux/amd64').module.node;
  assert.deepEqual(inputs.dns_servers, []);
  assert.equal(inputs.xray_memory_mb, 256);
  assert.equal(inputs.caddy_memory_mb, 128);
  assert.equal(inputs.xray_cpus, 1);
  assert.equal(inputs.caddy_cpus, 0.5);
  const changed = await reconfigureNode(legacy, { 'dns-servers': '1.1.1.1,1.1.1.1' });
  assert.deepEqual(changed.deployment.dnsServers, ['1.1.1.1']);
  const reset = await reconfigureNode(changed, { 'dns-servers': '' });
  assert.deepEqual(reset.deployment.dnsServers, []);
  assert.deepEqual(reset.deployment.clients, original.deployment.clients);
});
