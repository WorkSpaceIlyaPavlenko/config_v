#!/usr/bin/env node
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { ROOT, identifier, renderNode, saveNode, loadNode, secureDirectory, writePrivate, configurationRevision, terraformConfiguration, contentHash, sourceFingerprint, assertPlanMatches } from './config.mjs';
import { seed, preflight, daemonPlatform, run, docker } from './docker.mjs';

function argumentsOf(args) {
  const options = {};
  const allowed = ['node', 'local', 'domain', 'address', 'port', 'client', 'docker-host', 'http-port', 'bind-address', 'dns-servers', 'xray-memory-mb', 'caddy-memory-mb', 'xray-cpus', 'caddy-cpus', 'name'];
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    const name = flag.slice(2);
    if (!flag.startsWith('--') || !allowed.includes(name) || Object.hasOwn(options, name)) throw new Error('Unknown or repeated option: ' + flag);
    if (name === 'local') options.local = true;
    else {
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Missing value: ' + flag);
      options[name] = args[++index];
    }
  }
  return options;
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') {
    console.log('Usage: node tools/vpn.mjs <init|add-client|validate|seed|plan|apply|status> --node NAME\n\ninit: --local OR --domain DOMAIN [--address IP] [--docker-host ssh://user@host]\nadd-client: --name DEVICE\nplan/apply: configuration must be seeded first; apply uses the saved, unchanged plan.\nCredentials are written to runtime/NAME/clients and never printed.');
    return;
  }
  if (!['init', 'add-client', 'validate', 'seed', 'plan', 'apply', 'status'].includes(command)) throw new Error('Unknown command; use help');
  const options = argumentsOf(args);
  const accepted = command === 'init' ? ['node', 'local', 'domain', 'address', 'port', 'client', 'docker-host', 'http-port', 'bind-address', 'dns-servers', 'xray-memory-mb', 'caddy-memory-mb', 'xray-cpus', 'caddy-cpus'] : command === 'add-client' ? ['node', 'name'] : ['node'];
  for (const key of Object.keys(options)) if (!accepted.includes(key)) throw new Error('--' + key + ' is not accepted by ' + command);
  const name = identifier(options.node || 'local');
  const directory = resolve(ROOT, 'runtime', name);
  if (command === 'init') {
    const bundle = await renderNode({ ...options, node: name });
    await secureDirectory(resolve(ROOT, 'runtime'));
    await mkdir(directory, { mode: 0o700 }); // Deliberately never overwrite keys.
    await saveNode(directory, bundle);
    console.log('Created ' + directory + '. Credentials are in clients/; keep runtime/ private and backed up.');
    return;
  }
  const bundle = await loadNode(directory);
  if (bundle.deployment.name !== name) throw new Error('Node path and manifest do not match');
  if (command === 'add-client') {
    const clientName = identifier(options.name);
    if (bundle.deployment.clients.some(client => client.name === clientName)) throw new Error('This client already exists');
    bundle.deployment.clients.push({ name: clientName, id: randomUUID() });
    bundle.xray.inbounds[0].settings.clients = bundle.deployment.clients.map(client => ({ id: client.id, flow: 'xtls-rprx-vision' }));
    await saveNode(directory, bundle);
    console.log('Client created in runtime/' + name + '/clients/. Run seed, plan and apply to activate it.');
    return;
  }
  if (command === 'validate') {
    console.log('Configuration and client credentials agree. Actual Xray parsing runs during vpn:seed.');
    return;
  }
  if (command === 'seed') {
    await seed(bundle, directory);
    await writePrivate(resolve(directory, 'seeded.json'), JSON.stringify({ revision: configurationRevision(bundle.xray, bundle.caddy), dockerHost: bundle.deployment.dockerHost }) + '\n');
    console.log('Configuration transferred privately and validated by Xray and Caddy. Containers have not been restarted.');
    return;
  }
  if (command === 'status') {
    for (const service of ['caddy', 'xray']) {
      const state = JSON.parse(await docker(bundle.deployment, ['inspect', '--format', '{{json .State}}', 'config-v-' + name + '-' + service], { capture: true }));
      console.log(service + ': ' + state.Status + ' (container state; this does not prove tunnel connectivity)');
    }
    return;
  }
  const revision = configurationRevision(bundle.xray, bundle.caddy);
  const seeded = JSON.parse(await readFile(resolve(directory, 'seeded.json'), 'utf8'));
  if (seeded.revision !== revision || seeded.dockerHost !== bundle.deployment.dockerHost) throw new Error('Configuration or endpoint changed; seed it before planning');
  await preflight(bundle.deployment, { xray: await readFile(resolve(directory, 'xray.json')), caddy: bundle.caddy });
  const platform = await daemonPlatform(bundle.deployment);
  const terraformDir = resolve(directory, 'terraform');
  await secureDirectory(terraformDir);
  const terraformText = JSON.stringify(terraformConfiguration(bundle.deployment, revision, platform), null, 2) + '\n';
  const configurationHash = contentHash(terraformText);
  const sourceHash = await sourceFingerprint();
  if (command === 'plan') {
    await writePrivate(resolve(terraformDir, 'main.tf.json'), terraformText);
    await writePrivate(resolve(terraformDir, '.terraform.lock.hcl'), await readFile(resolve(ROOT, 'infra/node/.terraform.lock.hcl')));
    await run('terraform', ['init', '-input=false', '-lockfile=readonly'], { cwd: terraformDir });
    await run('terraform', ['validate'], { cwd: terraformDir });
    await run('terraform', ['plan', '-input=false', '-out=deployment.tfplan'], { cwd: terraformDir });
    await writePrivate(resolve(terraformDir, 'planned.json'), JSON.stringify({ revision, dockerHost: bundle.deployment.dockerHost, platform, configurationHash, sourceHash, planHash: contentHash(await readFile(resolve(terraformDir, 'deployment.tfplan'))) }) + '\n');
    console.log('Plan saved. Review it, then run vpn:apply for this node.');
  } else {
    const planned = JSON.parse(await readFile(resolve(terraformDir, 'planned.json'), 'utf8'));
    assertPlanMatches(planned, { revision, dockerHost: bundle.deployment.dockerHost, platform, configurationHash, sourceHash, planHash: contentHash(await readFile(resolve(terraformDir, 'deployment.tfplan'))) });
    if (contentHash(await readFile(resolve(terraformDir, 'main.tf.json'))) !== configurationHash) throw new Error('Generated Terraform configuration changed; run plan again');
    await run('terraform', ['apply', '-input=false', 'deployment.tfplan'], { cwd: terraformDir });
    await writePrivate(resolve(directory, 'applied.json'), JSON.stringify({ ...planned, appliedAt: new Date().toISOString() }) + '\n');
  }
}
main().catch(error => { console.error('VPN: ' + error.message); process.exitCode = 1; });
