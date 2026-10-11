import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { request } from 'node:https';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ROOT, LOCAL_DOCKER_HOST, XRAY_IMAGE, identifier, loadNode, clientConfig } from './config.mjs';
import { cleanEnvironment } from './docker.mjs';

// Config goes only to the client's stdin. Docker diagnostics and traffic bodies
// are never echoed: parser errors can otherwise reveal authentication values.
const ownership = randomBytes(12).toString('hex');
const candidates = [];
const attached = [];
const abort = new AbortController();
const interrupt = () => abort.abort();
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);

function docker(args, { timeout = 30000, allowFailure = false, cleanup = false } = {}) {
  return new Promise((accept, reject) => {
    const child = spawn('docker', ['--host', LOCAL_DOCKER_HOST, ...args], {
      env: cleanEnvironment(), stdio: ['ignore', 'pipe', 'ignore'],
      ...(cleanup ? {} : { signal: abort.signal })
    });
    const output = [];
    let size = 0;
    let expired = false;
    const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, timeout);
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size <= 1024 * 1024) output.push(chunk);
      else child.kill('SIGKILL');
    });
    child.once('error', () => { clearTimeout(timer); reject(new Error('Docker command could not complete')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (expired || size > 1024 * 1024 || (!allowFailure && code !== 0)) reject(new Error('Docker command failed or timed out'));
      else accept({ code, output: Buffer.concat(output).toString('utf8') });
    });
  });
}

async function inspect(name, cleanup = false) {
  const result = await docker(['container', 'inspect', name], { allowFailure: cleanup, cleanup });
  return result.code === 0 ? JSON.parse(result.output)[0] : null;
}

function ordinaryHTTPS(meta) {
  return new Promise((accept, reject) => {
    const req = request({
      hostname: '127.0.0.1', port: meta.vpnPort, servername: meta.domain,
      headers: { Host: meta.domain }, path: '/', method: 'GET',
      // Guarded by the local-only checks in main; never used for proxy egress.
      rejectUnauthorized: false, signal: abort.signal
    }, response => {
      const parts = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 4096) req.destroy(new Error('Unexpected fallback response'));
        else parts.push(chunk);
      });
      response.once('error', () => reject(new Error('Local HTTPS response failed')));
      response.once('end', () => {
        if (response.statusCode === 200 && Buffer.concat(parts).toString('utf8').trim() === 'Local test endpoint') accept();
        else reject(new Error('Local HTTPS fallback did not return the expected test page'));
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error('Local HTTPS timed out')));
    req.once('error', () => reject(new Error('Local HTTPS handshake failed')));
    req.end();
  });
}

const pause = ms => new Promise((accept, reject) => {
  if (abort.signal.aborted) return reject(new Error('Smoke test interrupted'));
  const onAbort = () => { clearTimeout(timer); reject(new Error('Smoke test interrupted')); };
  const timer = setTimeout(() => { abort.signal.removeEventListener('abort', onAbort); accept(); }, ms);
  abort.signal.addEventListener('abort', onAbort, { once: true });
});

async function retry(action, attempts = 3) {
  for (let attempt = 0; ; attempt++) {
    try { return await action(); }
    catch (error) {
      if (attempt + 1 >= attempts || abort.signal.aborted) throw error;
      await pause(500);
    }
  }
}

const sandbox = [
  '--pull', 'never', '--read-only', '--user', '65532:65532',
  '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
  '--memory', '128m', '--memory-swap', '128m', '--cpus', '0.5',
  '--pids-limit', '64', '--log-driver', 'none'
];

async function create(network, role, image, args, extra = []) {
  const name = 'config-v-smoke-' + ownership + '-' + role + '-' + candidates.length;
  candidates.push(name);
  const result = await docker([
    'create', ...sandbox, '--name', name,
    '--label', 'io.config-v.smoke=' + ownership,
    '--network', network, ...extra, image, ...args
  ]);
  const id = result.output.trim();
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Docker did not return a container ID');
  return { name, id };
}

async function startClient(network, meta, id, role) {
  const config = clientConfig({ ...meta, address: 'xray', vpnPort: 8443 }, { id });
  config.log = { access: 'none', loglevel: 'none' };
  config.inbounds[0].listen = '0.0.0.0';
  config.inbounds[0].settings.udp = false;
  const container = await create(network, role, XRAY_IMAGE, ['run', '-format', 'json', '-config', 'stdin:'], ['--interactive']);
  const child = spawn('docker', ['--host', LOCAL_DOCKER_HOST, 'start', '--attach', '--interactive', container.id], {
    env: cleanEnvironment(), stdio: ['pipe', 'ignore', 'ignore']
  });
  attached.push(child);
  child.once('error', () => {});
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify(config));
  await retry(async () => {
    if (!(await inspect(container.id))?.State?.Running) throw new Error('Temporary Xray client did not start');
  });
  return container;
}

