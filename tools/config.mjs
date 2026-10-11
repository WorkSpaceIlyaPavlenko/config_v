import { generateKeyPairSync, createPrivateKey, createPublicKey, randomUUID, randomBytes, createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { domainToASCII, fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { readFile, writeFile, mkdir, rename, chmod, lstat } from 'node:fs/promises';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const XRAY_IMAGE = 'ghcr.io/xtls/xray-core:26.3.27@sha256:592ec4d11f656db95598d01e76dbcc6e002d67360b96a5436500a938230f52c7';
export const HELPER_IMAGE = 'busybox:1.37.0';
export const LOCAL_DOCKER_HOST = 'unix://' + homedir() + '/.colima/config-v/docker.sock';

export function identifier(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(value)) throw new Error('Use a name beginning with a lowercase letter, with at most 32 letters, digits or hyphens');
  return value;
}
export function domain(value) {
  if (typeof value !== 'string') throw new Error('Set --domain to a domain you control');
  const normalized = domainToASCII(value.toLowerCase());
  if (!normalized || normalized.length > 253 || isIP(normalized) || !normalized.includes('.') || normalized.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new Error('Invalid domain; enter a hostname without a scheme, path or port');
  return normalized;
}
export function serverAddress(value) {
  if (isIP(value)) return value;
  return domain(value);
}
export function dockerHost(value) {
  if (value === LOCAL_DOCKER_HOST) return value;
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('Invalid Docker endpoint'); }
  if (parsed.protocol !== 'ssh:' || !parsed.username || parsed.password || !parsed.hostname || parsed.search || parsed.hash || !['', '/'].includes(parsed.pathname)) throw new Error('Use the dedicated Colima socket or an explicit ssh://user@host Docker endpoint; TCP APIs are not accepted');
  if (!/^[a-zA-Z0-9._-]+$/.test(parsed.username)) throw new Error('Invalid SSH user');
  return value;
}
function port(value) {
  if (!['string', 'number'].includes(typeof value) || String(value).trim() === '') throw new Error('Invalid port');
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 65535) throw new Error('Invalid port');
  return number;
}
const resourceDefaults = Object.freeze({ dnsServers: [], xrayMemoryMb: 256, caddyMemoryMb: 128, xrayCpus: 1, caddyCpus: 0.5 });
const supplied = (options, key) => Object.hasOwn(options, key) && options[key] !== undefined;
function publicDomain(value) {
  const normalized = domain(value);
  if (/\.(?:test|localhost|invalid|local|internal|example|onion)$/.test(normalized) || normalized === 'home.arpa' || normalized.endsWith('.home.arpa') || !/\.(?:[a-z]{2,}|xn--[a-z0-9-]+)$/.test(normalized)) throw new Error('Production needs a real public domain you control');
  return normalized;
}
function bindAddress(value) {
  if (typeof value !== 'string' || isIP(value) !== 4) throw new Error('Bind address must be an IPv4 literal');
  return value;
}
function dnsServers(value) {
  const addresses = Array.isArray(value) ? [...value] : typeof value === 'string' ? value.trim() === '' ? [] : value.split(',').map(item => item.trim()) : null;
  if (!addresses || addresses.some(address => typeof address !== 'string' || !isIP(address) || address.includes('%'))) throw new Error('DNS servers must be comma-separated IPv4 or IPv6 literals');
  return [...new Set(addresses)];
}
function resourceLimit(value, type) {
  if (!['string', 'number'].includes(typeof value) || String(value).trim() === '') throw new Error('Invalid ' + type + ' limit');
  const number = Number(value);
  if (!Number.isFinite(number) || (type === 'memory' ? !Number.isSafeInteger(number) || number < 64 : number <= 0)) throw new Error(type === 'memory' ? 'Memory limits must be integer MiB values of at least 64' : 'CPU limits must be finite positive numbers');
  return number;
}
function resources(meta) {
  const setting = key => meta[key] === undefined ? resourceDefaults[key] : meta[key];
  return {
    dnsServers: dnsServers(setting('dnsServers')),
    xrayMemoryMb: resourceLimit(setting('xrayMemoryMb'), 'memory'),
    caddyMemoryMb: resourceLimit(setting('caddyMemoryMb'), 'memory'),
    xrayCpus: resourceLimit(setting('xrayCpus'), 'CPU'),
    caddyCpus: resourceLimit(setting('caddyCpus'), 'CPU')
  };
}
function updateDeployment(meta, options) {
  const updated = { ...meta, ...resources(meta) };
  if (supplied(options, 'domain')) updated.domain = domain(options.domain);
  if (supplied(options, 'address')) updated.address = serverAddress(options.address);
  if (supplied(options, 'port')) updated.vpnPort = port(options.port);
  if (supplied(options, 'http-port')) updated.httpPort = port(options['http-port']);
  if (supplied(options, 'bind-address')) updated.bindAddress = bindAddress(options['bind-address']);
  if (supplied(options, 'dns-servers')) updated.dnsServers = dnsServers(options['dns-servers']);
  for (const [option, field, type] of [
    ['xray-memory-mb', 'xrayMemoryMb', 'memory'], ['caddy-memory-mb', 'caddyMemoryMb', 'memory'],
    ['xray-cpus', 'xrayCpus', 'CPU'], ['caddy-cpus', 'caddyCpus', 'CPU']
  ]) if (supplied(options, option)) updated[field] = resourceLimit(options[option], type);
  return updated;
}
async function renderCaddy(meta, templateRoot) {
  const filename = 'Caddyfile.' + meta.mode + '.example';
  return (await readFile(resolve(templateRoot, 'deploy/templates', filename), 'utf8')).replaceAll('REPLACE_DOMAIN', meta.domain);
}
export function keyPair() {
  const pair = generateKeyPairSync('x25519');
  return { privateKey: pair.privateKey.export({ format: 'jwk' }).d, publicKey: pair.publicKey.export({ format: 'jwk' }).x };
}
export function publicFromPrivate(privateKey) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(privateKey)) throw new Error('Invalid private key');
  const key = createPrivateKey({ format: 'jwk', key: { kty: 'OKP', crv: 'X25519', d: privateKey, x: Buffer.alloc(32).toString('base64url') } });
  return createPublicKey(key).export({ format: 'jwk' }).x;
}
export function contentHash(content) {
  return createHash('sha256').update(content).digest('hex');
}
export function configurationRevision(xray, caddy) {
  return createHash('sha256').update(JSON.stringify(xray)).update('\n').update(caddy).digest('hex');
}
export function clientURI(deployment, client) {
  const address = isIP(deployment.address) === 6 ? '[' + deployment.address + ']' : deployment.address;
  const query = new URLSearchParams({ encryption: 'none', security: 'reality', type: 'tcp', flow: 'xtls-rprx-vision', sni: deployment.domain, fp: 'chrome', pbk: deployment.publicKey, sid: deployment.shortId, spx: '/' });
  return 'vless://' + client.id + '@' + address + ':' + deployment.vpnPort + '?' + query + '#' + encodeURIComponent(deployment.name + '-' + client.name);
}
export function clientConfig(deployment, client) {
  return {
    log: { access: 'none', loglevel: 'warning' },
    inbounds: [{ tag: 'local-socks', listen: '127.0.0.1', port: 1080, protocol: 'socks', settings: { udp: true } }],
    outbounds: [{ protocol: 'vless', settings: { vnext: [{ address: deployment.address, port: deployment.vpnPort, users: [{ id: client.id, encryption: 'none', flow: 'xtls-rprx-vision' }] }] }, streamSettings: { network: 'raw', security: 'reality', realitySettings: { serverName: deployment.domain, fingerprint: 'chrome', publicKey: deployment.publicKey, shortId: deployment.shortId, spiderX: '/' } } }]
  };
}
export async function renderNode(options, templateRoot = ROOT) {
  if (supplied(options, 'local') && typeof options.local !== 'boolean') throw new Error('Local mode must be a boolean');
  const local = options.local === true;
  if (!local && !options['docker-host']) throw new Error('Set an explicit --docker-host ssh://user@host for production');
  const keys = keyPair();
  let deployment = {
    version: 1, name: identifier(options.node), mode: local ? 'local' : 'production',
    domain: domain(options.domain || (local ? 'vpn.test' : undefined)),
    address: '', bindAddress: local ? '127.0.0.1' : '0.0.0.0',
    vpnPort: local ? 8443 : 443, httpPort: local ? 8080 : 80,
    dockerHost: dockerHost(options['docker-host'] ?? LOCAL_DOCKER_HOST),
    publicKey: keys.publicKey, shortId: randomBytes(8).toString('hex'),
    clients: [{ name: identifier(options.client || 'device-one'), id: randomUUID() }]
  };
  deployment.address = serverAddress(options.address || (local ? '127.0.0.1' : deployment.domain));
  deployment = updateDeployment(deployment, options);
  const xray = JSON.parse(await readFile(resolve(templateRoot, 'deploy/templates/xray.example.json'), 'utf8'));
  const inbound = xray.inbounds[0];
  inbound.settings.clients = deployment.clients.map(client => ({ id: client.id, flow: 'xtls-rprx-vision' }));
  Object.assign(inbound.streamSettings.realitySettings, { serverNames: [deployment.domain], privateKey: keys.privateKey, shortIds: [deployment.shortId] });
  const bundle = { deployment, xray, caddy: await renderCaddy(deployment, templateRoot) };
  validateNode(bundle);
  return bundle;
}
export async function reconfigureNode(bundle, options, templateRoot = ROOT) {
  validateNode(bundle);
  const meta = bundle.deployment;
  if (supplied(options, 'node') && identifier(options.node) !== meta.name) throw new Error('Use a new node directory to change its name');
  if (supplied(options, 'local') && (typeof options.local !== 'boolean' || options.local !== (meta.mode === 'local'))) throw new Error('Use a new node directory to change local/production mode');
  if (supplied(options, 'docker-host') && dockerHost(options['docker-host']) !== meta.dockerHost) throw new Error('Use a new node directory to change the Docker endpoint; Terraform state belongs to its original daemon');
  if (supplied(options, 'client') && options.client !== meta.clients[0].name) throw new Error('Existing clients are preserved; use add-client to create a device');
  const updated = structuredClone(bundle);
  updated.deployment = updateDeployment(updated.deployment, options);
  updated.xray.inbounds[0].streamSettings.realitySettings.serverNames = [updated.deployment.domain];
  updated.caddy = await renderCaddy(updated.deployment, templateRoot);
  validateNode(updated);
  return updated;
}
export function validateNode(bundle) {
  const { deployment: meta, xray, caddy } = bundle;
  identifier(meta.name);
  if (meta.version !== 1 || !['local', 'production'].includes(meta.mode)) throw new Error('Unsupported deployment format');
  domain(meta.domain); serverAddress(meta.address); dockerHost(meta.dockerHost); port(meta.vpnPort); port(meta.httpPort);
  bindAddress(meta.bindAddress); resources(meta);
  if (meta.vpnPort === meta.httpPort) throw new Error('HTTP and VPN ports must differ');
  if (meta.mode === 'local' && (meta.bindAddress !== '127.0.0.1' || meta.dockerHost !== LOCAL_DOCKER_HOST)) throw new Error('Local mode must stay on the dedicated Colima loopback endpoint');
  const inbound = xray.inbounds?.[0];
  const reality = inbound?.streamSettings?.realitySettings;
  if (xray.inbounds.length !== 1 || inbound.protocol !== 'vless' || inbound.port !== 8443 || inbound.settings.decryption !== 'none' || inbound.streamSettings.security !== 'reality' || reality?.target !== 'caddy:8443') throw new Error('Unexpected server transport configuration');
  if (publicFromPrivate(reality.privateKey) !== meta.publicKey) throw new Error('Server private key does not match the client public key');
  if (!/^[a-f0-9]{16}$/.test(meta.shortId) || JSON.stringify(reality.shortIds) !== JSON.stringify([meta.shortId]) || JSON.stringify(reality.serverNames) !== JSON.stringify([meta.domain])) throw new Error('REALITY client and server parameters differ');
  const names = new Set(); const ids = new Set();
  if (!Array.isArray(meta.clients) || meta.clients.length === 0) throw new Error('At least one client is required');
  for (const client of meta.clients) {
    identifier(client.name);
    if (names.has(client.name) || ids.has(client.id) || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(client.id)) throw new Error('Invalid or duplicate client credentials');
    names.add(client.name); ids.add(client.id);
  }
  if (JSON.stringify(inbound.settings.clients) !== JSON.stringify(meta.clients.map(client => ({ id: client.id, flow: 'xtls-rprx-vision' })))) throw new Error('Client manifest does not match the Xray user list');
  if (xray.api || xray.metrics || xray.stats || xray.log.access !== 'none' || reality.show !== false) throw new Error('Public APIs, metrics and access logs must remain disabled in this initial configuration');
  if (!caddy.includes(meta.domain + ' {') || caddy.includes('REPLACE_') || JSON.stringify(xray).includes('REPLACE_')) throw new Error('Unresolved configuration placeholders');
  if (meta.mode === 'production' && caddy.includes('tls internal')) throw new Error('Production must use a publicly trusted TLS certificate');
  if (meta.mode === 'production') {
    publicDomain(meta.domain);
    if (meta.dockerHost === LOCAL_DOCKER_HOST) throw new Error('Production requires a remote SSH Docker endpoint; the local Colima endpoint is only for local mode');
  }
  return true;
}
export async function secureDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (!(await lstat(path)).isDirectory()) throw new Error('Runtime path must be a real directory');
  await chmod(path, 0o700);
}
export async function writePrivate(path, content) {
  const temporary = path + '.tmp-' + randomBytes(6).toString('hex');
  await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}
