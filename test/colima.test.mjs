import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { ROOT } from '../tools/config.mjs';
import { parseColimaProfile, safeColimaProfile, ensureLocalRuntime } from '../tools/colima.mjs';

const template = await readFile(resolve(ROOT, 'infra/colima/config-v.yaml'), 'utf8');
// Expanded defaults emitted by Colima 0.10.3; no dependency on a developer's home.
const expanded = template.replace('network:\n  address: false\n  hostAddresses: false', 'network:\n  address: false\n  mode: ""\n  interface: ""\n  preferredRoute: false\n  dns: null\n  dnsHosts: {}\n  hostAddresses: false\n  gatewayAddress: null').replace('kubernetes:\n  enabled: false', 'kubernetes:\n  enabled: false\n  version: v1.35.0+k3s1\n  k3sArgs:\n    - --disable=traefik\n  port: 0') + '\nmodelRunner: ""\nhostname: colima-config-v\ndocker: {}\nrosetta: false\nbinfmt: true\nnestedVirtualization: false\nmountType: virtiofs\nmountInotify: false\ncpuType: ""\nprovision: null\nsshPort: 0\ndiskImage: ""\nforceDiskImage: false\nrootDisk: 20\nenv: {}\n';

async function fixture(text = expanded) {
  const home = await mkdtemp(resolve(tmpdir(), 'config-v-colima-'));
  const parent = resolve(home, '.colima');
  const profile = resolve(parent, 'config-v');
  await mkdir(parent, { mode: 0o755 });
  await mkdir(profile, { mode: 0o700 });
  await writeFile(resolve(profile, 'colima.yaml'), text, { mode: 0o600 });
  return { home, parent, filename: resolve(profile, 'colima.yaml') };
}
function executor(state = 'Stopped') {
  const calls = [];
  return { calls, execute: async (command, args) => {
    calls.push({ command, args });
    if (args[0] === 'list') return state ? JSON.stringify({ name: 'config-v', status: state }) + '\n' : '';
    return '';
  } };
}

test('semantic Colima validation accepts both short template and expanded/reordered YAML', () => {
  assert.equal(safeColimaProfile(template), true);
  assert.equal(safeColimaProfile(expanded), true);
  assert.equal(safeColimaProfile(expanded.replace('cpu: 2', '# harmless comment\ncpu: 3').replace('mounts: null', 'mounts: ~')), true);
  assert.equal(parseColimaProfile(expanded).network.hostAddresses, false);
});

test('Colima validation rejects unsafe settings, missing isolation settings and ambiguous YAML', () => {
  for (const [before, after] of [
    ['mounts: null', 'mounts: []'], ['mounts: null', 'mounts: [{location: /Users}]'], ['mounts: null\n', ''],
    ['forwardAgent: false', 'forwardAgent: true'], ['sshConfig: false', 'sshConfig: true'], ['autoActivate: false', 'autoActivate: true'],
    ['hostAddresses: false', 'hostAddresses: true'], ['address: false', 'address: true'], ['mode: ""', 'mode: bridged'],
    ['provision: null', 'provision: [{mode: system, script: echo unsafe}]'], ['docker: {}', 'docker: {hosts: ["tcp://0.0.0.0:2375"]}'],
    ['env: {}', 'env: {DOCKER_HOST: "tcp://0.0.0.0:2375"}'], ['diskImage: ""', 'diskImage: /tmp/unreviewed.img'],
    ['enabled: false', 'enabled: true'], ['dns: null', 'dns: ["dns.example.com"]']
  ]) assert.equal(safeColimaProfile(expanded.replace(before, after)), false, after);
  for (const addition of ['\nmounts: null\n', '\nunknownOption: true\n', '\nprovision: !custom []\n', '\n---\nmounts: null\n']) assert.equal(safeColimaProfile(expanded + addition), false);
  assert.equal(safeColimaProfile(expanded.replace('forwardAgent: false', 'forwardAgent: &off false').replace('sshConfig: false', 'sshConfig: *off')), false);
});

