#!/usr/bin/env node
import { readFile, mkdir, lstat, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { createInterface } from 'node:readline/promises';
import { ROOT, identifier, renderNode, reconfigureNode, loadNode, saveNode, secureDirectory, writePrivate, configurationRevision, terraformConfiguration, contentHash } from './config.mjs';
import { run, docker, daemonPlatform, preflight } from './docker.mjs';
import { parseArguments, readSettings, collectSettings } from './settings.mjs';
import { ensureLocalRuntime } from './colima.mjs';

export const HELP = `Usage:
  npm run init -- --local
  npm run init -- --node de-main --domain connect.example.com --docker-host ssh://deploy@server.example.com
  npm run init -- --env-file .env
  npm run restart:vpn -- --node de-main
  npm run restart:client -- --node de-main
  npm run restart:all -- --node de-main

init runs configure -> validate -> Docker/Colima readiness -> seed -> plan -> apply -> status.
Local init also runs the real tunnel smoke test. By default init applies the printed plan.
--prepare-only saves configuration without Docker, Colima or Terraform calls.
--plan-only prepares the node and saves a plan without applying it.
An existing node keeps its keys and device IDs. Use a new node for a different Docker endpoint.

Settings: --node, --local / --production, --domain, --address, --docker-host,
  --port, --http-port, --bind-address, --dns-servers (comma-separated IPs),
  --xray-memory-mb, --caddy-memory-mb, --xray-cpus, --caddy-cpus, --client.
Local VM only: --vm-hostname, --vm-dns-servers (IP list); saved separately per node.
Precedence: command line > process VPN_* environment > .env > saved node > defaults.
See .env.example. Files are parsed as data; shell commands are never evaluated.

restart --target all|vpn|client uses the saved Docker endpoint.
Targets: vpn = Xray; client = Caddy website; all = both.
restart:back is reserved for a future API backend; it reports that none exists.
It preserves containers, keys and certificate volumes; active connections may disconnect.
It does not reboot the OS, change configuration, or start a stopped Colima VM.
`;

export async function pathExists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function withNodeLock(root, name, operation) {
  identifier(name);
  await secureDirectory(resolve(root, 'runtime'));
  await secureDirectory(resolve(root, 'runtime/.locks'));
  const path = resolve(root, 'runtime/.locks', name);
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another lifecycle operation holds runtime/.locks/' + name + '. If it crashed, verify it has exited before removing this lock directory.');
    throw error;
  }
  try {
    await writePrivate(resolve(path, 'owner.json'), JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }) + '\n');
    return await operation();
  } finally { await rm(path, { recursive: true }); }
}

export async function prepareConfiguration(root, options) {
  const directory = resolve(root, 'runtime', identifier(options.node));
  let bundle;
  if (await pathExists(directory)) {
    if (!(await lstat(directory)).isDirectory()) throw new Error('Node runtime must be a real directory, not a symlink');
    const current = await loadNode(directory);
    bundle = await reconfigureNode(current, options, root);
    if (JSON.stringify(bundle) !== JSON.stringify(current)) await saveNode(directory, bundle);
  } else {
    bundle = await renderNode(options, root);
    await mkdir(directory, { mode: 0o700 });
    await saveNode(directory, bundle);
  }
  return { bundle, directory };
}

export async function vmSettings(directory, options, mode) {
  const has = key => Object.hasOwn(options, key);
  if (mode !== 'local' && (has('vm-hostname') || has('vm-dns-servers'))) throw new Error('VM hostname/DNS settings apply only to local Colima; VPS OS configuration is not managed here');
  const path = resolve(directory, 'vm.json');
  const settings = await pathExists(path) ? JSON.parse(await readFile(path, 'utf8')) : {};
  if (has('vm-hostname')) settings.hostname = options['vm-hostname'];
  if (has('vm-dns-servers')) settings.dnsServers = options['vm-dns-servers'].trim() === '' ? [] : options['vm-dns-servers'].split(',').map(item => item.trim());
  if (settings.hostname !== undefined && (typeof settings.hostname !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(settings.hostname))) throw new Error('VM hostname must be a lowercase Linux hostname without dots');
  if (settings.dnsServers !== undefined && (!Array.isArray(settings.dnsServers) || settings.dnsServers.some(ip => typeof ip !== 'string' || !isIP(ip) || ip.includes('%')))) throw new Error('VM DNS servers must be IP literals');
  if (Object.keys(settings).some(key => !['hostname', 'dnsServers'].includes(key))) throw new Error('Unexpected VM settings');
  return settings;
}

