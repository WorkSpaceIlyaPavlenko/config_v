import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { HELPER_IMAGE, XRAY_IMAGE } from './config.mjs';

export function cleanEnvironment() {
  const env = { ...process.env };
  for (const key of ['DOCKER_CONTEXT', 'DOCKER_HOST', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'COLIMA_HOME', 'TF_CLI_ARGS', 'TF_CLI_ARGS_init', 'TF_CLI_ARGS_plan', 'TF_CLI_ARGS_apply', 'TF_DATA_DIR', 'TF_WORKSPACE']) delete env[key];
  return env;
}
export function run(command, args, { input, capture = false, cwd, env = cleanEnvironment() } = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: [input === undefined ? 'inherit' : 'pipe', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'] });
    const output = []; const errors = [];
    if (capture) { child.stdout.on('data', data => output.push(data)); child.stderr.on('data', data => errors.push(data)); }
    if (input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input); }
    child.on('error', error => reject(new Error(command + ': ' + error.message)));
    child.on('close', code => {
      if (code !== 0) reject(new Error(command + ' exited with code ' + code + (capture ? ': ' + Buffer.concat(errors).toString('utf8').slice(0, 1000) : '')));
      else accept(Buffer.concat(output).toString('utf8'));
    });
  });
}
export const docker = (meta, args, options) => run('docker', ['--host', meta.dockerHost, ...args], options);
export function volumeNames(name) {
  return { xray: 'config-v-' + name + '-xray-config', caddy: 'config-v-' + name + '-caddy-config' };
}
// A small USTAR archive avoids passing credentials in arguments, environment or
// Terraform state. Only these fixed filenames may be transferred.
export function archive(files) {
  const chunks = [];
  for (const [name, value] of Object.entries(files)) {
    if (!['xray.json', 'Caddyfile'].includes(name)) throw new Error('Unexpected archive filename');
    const content = Buffer.from(value);
    const header = Buffer.alloc(512);
    const field = (offset, length, value) => header.write(value, offset, length, 'ascii');
    const octal = (offset, length, value) => field(offset, length, value.toString(8).padStart(length - 1, '0') + '\0');
    field(0, 100, name); octal(100, 8, 0o600); octal(108, 8, 0); octal(116, 8, 0); octal(124, 12, content.length); octal(136, 12, 0);
    header.fill(32, 148, 156); field(156, 1, '0'); field(257, 6, 'ustar\0'); field(263, 2, '00');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    field(148, 8, checksum.toString(8).padStart(6, '0') + '\0 ');
    chunks.push(header, content, Buffer.alloc((512 - content.length % 512) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}
export async function daemonPlatform(meta, execute = docker) {
  const architecture = (await execute(meta, ['info', '--format', '{{.OSType}}/{{.Architecture}}'], { capture: true })).trim();
  if (!architecture || architecture === '/') throw new Error('Cannot read Docker daemon info; check Colima is running and socket access is permitted');
  if (['linux/x86_64', 'linux/amd64'].includes(architecture)) return 'linux/amd64';
  if (['linux/aarch64', 'linux/arm64'].includes(architecture)) return 'linux/arm64';
  throw new Error('A Linux amd64 or arm64 Docker daemon is required');
}
async function checkOwnedVolume(meta, name, create, execute = docker, candidate = null) {
  const names = (await execute(meta, ['volume', 'ls', '--format', '{{.Name}}'], { capture: true })).trim().split('\n');
  const kind = candidate ? 'candidate' : 'config';
  if (!names.includes(name)) {
    if (!create) throw new Error('Missing configuration volume; run vpn:seed first');
    const args = ['volume', 'create', '--label', 'io.config-v.node=' + meta.name, '--label', 'io.config-v.managed=' + kind];
    if (candidate) args.push('--label', 'io.config-v.candidate=' + candidate);
    await execute(meta, [...args, name], { capture: true });
  }
  const volume = JSON.parse(await execute(meta, ['volume', 'inspect', name], { capture: true }))[0];
  if (volume?.Labels?.['io.config-v.node'] !== meta.name || volume.Labels?.['io.config-v.managed'] !== kind || (candidate && volume.Labels?.['io.config-v.candidate'] !== candidate)) throw new Error('Refusing an unmanaged configuration volume: ' + name);
}

const readonlySandbox = ['run', '--rm', '--network', 'none', '--read-only', '--user', '65532:65532', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true'];
const digest = content => createHash('sha256').update(content).digest('hex');

function expectedHashes(expected) {
  if (!expected || ![expected.xray, expected.caddy].every(value => typeof value === 'string' || Buffer.isBuffer(value))) throw new Error('Configuration preflight requires the exact Xray and Caddy file bytes');
  return { '/xray/xray.json': digest(expected.xray), '/caddy/Caddyfile': digest(expected.caddy) };
}

async function verifyVolumeContents(meta, names, expected, execute) {
  const hashes = expectedHashes(expected);
  const output = await execute(meta, [...readonlySandbox, '--memory', '32m', '--cpus', '0.5', '--mount', 'type=volume,src=' + names.xray + ',dst=/xray,readonly', '--mount', 'type=volume,src=' + names.caddy + ',dst=/caddy,readonly', HELPER_IMAGE, 'sha256sum', '/xray/xray.json', '/caddy/Caddyfile'], { capture: true });
  const entries = output.trim().split('\n').map(line => /^([a-f0-9]{64})  (\/xray\/xray\.json|\/caddy\/Caddyfile)$/.exec(line));
  if (entries.length !== 2 || entries.some(entry => !entry) || new Set(entries.map(entry => entry[2])).size !== 2 || entries.some(entry => hashes[entry[2]] !== entry[1])) throw new Error('Mounted configuration differs from the expected files; run seed again before planning or applying');
}

export async function preflight(meta, expected, execute = docker) {
  expectedHashes(expected);
  const names = volumeNames(meta.name);
  await checkOwnedVolume(meta, names.xray, false, execute);
  await checkOwnedVolume(meta, names.caddy, false, execute);
  await verifyVolumeContents(meta, names, expected, execute);
}

async function prepareVolumeDirectories(meta, names, execute) {
  // Newly created Docker volumes belong to root. Only this short helper needs
  // CHOWN; configuration transfer and publication run as the service UID.
  // Existing roots owned by the service must already have the expected mode.
  const script = [
    'set -eu',
    'prepare() {',
    '  owner=$(stat -c "%u:%g" "$1")',
    '  if [ "$owner" = "0:0" ]; then',
    '    chmod "$2" "$1"',
    '    chown 65532:65532 "$1"',
    '  elif [ "$owner" != "65532:65532" ] || [ "$(stat -c %a "$1")" != "$2" ]; then',
    '    echo "Unexpected configuration directory ownership or mode" >&2; exit 1',
    '  fi',
    '}',
    'prepare /xray 700',
    'prepare /caddy 755'
  ].join('\n');
  await execute(meta, ['run', '--rm', '--network', 'none', '--read-only', '--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--security-opt', 'no-new-privileges:true', '--memory', '32m', '--cpus', '0.5', '--mount', 'type=volume,src=' + names.xray + ',dst=/xray', '--mount', 'type=volume,src=' + names.caddy + ',dst=/caddy', HELPER_IMAGE, 'sh', '-c', script], { capture: true });
}

async function validateCandidate(meta, names, execute) {
  try {
    await execute(meta, [...readonlySandbox, '--memory', '256m', '--cpus', '0.5', '--mount', 'type=volume,src=' + names.xray + ',dst=/etc/config-v,readonly', XRAY_IMAGE, 'run', '-test', '-config', '/etc/config-v/xray.json'], { capture: true });
  } catch {
    // Parser diagnostics can include configuration fragments. Do not echo them
    // into the terminal or expose client credentials in CI output.
    throw new Error('Xray rejected the candidate configuration; active files were not changed');
  }
  try {
    // The official Caddy binary has a file capability. This disposable validator
    // retains only that capability; the actual service uses the stripped binary
    // from infra/node/caddy-image and runs non-root without capabilities.
    await execute(meta, ['run', '--rm', '--network', 'none', '--read-only', '--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'NET_BIND_SERVICE', '--security-opt', 'no-new-privileges:true', '--memory', '128m', '--cpus', '0.5', '--tmpfs', '/data:rw,noexec,nosuid,nodev,size=16m,mode=700', '--tmpfs', '/config:rw,noexec,nosuid,nodev,size=4m,mode=700', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=4m,mode=1777', '--mount', 'type=volume,src=' + names.caddy + ',dst=/etc/config-v,readonly', 'caddy:2.11.4-alpine', 'caddy', 'validate', '--config', '/etc/config-v/Caddyfile', '--adapter', 'caddyfile'], { capture: true });
  } catch {
    throw new Error('Caddy rejected the candidate configuration; active files were not changed');
  }
}

async function removeCandidateVolumes(meta, names, token, execute) {
  let failed = false;
  for (const name of names) {
    try {
      await checkOwnedVolume(meta, name, false, execute, token);
      // No force removal: another container retaining a candidate is an error,
      // not a reason to remove an in-use volume or any established configuration.
      await execute(meta, ['volume', 'rm', name], { capture: true });
    } catch {
      failed = true;
    }
  }
  if (failed) throw new Error('Candidate cleanup was incomplete');
}

export async function seed(bundle, directory, { execute = docker } = {}) {
  const meta = bundle.deployment;
  const rawXray = await readFile(resolve(directory, 'xray.json'));
  if (JSON.stringify(JSON.parse(rawXray)) !== JSON.stringify(bundle.xray)) throw new Error('Local Xray configuration changed while preparing seed; retry with the current files');
  const expected = { xray: rawXray, caddy: bundle.caddy };
  await daemonPlatform(meta, execute);
  const names = volumeNames(meta.name);
  const token = randomBytes(12).toString('hex');
  const candidate = { xray: 'config-v-' + meta.name + '-candidate-' + token + '-xray', caddy: 'config-v-' + meta.name + '-candidate-' + token + '-caddy' };
  const created = [];
  let failure;
  try {
    for (const name of Object.values(candidate)) {
      await checkOwnedVolume(meta, name, true, execute, token);
      created.push(name);
    }
    await prepareVolumeDirectories(meta, candidate, execute);
    const stageScript = [
      'set -eu',
      'umask 077',
      'tar -xf - -C /tmp',
      'cp /tmp/xray.json /xray/xray.json',
      'cp /tmp/Caddyfile /caddy/Caddyfile',
      'chmod 0400 /xray/xray.json',
      'chmod 0444 /caddy/Caddyfile'
    ].join('\n');
    await execute(meta, [...readonlySandbox, '-i', '--memory', '32m', '--cpus', '0.5', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=4m,mode=1777', '--mount', 'type=volume,src=' + candidate.xray + ',dst=/xray', '--mount', 'type=volume,src=' + candidate.caddy + ',dst=/caddy', HELPER_IMAGE, 'sh', '-c', stageScript], { input: archive({ 'xray.json': rawXray, Caddyfile: bundle.caddy }), capture: true });
    await verifyVolumeContents(meta, candidate, expected, execute);
    await validateCandidate(meta, candidate, execute);

    // Only validated candidate files may reach the live configuration volumes.
    await checkOwnedVolume(meta, names.xray, true, execute);
    await checkOwnedVolume(meta, names.caddy, true, execute);
    await prepareVolumeDirectories(meta, names, execute);
    const publishScript = [
      'set -eu',
      'umask 077',
      'xtmp=$(mktemp /xray/.next.XXXXXX)',
      'ctmp=$(mktemp /caddy/.next.XXXXXX)',
      'trap \'rm -f "$xtmp" "$ctmp"\' EXIT',
      'cp /candidate-xray/xray.json "$xtmp"',
      'cp /candidate-caddy/Caddyfile "$ctmp"',
      'chmod 0400 "$xtmp"',
      'chmod 0444 "$ctmp"',
      'mv -f "$xtmp" /xray/xray.json',
      'mv -f "$ctmp" /caddy/Caddyfile'
    ].join('\n');
    await execute(meta, [...readonlySandbox, '--name', 'config-v-' + meta.name + '-publish', '--memory', '32m', '--cpus', '0.5', '--mount', 'type=volume,src=' + candidate.xray + ',dst=/candidate-xray,readonly', '--mount', 'type=volume,src=' + candidate.caddy + ',dst=/candidate-caddy,readonly', '--mount', 'type=volume,src=' + names.xray + ',dst=/xray', '--mount', 'type=volume,src=' + names.caddy + ',dst=/caddy', HELPER_IMAGE, 'sh', '-c', publishScript], { capture: true });
    await preflight(meta, expected, execute);
  } catch (error) {
    failure = error;
  }
  try {
    await removeCandidateVolumes(meta, created, token, execute);
  } catch {
    const message = 'Could not remove all temporary candidate volumes for this seed operation';
    if (failure) throw new Error(failure.message + '; ' + message);
    throw new Error(message);
  }
  if (failure) throw failure;
}
