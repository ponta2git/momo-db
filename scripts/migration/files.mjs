import { createHash } from 'node:crypto';

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
