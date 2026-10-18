import { command } from '../migration/process.mjs';
import { ControlError } from './control.mjs';
import { check, same, machineIdentity, modeKey, validateSecrets } from './freeze-contract.mjs';

const part = value => {
  check(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value), 'INVALID_PROVIDER_TARGET');
  return value;
};
const path = target => `/apps/${part(target.app)}/machines/${part(target.id)}`;
const parse = value => { try { return JSON.parse(value); } catch { throw new ControlError('INVALID_PROVIDER_RESPONSE'); } };

export function processCommand(role, action, request) {
  check(['status', 'readiness', 'drain'].includes(action), 'INVALID_PROCESS_OPERATION');
  check((action === 'drain') === Boolean(request), 'INVALID_PROCESS_OPERATION');
  if (request) check(part(request.cutoverId) && Number.isSafeInteger(request.stopEpoch) && request.stopEpoch > 0 &&
    ['admission', 'all'].includes(request.stage), 'INVALID_PROCESS_OPERATION');
  if (role === 'summit') return ['node', '/app/summit/dist/startup/maintenanceCli.js', action,
    ...(request ? [request.cutoverId, String(request.stopEpoch), request.stage] : [])];
  const flags = request ? ['--cutover-id', request.cutoverId, '--stop-epoch', String(request.stopEpoch), '--stage', request.stage] : [];
  if (role === 'api') return ['/opt/momo-result/bin/momo-runtime-tool',
    ...(action === 'readiness' ? ['smoke', 'maintenance'] : ['maintenance', action, ...flags])];
  check(role === 'worker', 'INVALID_CONSUMER_ROLE');
  return ['/usr/local/bin/momo-processing-worker', 'bootstrap', '--', `maintenance-${action}`, ...flags];
}

export async function createFlyProvider({ token = process.env.FLY_API_TOKEN, fetcher = fetch, run = command } = {}) {
  token ??= await run('flyctl', ['auth', 'token'], { maxBytes: 16384, signal: AbortSignal.timeout(30000) });
  check(typeof token === 'string' && token.length > 0 && !/[\r\n\0]/.test(token), 'PROVIDER_TOKEN_REQUIRED');
  const env = { ...process.env, FLY_API_TOKEN: token, NO_COLOR: '1' };
  const cli = args => run('flyctl', args, { env, maxBytes: 1024 * 1024, signal: AbortSignal.timeout(45000) });
  const request = async (resource, method = 'GET', body, nonce) => {
    try {
      const response = await fetcher(`https://api.machines.dev/v1${resource}`, { method, redirect: 'error',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(nonce ? { 'fly-machine-lease-nonce': nonce } : {}) },
        signal: AbortSignal.timeout(30000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      check(response.ok, 'PROVIDER_REQUEST_FAILED');
      if (response.status === 204) return null;
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        check(size <= 4 * 1024 * 1024, 'PROVIDER_RESPONSE_TOO_LARGE');
        chunks.push(chunk);
      }
      return parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) { throw error instanceof ControlError ? error : new ControlError('PROVIDER_REQUEST_FAILED'); }
  };
  const exec = async (target, args) => {
    // Every argument is a fixed command or a validated identifier. No secret,
    // shell expression, operator-supplied path or arbitrary command is accepted.
    const result = parse(await cli(['machine', 'exec', part(target.id), args.join(' '), '--app', part(target.app), '--json', '--timeout', '25']));
    // fly-go omits exit_code when it is zero (omitempty).
    check((result.exit_code === 0 || result.exit_code === undefined) && (result.exit_signal === 0 || result.exit_signal === undefined) &&
      typeof result.stdout === 'string' && result.stdout.length <= 16384, 'PROCESS_COMMAND_FAILED');
    return result.stdout.trim();
  };
  const provider = {
    async list(app) {
      const machines = await request(`/apps/${part(app)}/machines`);
      check(Array.isArray(machines), 'INVALID_PROVIDER_MACHINE_INVENTORY');
      return machines;
    },
    async inspect(target) {
      const before = machineIdentity(await request(path(target)));
      const bootId = await exec(target, ['cat', '/proc/sys/kernel/random/boot_id']);
      const after = machineIdentity(await request(path(target)));
      check(same(before, after) && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(bootId), 'MACHINE_RESTARTED_DURING_INSPECTION');
      return { ...after, bootId };
    },
    async secrets(app) { return validateSecrets(parse(await cli(['secrets', 'list', '--app', part(app), '--json']))); },
    async stage(target, guard, mode = 'frozen') {
      check(['frozen', 'normal'].includes(mode), 'INVALID_MAINTENANCE_MODE');
      await guard();
      await cli(['secrets', 'set', `${modeKey}=${mode}`, '--stage', '--app', part(target.app)]);
    },
    async process(target, action, input) { return parse(await exec(target, processCommand(target.role, action, input))); },
    async freeze(target, original, guard) {
      return updateMode(target, original, guard, 'frozen');
    },
    async reopen(target, original, guard) {
      return updateMode(target, original, guard, 'normal');
    },
  };
  async function updateMode(target, original, guard, mode) {
    const resource = path(target);
    const lease = await request(`${resource}/lease`, 'POST', { ttl: 120, description: `maintenance-${mode}` });
    const nonce = lease?.data?.nonce;
    check(typeof nonce === 'string' && nonce.length > 0, 'MACHINE_LEASE_UNAVAILABLE');
    try {
      check(lease.data.version === original.instance, 'MACHINE_LEASE_VERSION_CHANGED');
      check(same(await provider.inspect(target), original), 'MACHINE_CHANGED_BEFORE_UPDATE');
      const config = { ...original.config, image: original.image, env: { ...original.config.env, [modeKey]: mode } };
      await guard();
      const updated = await request(resource, 'POST', { config, current_version: original.instance, skip_secrets: false }, nonce);
      check(updated?.id === target.id && typeof updated.instance_id === 'string' &&
        updated.instance_id !== original.instance && same(updated.config, config), 'MACHINE_UPDATE_RESULT_UNKNOWN');
      return { instance: updated.instance_id, config, image: original.image };
    } finally {
      // Release only the lease acquired by this invocation. A release failure
      // is also uncertain; never hide it and report the operation as success.
      await request(`${resource}/lease`, 'DELETE', undefined, nonce);
    }
  }
  return provider;
}