export async function initialize(options, flags = {}, { root = ROOT, execute = run, getPlatform = daemonPlatform, ensureRuntime = ensureLocalRuntime, report = console.log } = {}) {
  return withNodeLock(root, options.node, async () => {
    const selectedDirectory = resolve(root, 'runtime', identifier(options.node));
    if (await pathExists(selectedDirectory) && !(await lstat(selectedDirectory)).isDirectory()) throw new Error('Node runtime must be a real directory, not a symlink');
    const saved = await pathExists(selectedDirectory) ? await loadNode(selectedDirectory) : null;
    const mode = saved?.deployment.mode || (options.local ? 'local' : 'production');
    const vmOptions = await vmSettings(selectedDirectory, options, mode);
    const { bundle, directory } = await prepareConfiguration(root, options);
    const meta = bundle.deployment;
    if (meta.mode === 'local' && Object.keys(vmOptions).length) await writePrivate(resolve(directory, 'vm.json'), JSON.stringify(vmOptions, null, 2) + '\n');
    report('Узел: ' + meta.name + ' (' + meta.mode + '), домен: ' + meta.domain + ', клиентский адрес: ' + meta.address + ':' + meta.vpnPort);
    report('Конфигурация: runtime/' + meta.name + '/. Ключи и профили не выводятся в терминал.');
    const invoke = command => execute(process.execPath, [resolve(root, 'tools/vpn.mjs'), command, '--node', meta.name], { cwd: root });
    await invoke('validate');
    if (flags['prepare-only']) { report('Настройки подготовлены. Среда исполнения и сервер не запускались.'); return; }
    await execute('terraform', ['version'], { capture: true });
    await execute('docker', ['--version'], { capture: true });
    if (meta.mode === 'local') await ensureRuntime(root, { execute, vmOptions });
    try { await getPlatform(meta); }
    catch { throw new Error('Selected Docker daemon is unavailable. For a VPS, prepare Docker and SSH access first; init does not install rootful Docker or change the VPS OS.'); }
    await invoke('seed');
    await invoke('plan');
    if (flags['plan-only']) { report('План сохранён. Применение: npm run vpn:apply -- --node ' + meta.name); return; }
    await invoke('apply');
    await invoke('status');
    if (meta.mode === 'local') await execute(process.execPath, [resolve(root, 'tools/smoke.mjs'), '--node', meta.name], { cwd: root });
    else report('Контейнеры запущены. Проверьте HTTPS и VPN с устройств семьи; состояние running не подтверждает доступность из их сети.');
    report('Клиентские ссылки: ' + directory + '/clients/');
  });
}

export async function restartNode(name, { target = 'all', root = ROOT, executeDocker = docker, verify = preflight, report = console.log } = {}) {
  identifier(name);
  if (!['all', 'vpn', 'client', 'back'].includes(target)) throw new Error('Unknown restart target');
  if (target === 'back') throw new Error('No persistent API backend exists yet. tools/ contains operator commands; restart:vpn restarts Xray, restart:client restarts the Caddy website.');
  const services = target === 'vpn' ? ['xray'] : target === 'client' ? ['caddy'] : ['caddy', 'xray'];
  return withNodeLock(root, name, async () => {
    const directory = resolve(root, 'runtime', name);
    if (!(await lstat(directory)).isDirectory()) throw new Error('Node runtime must be a real directory, not a symlink');
    const bundle = await loadNode(directory);
    if (bundle.deployment.name !== name) throw new Error('Node path and manifest do not match');
    const meta = bundle.deployment;
    let applied;
    try { applied = JSON.parse(await readFile(resolve(directory, 'applied.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') throw new Error('No recorded successful apply for this node; run init before using restart'); throw error; }
    const revision = configurationRevision(bundle.xray, bundle.caddy);
    const configurationHash = contentHash(JSON.stringify(terraformConfiguration(meta, revision, applied.platform), null, 2) + '\n');
    if (applied.dockerHost !== meta.dockerHost || applied.revision !== revision || applied.configurationHash !== configurationHash) throw new Error('Settings differ from the last successful apply; run init to deploy changes before restarting');
    const seeded = JSON.parse(await readFile(resolve(directory, 'seeded.json'), 'utf8'));
    if (seeded.revision !== configurationRevision(bundle.xray, bundle.caddy) || seeded.dockerHost !== meta.dockerHost) throw new Error('Unseeded configuration changes; run init to apply configuration before restarting');
    await verify(meta, { xray: await readFile(resolve(directory, 'xray.json')), caddy: bundle.caddy }, executeDocker);
    const containers = [];
    // Inspect BOTH before restarting either, then operate on exact IDs to avoid
    // touching similarly named resources owned by another project.
    for (const service of services) {
      const expected = 'config-v-' + name + '-' + service;
      const [container] = JSON.parse(await executeDocker(meta, ['inspect', '--type', 'container', expected], { capture: true }));
      if (!container || container.Name !== '/' + expected || !/^[a-f0-9]{64}$/.test(container.Id || '') || container.Config?.Labels?.['io.config-v.node'] !== name) throw new Error('Refusing to restart an unmanaged container: ' + expected);
      containers.push({ service, id: container.Id });
    }
    report('Перезапуск ' + services.join(', ') + ' узла ' + name + '; текущие подключения могут оборваться.');
    for (const { service, id } of containers) {
      await executeDocker(meta, ['restart', '--time', '15', id], { capture: true });
      const state = JSON.parse(await executeDocker(meta, ['inspect', '--format', '{{json .State}}', id], { capture: true }));
      if (state.Status !== 'running') throw new Error(service + ' is not running after restart');
      report(service + ': running (проверьте соединение клиентом)');
    }
  });
}

export async function main(args = process.argv.slice(2)) {
  const [command = 'help', ...rest] = args;
  if (command === 'help' || command === '--help') { console.log(HELP); return; }
  if (!['init', 'restart'].includes(command)) throw new Error('Use init or restart; see --help');
  if (parseArguments(rest, command).help) { console.log(HELP); return; }
  const { options, flags } = await readSettings(rest, { command });
  if (command === 'restart') {
    if (!options.node) throw new Error('Select the saved node with --node or VPN_NODE');
    await restartNode(options.node, { target: flags.target || 'all' }); return;
  }
  let readline;
  try {
    if (process.stdin.isTTY && process.stdout.isTTY) readline = createInterface({ input: process.stdin, output: process.stdout });
    const ask = readline && (async (question, fallback) => (await readline.question(question + (fallback ? ' [' + fallback + ']' : '') + ': ')).trim() || fallback);
    const complete = await collectSettings(options, { exists: name => pathExists(resolve(ROOT, 'runtime', name)), ask });
    readline?.close(); readline = null;
    await initialize(complete, flags);
  } finally { readline?.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error('VPN lifecycle: ' + error.message); process.exitCode = 1; });
}
