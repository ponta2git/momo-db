#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { expectedMigrationHistory } from '../check-migration-history.mjs';
import { digest, fileDigest } from '../migration/files.mjs';
import { command } from '../migration/process.mjs';

try {
  const sha = await command('git', ['rev-parse', 'HEAD']);
  if (process.env.GITHUB_EVENT_NAME !== 'push' || process.env.GITHUB_REF !== 'refs/heads/master' ||
      process.env.GITHUB_SHA !== sha || !/^[a-f0-9]{40}$/.test(sha) ||
      !/^[1-9][0-9]*$/.test(process.env.GITHUB_RUN_ID ?? '') ||
      !/^[1-9][0-9]*$/.test(process.env.GITHUB_RUN_ATTEMPT ?? '')) throw new Error();
  await writeFile('database-candidate.json', JSON.stringify({ formatVersion: 1, repository: 'ponta2git/momo-db', sha,
    producerRunId: process.env.GITHUB_RUN_ID, producerRunAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    migrationDigest: digest(expectedMigrationHistory()), lockDigest: await fileDigest('pnpm-lock.yaml'),
    configDigest: await fileDigest('drizzle.config.ts') }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
} catch {
  console.error('DATABASE_CANDIDATE_PROOF_FAILED');
  process.exitCode = 1;
}
