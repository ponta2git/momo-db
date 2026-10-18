import { spawn } from 'node:child_process';
import { ControlError, canonicalJson, validateControl, digest } from './control.mjs';

export const controlRepository = 'ponta2git/momo-db';
export const controlBranch = 'maintenance-control';
const fail = code => { throw new ControlError(code); };

export async function githubApi(path, { method = 'GET', body } = {}) {
  const args = ['api', '--method', method, '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2026-03-10', path];
  if (body !== undefined) args.push('--input', '-');
  const child = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  child.stderr.resume();
  child.stdin.on('error', () => {});
  const timeout = setTimeout(() => child.kill('SIGKILL'), 120000);
  timeout.unref();
  child.once('close', () => clearTimeout(timeout));
  child.once('error', () => clearTimeout(timeout));
  child.stdin.end(body === undefined ? undefined : JSON.stringify(body));
  const chunks = [];
  let size = 0;
  const completed = new Promise((resolve, reject) => {
    child.once('error', () => reject(new ControlError('GITHUB_REQUEST_FAILED')));
    child.once('close', code => code === 0 ? resolve() : reject(new ControlError('GITHUB_REQUEST_FAILED')));
  });
  completed.catch(() => {});
  for await (const chunk of child.stdout) {
    size += chunk.length;
    if (size > 1024 * 1024) {
      child.kill('SIGKILL');
      await completed.catch(() => {});
      fail('GITHUB_RESPONSE_TOO_LARGE');
    }
    chunks.push(chunk);
  }
  await completed;
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('INVALID_GITHUB_RESPONSE'); }
}

export function createStore(request = githubApi) {
  const root = `repos/${controlRepository}`;
  const get = path => request(`${root}/${path}`);
  const post = (path, body) => request(`${root}/${path}`, { method: 'POST', body });
  const blob = async record => {
    validateControl(record);
    return post('git/blobs', { content: Buffer.from(canonicalJson(record) + '\n').toString('base64'), encoding: 'base64' });
  };
  const operator = async record => {
    const user = await request('user');
    if (user.login !== record.operator) fail('CONTROL_OPERATOR_REQUIRED');
  };
  return {
    async read() {
      // Resolve the mutable ref once, then read only immutable Git objects.
      const ref = await get(`git/ref/heads/${controlBranch}`);
      const head = ref.object?.sha;
      if (!/^[a-f0-9]{40}$/.test(head ?? '') || ref.object.type !== 'commit') fail('INVALID_CONTROL_REF');
      const commit = await get(`git/commits/${head}`);
      const file = await get(`contents/control.json?ref=${head}`);
      if (file.type !== 'file' || file.encoding !== 'base64' || file.size > 65536) fail('INVALID_CONTROL_FILE');
      let record;
      try { record = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')); }
      catch { fail('INVALID_CONTROL_FILE'); }
      validateControl(record);
      return { head, tree: commit.tree.sha, record, digest: digest(record) };
    },
    async initialize(record) {
      validateControl(record);
      if (record.stateVersion !== 1 || record.cutover !== null) fail('INITIAL_NORMAL_RECORD_REQUIRED');
      await operator(record);
      const value = await blob(record);
      const tree = await post('git/trees', { tree: [{ path: 'control.json', mode: '100644', type: 'blob', sha: value.sha }] });
      const commit = await post('git/commits', { message: 'maintenance: initialize control', tree: tree.sha, parents: [] });
      // Creating an existing ref fails. This never resets an active cutover.
      await post('git/refs', { ref: `refs/heads/${controlBranch}`, sha: commit.sha });
      return { head: commit.sha, record, digest: digest(record) };
    },
    async compareAndSwap(previous, record) {
      validateControl(previous.record);
      validateControl(record);
      if (record.stateVersion !== previous.record.stateVersion + 1 || record.operator !== previous.record.operator) fail('INVALID_CONTROL_SUCCESSOR');
      await operator(record);
      const current = await this.read();
      if (current.head !== previous.head || current.digest !== previous.digest) fail('STALE_CONTROL_HEAD');
      const value = await blob(record);
      const tree = await post('git/trees', { base_tree: previous.tree,
        tree: [{ path: 'control.json', mode: '100644', type: 'blob', sha: value.sha }] });
      const commit = await post('git/commits', { message: `maintenance: record state ${record.stateVersion}`, tree: tree.sha, parents: [previous.head] });
      // Concurrent successors have the same parent and cannot both fast-forward.
      // Never use force=true, delete the ref, or retry with a newly read parent.
      const updated = await request(`${root}/git/refs/heads/${controlBranch}`, {
        method: 'PATCH', body: { sha: commit.sha, force: false },
      });
      if (updated.object?.sha !== commit.sha) fail('CONTROL_UPDATE_RESULT_UNKNOWN');
      return { head: commit.sha, record, digest: digest(record) };
    },
  };
}