async function probe(network, image, client, seconds = 15) {
  // Caddy's already-built immutable image includes curl. Reuse it instead of
  // downloading another image. HTTPS certificates remain fully verified.
  const container = await create(network, 'probe', image, [
    '--silent', '--show-error', '--fail', '--output', '/dev/null',
    '--write-out', '%{http_code}', '--max-time', String(seconds),
    '--connect-timeout', String(Math.min(seconds, 8)), '--noproxy', '',
    '--proxy', 'socks5h://' + client.name + ':1080',
    '--proto', '=https', '--url', 'https://example.com/'
  ], ['--entrypoint', '/usr/bin/curl']);
  const result = await docker(['start', '--attach', container.id], { allowFailure: true, timeout: (seconds + 5) * 1000 });
  const state = await inspect(container.id);
  return state?.State?.ExitCode === 0 && result.code === 0 && result.output.trim() === '200';
}

async function cleanup() {
  let failed = false;
  for (const name of candidates.reverse()) {
    try {
      const container = await inspect(name, true);
      if (!container) continue;
      if (container.Config?.Labels?.['io.config-v.smoke'] !== ownership) { failed = true; continue; }
      await docker(['rm', '--force', '--volumes', container.Id], { cleanup: true, timeout: 10000 });
    } catch { failed = true; }
  }
  for (const child of attached) if (child.exitCode === null) child.kill('SIGTERM');
  if (failed) throw new Error('Some temporary smoke containers could not be removed; retry cleanup by their io.config-v.smoke label');
}

async function main() {
  const { values } = parseArgs({ options: { node: { type: 'string' }, help: { type: 'boolean' } }, strict: true });
  if (values.help) { console.log('Usage: node tools/smoke.mjs --node local-check (dedicated local Colima only)'); return; }
  if (!values.node) throw new Error('Set --node to a generated local node');
  const bundle = await loadNode(resolve(ROOT, 'runtime', identifier(values.node)));
  const meta = bundle.deployment;
  if (meta.mode !== 'local' || meta.dockerHost !== LOCAL_DOCKER_HOST || meta.bindAddress !== '127.0.0.1' || meta.address !== '127.0.0.1' || !bundle.caddy.includes('tls internal')) {
    throw new Error('Smoke tests accept only a local node on the dedicated Colima socket');
  }
  const network = 'config-v-' + meta.name;
  const caddy = await inspect(network + '-caddy');
  const server = await inspect(network + '-xray');
  for (const container of [caddy, server]) {
    if (!container?.State?.Running || container.Config?.Labels?.['io.config-v.node'] !== meta.name || !container.NetworkSettings?.Networks?.[network]) {
      throw new Error('Apply the selected local node before running smoke tests');
    }
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(caddy.Image)) throw new Error('Cannot determine the existing Caddy image');
  await retry(() => ordinaryHTTPS(meta));
  console.log('PASS: ordinary HTTPS reaches the local fallback.');
  const valid = await startClient(network, meta, meta.clients[0].id, 'valid');
  await retry(async () => {
    if (!await probe(network, caddy.Image, valid)) throw new Error('HTTPS through the authenticated tunnel failed');
  });
  console.log('PASS: authenticated REALITY + Vision carries verified HTTPS.');
  let wrongId;
  do { wrongId = randomUUID(); } while (meta.clients.some(client => client.id === wrongId));
  const invalid = await startClient(network, meta, wrongId, 'invalid');
  if (await probe(network, caddy.Image, invalid, 8)) throw new Error('A client with an unknown UUID unexpectedly reached the test site');
  if (!(await inspect(invalid.id))?.State?.Running) throw new Error('The negative-test client exited; rejection could not be verified');
  // Confirm the same target remains reachable, ruling out a general outage as
  // the explanation for the preceding failed request.
  if (!await probe(network, caddy.Image, valid)) throw new Error('The control request failed; the negative test is inconclusive');
  console.log('PASS: an unknown UUID cannot carry the HTTPS request.');
}

let failure;
try { await main(); } catch (error) { failure = error; }
try { await cleanup(); } catch (error) { failure = error; }
process.removeListener('SIGINT', interrupt);
process.removeListener('SIGTERM', interrupt);
if (failure) {
  // loadNode can reject JSON with a parser message containing source fragments.
  const safe = failure instanceof SyntaxError ? 'Generated configuration is not valid JSON' : failure.message;
  console.error('Smoke test failed: ' + safe);
  process.exitCode = 1;
} else if (candidates.length) {
  console.log('Temporary test containers removed. This verifies local connectivity, not availability from Russia.');
}
