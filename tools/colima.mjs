import { readFile, mkdir, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { isIP } from 'node:net';
import { parseDocument, visit } from 'yaml';
import { writePrivate } from './config.mjs';
import { run } from './docker.mjs';

const fail = message => { throw new Error('Unsafe or unsupported Colima config-v profile: ' + message); };
const mapping = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function knownKeys(value, allowed, label) {
  if (!mapping(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('review ' + label + ' settings');
}
function emptyMap(value) { return value === undefined || value === null || (mapping(value) && Object.keys(value).length === 0); }
function emptyList(value) { return value === undefined || value === null || (Array.isArray(value) && value.length === 0); }
function falseOrMissing(value) { return value === undefined || value === false; }
function positive(value) { return typeof value === 'number' && Number.isFinite(value) && value > 0; }
function hostname(value) {
  if (typeof value !== 'string' || value.length > 253 || isIP(value) || value.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) throw new Error('VM hostname must use valid DNS labels, without an address, scheme, path or port');
  return value.toLowerCase();
}
function resolvers(value) {
  const list = Array.isArray(value) ? [...value] : typeof value === 'string' ? value.trim() ? value.split(',').map(item => item.trim()) : [] : null;
  if (!list || list.some(item => typeof item !== 'string' || !isIP(item) || item.includes('%'))) throw new Error('VM DNS servers must be IPv4 or IPv6 literals');
  return [...new Set(list)];
}
export function normalizeVmOptions(options = {}) {
  knownKeys(options, ['hostname', 'dnsServers'], 'VM override');
  return {
    ...(options.hostname !== undefined ? { hostname: hostname(options.hostname) } : {}),
    ...(options.dnsServers !== undefined ? { dnsServers: resolvers(options.dnsServers) } : {})
  };
}

function documentOf(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 128 * 1024) fail('configuration must be a small YAML document');
  const document = parseDocument(text, { strict: true, uniqueKeys: true, stringKeys: true, version: '1.2' });
  if (document.errors.length || document.warnings.length) fail('invalid YAML, duplicate keys or unsupported tags');
  visit(document, { Alias() { fail('YAML aliases are not allowed'); } });
  return document;
}

export function parseColimaProfile(text) {
  const value = documentOf(text).toJS({ maxAliasCount: 0 });
  knownKeys(value, ['cpu', 'disk', 'memory', 'arch', 'runtime', 'modelRunner', 'hostname', 'kubernetes', 'autoActivate', 'network', 'forwardAgent', 'docker', 'vmType', 'portForwarder', 'rosetta', 'binfmt', 'nestedVirtualization', 'mountType', 'mountInotify', 'cpuType', 'provision', 'sshConfig', 'sshPort', 'mounts', 'diskImage', 'forceDiskImage', 'rootDisk', 'env'], 'top-level');
  if (value.mounts !== null || !Object.hasOwn(value, 'mounts')) fail('mounts must be explicitly null; an empty list exposes the host home directory');
  if (value.forwardAgent !== false || value.sshConfig !== false || value.autoActivate !== false) fail('forwardAgent, sshConfig and autoActivate must be explicitly false');
  if (value.runtime !== 'docker' || value.vmType !== 'vz' || value.portForwarder !== 'ssh') fail('expected Docker in a VZ VM with SSH port forwarding');
  if (!positive(value.cpu) || !Number.isInteger(value.cpu) || !positive(value.memory) || !positive(value.disk) || (value.rootDisk !== undefined && !positive(value.rootDisk))) fail('invalid VM resource limits');
  if (!['host', 'aarch64', 'x86_64'].includes(value.arch)) fail('unexpected architecture');
  if (value.hostname !== undefined && value.hostname !== '') hostname(value.hostname);
  if (!emptyMap(value.docker) || !emptyMap(value.env)) fail('custom Docker daemon options and VM environment variables require review');
  if (!emptyList(value.provision)) fail('provisioning scripts are not allowed');
  if (![undefined, ''].includes(value.diskImage) || !falseOrMissing(value.forceDiskImage)) fail('custom or unverified VM disk images are not allowed');
  if (![undefined, ''].includes(value.modelRunner) || !falseOrMissing(value.nestedVirtualization) || !falseOrMissing(value.mountInotify) || !falseOrMissing(value.rosetta)) fail('unexpected VM extensions');
  if (value.binfmt !== undefined && typeof value.binfmt !== 'boolean') fail('invalid binfmt setting');
  if (![undefined, 'virtiofs'].includes(value.mountType) || ![undefined, ''].includes(value.cpuType)) fail('unexpected mount or CPU driver');
  if (value.sshPort !== undefined && (!Number.isInteger(value.sshPort) || value.sshPort < 0 || value.sshPort > 65535)) fail('invalid SSH port');
  knownKeys(value.network, ['address', 'mode', 'interface', 'preferredRoute', 'dns', 'dnsHosts', 'hostAddresses', 'gatewayAddress'], 'network');
  if (value.network.address !== false || value.network.hostAddresses !== false || !falseOrMissing(value.network.preferredRoute) || ![undefined, '', 'shared'].includes(value.network.mode)) fail('public, bridged or preferred-route VM networking is not allowed');
  if (![undefined, ''].includes(value.network.interface)) fail('custom network interface requires review');
  if (value.network.dns !== undefined && value.network.dns !== null) {
    if (!Array.isArray(value.network.dns)) fail('network.dns must be a list of IP addresses');
    resolvers(value.network.dns);
  }
  if (!emptyMap(value.network.dnsHosts)) fail('custom DNS host mappings require review');
  if (value.network.gatewayAddress !== undefined && value.network.gatewayAddress !== null && (isIP(value.network.gatewayAddress) !== 4 || !value.network.gatewayAddress.endsWith('.2'))) fail('invalid VM gateway address');
  knownKeys(value.kubernetes, ['enabled', 'version', 'k3sArgs', 'port'], 'Kubernetes');
  if (value.kubernetes.enabled !== false) fail('Kubernetes must remain disabled');
  if (value.kubernetes.version !== undefined && typeof value.kubernetes.version !== 'string') fail('invalid Kubernetes version');
  if (value.kubernetes.k3sArgs !== undefined && (!Array.isArray(value.kubernetes.k3sArgs) || value.kubernetes.k3sArgs.some(arg => typeof arg !== 'string'))) fail('invalid Kubernetes arguments');
  if (value.kubernetes.port !== undefined && (!Number.isInteger(value.kubernetes.port) || value.kubernetes.port < 0 || value.kubernetes.port > 65535)) fail('invalid Kubernetes port');
  return value;
}

export function safeColimaProfile(text) {
  try { parseColimaProfile(text); return true; } catch { return false; }
}

async function fileInfo(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function ensureDirectory(path) {
  const info = await fileInfo(path);
  if (info && !info.isDirectory()) throw new Error('Colima path must be a real directory: ' + path);
  if (!info) await mkdir(path, { mode: 0o700 });
}
function stateFromList(text) {
  let profiles;
  try {
    const trimmed = text.trim();
    profiles = !trimmed ? [] : trimmed.startsWith('[') ? JSON.parse(trimmed) : trimmed.split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch { throw new Error('Cannot parse Colima instance status; the VM was not started'); }
  if (!Array.isArray(profiles) || profiles.some(profile => !mapping(profile) || typeof profile.name !== 'string' || typeof profile.status !== 'string')) throw new Error('Cannot parse Colima instance list');
  const matching = profiles.filter(profile => profile?.name === 'config-v');
  if (matching.length > 1) throw new Error('Duplicate Colima profile status');
  if (!matching.length) return 'Absent';
  const state = matching[0].status;
  if (!['Running', 'Stopped'].includes(state)) throw new Error('Colima config-v is ' + state + '; resolve its state before init');
  return state;
}

export async function ensureLocalRuntime(root, { execute = run, home = homedir(), vmOptions = {} } = {}) {
  const desired = normalizeVmOptions(vmOptions);
  const expected = await readFile(resolve(root, 'infra/colima/config-v.yaml'), 'utf8');
  parseColimaProfile(expected);
  const parent = resolve(home, '.colima');
  const profile = resolve(parent, 'config-v');
  const filename = resolve(profile, 'colima.yaml');
  for (const path of [parent, profile]) {
    const info = await fileInfo(path);
    if (info && !info.isDirectory()) throw new Error('Colima path must be a real directory: ' + path);
  }
  const existing = await fileInfo(filename);
  if (existing && !existing.isFile()) throw new Error('Colima configuration must be a regular file, not a symlink');
  if (!existing && await fileInfo(profile)) throw new Error('Existing Colima profile has no configuration; restore or review it before init');
  const original = existing ? await readFile(filename, 'utf8') : expected;
  const actual = parseColimaProfile(original);
  const hostnameChanged = desired.hostname !== undefined && desired.hostname !== (actual.hostname || 'colima-config-v');
  const dnsChanged = desired.dnsServers !== undefined && JSON.stringify(desired.dnsServers) !== JSON.stringify(actual.network.dns || []);
  await execute('colima', ['version'], { capture: true });
  const state = stateFromList(await execute('colima', ['list', '--json'], { capture: true }));
  if (state === 'Running') {
    if (!existing) throw new Error('Running Colima profile is missing its configuration; stop and review it before init');
    if (hostnameChanged || dnsChanged) throw new Error('Colima config-v is running. Run colima stop --profile config-v, then repeat init to change VM hostname or DNS. Its configuration was not modified.');
    return;
  }
  if (!existing || hostnameChanged || dnsChanged) {
    const document = documentOf(original);
    if (hostnameChanged) document.set('hostname', desired.hostname);
    if (dnsChanged) document.setIn(['network', 'dns'], desired.dnsServers);
    const updated = document.toString();
    parseColimaProfile(updated);
    // Preserve existing file contents when no VM setting changed; never replace
    // an expanded profile with the short repository template.
    if (existing && await readFile(filename, 'utf8') !== original) throw new Error('Colima configuration changed during init; retry');
    await ensureDirectory(parent);
    await ensureDirectory(profile);
    await writePrivate(filename, updated);
  }
  await execute('colima', ['start', '--profile', 'config-v']);
}
