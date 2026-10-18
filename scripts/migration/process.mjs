import { spawn } from 'node:child_process';
import { RehearsalError } from './files.mjs';

// Child diagnostics can contain credentials or production row values. Never expose
// them through Error.message, inherited stdio, or a command-line reproduction.
export function start(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    signal: options.signal,
  });
  child.stderr.resume();
  const completed = new Promise((resolve, reject) => {
    child.once('error', () => reject(new RehearsalError('CHILD_START_FAILED')));
    child.once('close', (code, signal) => {
      if (code === 0 && !signal) resolve();
      else reject(new RehearsalError(options.failureCode ?? 'CHILD_COMMAND_FAILED'));
    });
  });
  // Streaming callers settle both the stream and the exit status together.
  completed.catch(() => {});
  return { child, completed };
}

export async function command(commandName, args, options = {}) {
  const { child, completed } = start(commandName, args, options);
  child.stdin.end();
  const chunks = [];
  let bytes = 0;
  for await (const chunk of child.stdout) {
    bytes += chunk.length;
    if (bytes > (options.maxBytes ?? 4 * 1024 * 1024)) {
      child.kill('SIGKILL');
      await completed.catch(() => {});
      throw new RehearsalError('COMMAND_OUTPUT_TOO_LARGE');
    }
    chunks.push(chunk);
  }
  await completed;
  return Buffer.concat(chunks).toString('utf8').trim();
}
