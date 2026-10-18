import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Writable } from 'node:stream';

const magic = Buffer.from('MOMODB01');
const headerSize = magic.length + 12;

export class RehearsalError extends Error {
  constructor(code) {
    super(code);
    this.name = 'RehearsalError';
    this.code = code;
  }
}

export function requireCondition(condition, code) {
  if (!condition) throw new RehearsalError(code);
}

export function digest(value) {
  return createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
}

export async function fileDigest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function privateFile(path) {
  const info = await lstat(path);
  requireCondition(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o077) === 0 &&
    (process.getuid === undefined || info.uid === process.getuid()), 'PRIVATE_FILE_REQUIRED');
}

export async function privateDirectory(path) {
  const info = await lstat(path);
  requireCondition(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0 &&
    (process.getuid === undefined || info.uid === process.getuid()), 'PRIVATE_DIRECTORY_REQUIRED');
}

export async function createWorkspace(path, repository) {
  requireCondition(isAbsolute(path), 'ABSOLUTE_RUN_DIRECTORY_REQUIRED');
  const parent = await realpath(dirname(path));
  const target = resolve(parent, path.slice(dirname(path).length + 1));
  const repo = await realpath(repository);
  const inside = relative(repo, target);
  requireCondition((inside === '..' || inside.startsWith(`..${sep}`)) && !isAbsolute(inside), 'RUN_DIRECTORY_MUST_BE_OUTSIDE_REPOSITORY');
  await mkdir(target, { mode: 0o700 });
  await chmod(target, 0o700);
  return target;
}

export async function createKey(path) {
  requireCondition(isAbsolute(path), 'ABSOLUTE_KEY_PATH_REQUIRED');
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(randomBytes(32)); await handle.sync(); }
  finally { await handle.close(); }
}

export async function loadKey(path) {
  await privateFile(path);
  const key = await readFile(path);
  requireCondition(key.length === 32, 'INVALID_ENCRYPTION_KEY');
  return key;
}

export async function encryptStream(input, destination, key) {
  const temporary = `${destination}.${randomUUID()}.partial`;
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(magic);
  const output = createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
  try {
    output.write(Buffer.concat([magic, nonce]));
    await pipeline(input, cipher, output);
    const handle = await open(temporary, 'a');
    try { await handle.writeFile(cipher.getAuthTag()); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function decryptStream(path, output, key) {
  await privateFile(path);
  const info = await stat(path);
  requireCondition(info.size >= headerSize + 16, 'INVALID_ENCRYPTED_ARCHIVE');
  const handle = await open(path, 'r');
  const header = Buffer.alloc(headerSize);
  const tag = Buffer.alloc(16);
  try {
    await handle.read(header, 0, header.length, 0);
    await handle.read(tag, 0, tag.length, info.size - tag.length);
  } finally { await handle.close(); }
  requireCondition(header.subarray(0, magic.length).equals(magic), 'INVALID_ENCRYPTED_ARCHIVE');
  const pass = async destination => {
    const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(magic.length));
    decipher.setAAD(magic);
    decipher.setAuthTag(tag);
    const input = info.size === headerSize + 16 ? Readable.from([]) :
      createReadStream(path, { start: headerSize, end: info.size - 17 });
    await pipeline(input, decipher, destination);
  };
  // GCM authenticates only at EOF. Complete a bounded-memory authentication
  // pass before delivering any bytes to a database restore or JSON consumer.
  await pass(new Writable({ write(_chunk, _encoding, callback) { callback(); } }));
  const authenticated = await stat(path);
  requireCondition(authenticated.ino === info.ino && authenticated.size === info.size &&
    authenticated.mtimeMs === info.mtimeMs && authenticated.ctimeMs === info.ctimeMs, 'ARCHIVE_CHANGED_DURING_AUTHENTICATION');
  await pass(output);
}

export async function writeJson(path, value, key) {
  const { Readable } = await import('node:stream');
  await encryptStream(Readable.from([JSON.stringify(value, null, 2) + '\n']), path, key);
}

export async function readJson(path, key) {
  const { Writable } = await import('node:stream');
  const chunks = [];
  let size = 0;
  await decryptStream(path, new Writable({
    write(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) callback(new RehearsalError('MANIFEST_TOO_LARGE'));
      else { chunks.push(chunk); callback(); }
    },
  }), key);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function withRunLock(directory, operation) {
  await privateDirectory(directory);
  const path = resolve(directory, 'operation.lock');
  let handle;
  try { handle = await open(path, 'wx', 0o600); }
  catch { throw new RehearsalError('RUN_LOCKED_INSPECT_BEFORE_RETRY'); }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    await handle.sync();
    return await operation();
  } finally { await handle.close(); await rm(path); }
}
