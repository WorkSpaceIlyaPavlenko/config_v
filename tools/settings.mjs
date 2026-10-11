import { parseEnv } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ROOT, identifier } from './config.mjs';

export const ENV_OPTIONS = {
  VPN_NODE: 'node', VPN_DOMAIN: 'domain', VPN_ADDRESS: 'address',
  VPN_DOCKER_HOST: 'docker-host', VPN_PORT: 'port', VPN_HTTP_PORT: 'http-port',
  VPN_BIND_ADDRESS: 'bind-address', VPN_DNS_SERVERS: 'dns-servers',
  VPN_XRAY_MEMORY_MB: 'xray-memory-mb', VPN_CADDY_MEMORY_MB: 'caddy-memory-mb',
  VPN_XRAY_CPUS: 'xray-cpus', VPN_CADDY_CPUS: 'caddy-cpus', VPN_CLIENT: 'client',
  VPN_VM_HOSTNAME: 'vm-hostname', VPN_VM_DNS_SERVERS: 'vm-dns-servers'
};
const switches = ['local', 'production', 'prepare-only', 'plan-only', 'help'];
const values = [...Object.values(ENV_OPTIONS), 'env-file', 'target'];

export function parseArguments(args, command = 'init') {
  const result = {};
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    const name = argument.startsWith('--') ? argument.slice(2) : '';
    if (![...switches, ...values].includes(name) || Object.hasOwn(result, name)) throw new Error('Unknown or repeated argument; use --help');
    if (command === 'restart' && !['node', 'env-file', 'help', 'target'].includes(name)) throw new Error('restart accepts --node, --env-file and --target; use init to change configuration');
    if (command === 'init' && name === 'target') throw new Error('--target applies only to restart');
    if (switches.includes(name)) result[name] = true;
    else {
      if (args[index + 1] === undefined || args[index + 1].startsWith('--')) throw new Error('Missing value for --' + name);
      result[name] = args[++index];
    }
  }
  if (result.local && result.production) throw new Error('Choose either --local or --production');
  if (result['prepare-only'] && result['plan-only']) throw new Error('Choose either --prepare-only or --plan-only');
  return result;
}

export function environmentOptions(env) {
  const result = {};
  for (const key of Object.keys(env)) {
    if (key.startsWith('VPN_') && key !== 'VPN_MODE' && !Object.hasOwn(ENV_OPTIONS, key)) throw new Error('Unknown VPN_ setting: ' + key);
  }
  for (const [key, option] of Object.entries(ENV_OPTIONS)) {
    if (env[key] !== undefined && (env[key] !== '' || ['VPN_DNS_SERVERS', 'VPN_VM_DNS_SERVERS'].includes(key))) result[option] = env[key];
  }
  if (env.VPN_MODE) {
    if (!['local', 'production'].includes(env.VPN_MODE)) throw new Error('VPN_MODE must be local or production');
    result.local = env.VPN_MODE === 'local';
  }
  return result;
}

export async function readSettings(args, { command = 'init', root = ROOT, env = process.env } = {}) {
  const flags = parseArguments(args, command);
  const path = resolve(root, flags['env-file'] || '.env');
  let file = {};
  try { file = parseEnv(await readFile(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT' || flags['env-file']) throw error; }
  const options = { ...environmentOptions({ ...file, ...env }), ...flags };
  if (flags.production) options.local = false;
  for (const key of ['production', 'prepare-only', 'plan-only', 'env-file', 'help', 'target']) delete options[key];
  if (command === 'restart') {
    // Restart uses the saved endpoint and configuration, never mutable .env settings.
    return { options: options.node === undefined ? {} : { node: identifier(options.node) }, flags };
  }
  return { options, flags };
}

export async function collectSettings(options, { exists, ask } = {}) {
  const next = { ...options };
  if (next.node) {
    identifier(next.node);
    if (await exists(next.node)) return next;
  }
  if (next.local === undefined && (next.domain || next['docker-host'])) next.local = false;
  if (next.local === undefined) {
    if (!ask) throw new Error('Choose --local, or provide production settings in .env; use --help');
    const mode = (await ask('Режим (local / production)', 'local')).trim();
    if (!['local', 'production'].includes(mode)) throw new Error('Режим должен быть local или production');
    next.local = mode === 'local';
  }
  if (!next.node) next.node = next.local ? 'local' : ask ? await ask('Имя узла', 'de-main') : undefined;
  if (!next.node) throw new Error('Set --node or VPN_NODE for a production node');
  identifier(next.node);
  if (await exists(next.node)) return next;
  if (!next.local) {
    if (!next.domain && ask) next.domain = await ask('Собственный домен, направленный на VPS', '');
    if (!next['docker-host'] && ask) next['docker-host'] = await ask('Docker на VPS через SSH (ssh://user@host)', '');
    if (!next.domain || !next['docker-host']) throw new Error('Production requires VPN_DOMAIN and VPN_DOCKER_HOST (ssh://user@host)');
  }
  return next;
}