const stringify = value => JSON.stringify(value, null, 2) + '\n';
export async function saveNode(directory, bundle) {
  validateNode(bundle);
  await secureDirectory(resolve(directory, 'clients'));
  await writePrivate(resolve(directory, 'deployment.json'), stringify(bundle.deployment));
  await writePrivate(resolve(directory, 'xray.json'), stringify(bundle.xray));
  await writePrivate(resolve(directory, 'Caddyfile'), bundle.caddy);
  for (const client of bundle.deployment.clients) {
    await writePrivate(resolve(directory, 'clients', client.name + '.txt'), clientURI(bundle.deployment, client) + '\n');
    await writePrivate(resolve(directory, 'clients', client.name + '.json'), stringify(clientConfig(bundle.deployment, client)));
  }
}
export async function loadNode(directory) {
  const bundle = {
    deployment: JSON.parse(await readFile(resolve(directory, 'deployment.json'), 'utf8')),
    xray: JSON.parse(await readFile(resolve(directory, 'xray.json'), 'utf8')),
    caddy: await readFile(resolve(directory, 'Caddyfile'), 'utf8')
  };
  Object.assign(bundle.deployment, resources(bundle.deployment));
  validateNode(bundle);
  return bundle;
}
export function terraformConfiguration(meta, revision, platform) {
  if (!['linux/amd64', 'linux/arm64'].includes(platform)) throw new Error('Unsupported Docker daemon architecture');
  const limits = resources(meta);
  return {
    terraform: { required_version: '>= 1.6.0, < 2.0.0', required_providers: { docker: { source: 'kreuzwerker/docker', version: '4.6.0' } } },
    provider: { docker: { host: dockerHost(meta.dockerHost) } },
    module: { node: { source: '../../../infra/node', node_name: meta.name, bind_address: meta.bindAddress, vpn_port: meta.vpnPort, http_port: meta.httpPort, image_platform: platform, config_revision: revision, dns_servers: limits.dnsServers, xray_memory_mb: limits.xrayMemoryMb, caddy_memory_mb: limits.caddyMemoryMb, xray_cpus: limits.xrayCpus, caddy_cpus: limits.caddyCpus } },
    output: { node: { value: '${module.node.node_name}' }, ports: { value: '${module.node.ports}' }, containers: { value: '${module.node.containers}' } }
  };
}

export async function sourceFingerprint(root = ROOT) {
  const files = ['versions.tf', 'variables.tf', 'main.tf', 'outputs.tf', '.terraform.lock.hcl', 'caddy-image/Dockerfile', 'caddy-image/.dockerignore'];
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file).update('\0').update(await readFile(resolve(root, 'infra/node', file))).update('\0');
  }
  return hash.digest('hex');
}
export function assertPlanMatches(planned, expected) {
  for (const key of ['revision', 'dockerHost', 'platform', 'configurationHash', 'sourceHash', 'planHash']) {
    if (typeof expected[key] !== 'string' || planned[key] !== expected[key]) throw new Error('The saved plan no longer matches the deployment inputs; run plan again');
  }
}