test('starting an unchanged stopped Colima profile preserves its full YAML and parent permissions', async () => {
  const f = await fixture(); const exec = executor();
  const mode = (await stat(f.parent)).mode;
  await ensureLocalRuntime(ROOT, { ...exec, home: f.home });
  assert.equal(await readFile(f.filename, 'utf8'), expanded);
  assert.equal((await stat(f.parent)).mode, mode);
  assert.deepEqual(exec.calls.at(-1), { command: 'colima', args: ['start', '--profile', 'config-v'] });
});

test('running Colima is left alone, and changed VM hostname or DNS require an explicit stop', async () => {
  const f = await fixture();
  const unchanged = executor('Running');
  await ensureLocalRuntime(ROOT, { ...unchanged, home: f.home, vmOptions: { hostname: 'colima-config-v', dnsServers: [] } });
  assert.equal(unchanged.calls.some(call => call.args[0] === 'start'), false);
  for (const vmOptions of [{ hostname: 'family-local' }, { dnsServers: ['1.1.1.1'] }]) {
    const exec = executor('Running');
    await assert.rejects(ensureLocalRuntime(ROOT, { ...exec, home: f.home, vmOptions }), /colima stop --profile config-v/);
    assert.equal(await readFile(f.filename, 'utf8'), expanded);
    assert.equal(exec.calls.some(call => call.args[0] === 'start'), false);
  }
});

test('stopped VM updates only requested hostname/DNS and permits clearing custom resolvers', async () => {
  const f = await fixture(); const exec = executor();
  await ensureLocalRuntime(ROOT, { ...exec, home: f.home, vmOptions: { hostname: 'family-local', dnsServers: ['1.1.1.1', '2606:4700:4700::1111'] } });
  const changedText = await readFile(f.filename, 'utf8');
  const before = parseColimaProfile(expanded); const after = parseColimaProfile(changedText);
  before.hostname = 'family-local'; before.network.dns = ['1.1.1.1', '2606:4700:4700::1111'];
  assert.deepEqual(after, before);
  assert.match(changedText, /Dedicated local VM template/);
  await ensureLocalRuntime(ROOT, { ...executor(), home: f.home, vmOptions: { dnsServers: [] } });
  const reset = parseColimaProfile(await readFile(f.filename, 'utf8'));
  assert.deepEqual(reset.network.dns, []);
  assert.equal(reset.hostname, 'family-local');
});

test('fresh Colima profile is created privately, while unsafe or unknown-state profiles never start', async () => {
  const home = await mkdtemp(resolve(tmpdir(), 'config-v-colima-new-'));
  const exec = executor(null);
  await ensureLocalRuntime(ROOT, { ...exec, home, vmOptions: { hostname: 'fresh-local', dnsServers: '9.9.9.9' } });
  const filename = resolve(home, '.colima/config-v/colima.yaml');
  assert.equal(parseColimaProfile(await readFile(filename, 'utf8')).hostname, 'fresh-local');
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
  const unsafe = await fixture(expanded.replace('mounts: null', 'mounts: []'));
  const denied = executor();
  await assert.rejects(ensureLocalRuntime(ROOT, { ...denied, home: unsafe.home }), /mounts/);
  assert.equal(denied.calls.length, 0);
  const stopped = await fixture(); const unknown = executor('Broken');
  await assert.rejects(ensureLocalRuntime(ROOT, { ...unknown, home: stopped.home }), /resolve its state/);
  assert.equal(unknown.calls.some(call => call.args[0] === 'start'), false);
});

test('VM overrides and symlinked configuration paths fail before mutation', async () => {
  const f = await fixture();
  for (const vmOptions of [{ hostname: 'x;id' }, { hostname: '127.0.0.1' }, { dnsServers: ['https://1.1.1.1'] }, { dnsServers: ['fe80::1%en0'] }]) await assert.rejects(ensureLocalRuntime(ROOT, { ...executor(), home: f.home, vmOptions }));
  const linkedHome = await mkdtemp(resolve(tmpdir(), 'config-v-colima-link-'));
  await symlink(f.parent, resolve(linkedHome, '.colima'));
  await assert.rejects(ensureLocalRuntime(ROOT, { ...executor(), home: linkedHome }), /real directory/);
});
