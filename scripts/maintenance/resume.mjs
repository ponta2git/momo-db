import { ControlError, digest, transition, validateControl } from './control.mjs';
import { assertDrain, assertFrozenReadiness, assertSecretStage, assertSecretsUnchanged, assertStagedBootConfiguration,
  check, modeKey, same, validateDatabaseProof, validateExternalEvidence, validateMachineTargets } from './freeze-contract.mjs';
import { isConverged } from './freeze-database.mjs';

const clock = dependencies => dependencies.now?.() ?? Date.now();
const apps = plan => [...new Set(plan.targets.map(target => target.app))];
const key = target => `${target.app}:${target.id}`;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const pause = dependencies => dependencies.pause ? dependencies.pause() : new Promise(resolve => setTimeout(resolve, 1000));
const budget = (plan, dependencies, duration = 0) => check(clock(dependencies) + duration < Date.parse(plan.deadline) - plan.recoveryReserveMs,
  'RESUME_TIME_BUDGET_EXHAUSTED');
export const stabilityChecks = ['admissions', 'queues-and-leases', 'analysis-publication', 'notifications', 'legacy-urls-and-auth', 'abnormal-rates'];

function assertControl(record, plan, phase) {
  validateControl(record);
  const current = record.cutover;
  check(current?.id === plan.cutoverId && current.stopEpoch === plan.stopEpoch && current.phase === phase &&
    same(current.candidates, plan.candidates) && current.evidence[plan.readinessKey] === plan.readinessDigest, 'RESUME_CONTROL_CHANGED');
}

async function inventory(plan, provider) {
  for (const app of apps(plan)) check(same((await provider.list(app)).map(item => item.id).sort(),
    plan.targets.filter(item => item.app === app).map(item => item.id).sort()), 'PROVIDER_MACHINE_INVENTORY_CHANGED');
}

async function current(plan, dependencies, phase) {
  const value = await dependencies.store.read(); assertControl(value.record, plan, phase); return value;
}

async function barrier(plan, dependencies, phase) {
  const value = await current(plan, dependencies, phase);
  const deployment = await dependencies.verifyDeployment(value.record, plan.approvals);
  check(digest(deployment) === plan.deploymentFreezeDigest, 'DEPLOYMENT_FREEZE_CHANGED');
  validateExternalEvidence(plan.externalEvidence, value.record, deployment, clock(dependencies));
}

async function observe(plan, state, dependencies, { frozen = false } = {}) {
  await inventory(plan, dependencies.provider);
  for (const app of apps(plan)) assertSecretsUnchanged(state.secrets[app], await dependencies.provider.secrets(app));
  for (const target of plan.targets) {
    check(same(await dependencies.provider.inspect(target), state.machines[key(target)]), 'RESUME_MACHINE_CHANGED');
    if (frozen) {
      assertFrozenReadiness(target.role, await dependencies.provider.process(target, 'readiness'), plan.database);
      if (target.role === 'worker') assertDrain('worker', await dependencies.provider.process(target, 'status'), null, 'frozen');
      check(same(await dependencies.provider.inspect(target), state.machines[key(target)]), 'PROCESS_MACHINE_CHANGED');
    }
  }
  check(same(await dependencies.inspectConnection(), plan.database), 'RESUME_DATABASE_CHANGED');
}

export async function prepareResume(input, dependencies) {
  const { record } = await dependencies.store.read(); validateControl(record);
  const cutover = record.cutover;
  check(['READY_TO_RESUME', 'RECOVERY_READY'].includes(cutover?.phase), 'REVIEWED_RESUME_READINESS_REQUIRED');
  const recovery = cutover.phase === 'RECOVERY_READY';
  const readinessKey = recovery ? 'recoveryReadiness' : 'resumeReadiness';
  check(input?.formatVersion === 1 && input.readiness?.formatVersion === 1 &&
    digest(input.readiness) === cutover.evidence[readinessKey] && hash(input.readiness.acceptanceDigest), 'RESUME_READINESS_CHANGED');
  const targets = input.readiness.targets; validateMachineTargets(targets);
  validateDatabaseProof(input.readiness.database);
  check(Number.isFinite(Date.parse(input.deadline)) && Number.isSafeInteger(input.recoveryReserveMs) && input.recoveryReserveMs > 0,
    'INVALID_RESUME_TIME_BUDGET');
  const plan = { ...structuredClone(input), cutoverId: cutover.id, stopEpoch: cutover.stopEpoch, candidates: cutover.candidates,
    readinessKey, readinessDigest: digest(input.readiness), initialPhase: cutover.phase,
    openingPhase: recovery ? 'RECOVERY_REOPENING' : 'REOPENING', finalPhase: recovery ? 'RECOVERY_RESUMED' : 'RESUMED',
    targets, database: input.readiness.database, machines: {}, secrets: {}, createdAt: new Date(clock(dependencies)).toISOString() };
  budget(plan, dependencies, 120000);
  const deployment = await dependencies.verifyDeployment(record, plan.approvals);
  plan.deploymentFreezeDigest = digest(deployment);
  validateExternalEvidence(plan.externalEvidence, record, deployment, clock(dependencies));
  await inventory(plan, dependencies.provider);
  for (const app of apps(plan)) {
    const secrets = await dependencies.provider.secrets(app);
    check(secrets.every(item => item.status === 'Deployed') && secrets.some(item => item.name === modeKey), 'DEPLOYED_FROZEN_SECRET_REQUIRED');
    plan.secrets[app] = secrets;
  }
  for (const target of targets) {
    const machine = await dependencies.provider.inspect(target);
    check(machine.id === target.id && machine.image === target.image && digest(machine.config) === target.configDigest &&
      machine.config.env?.[modeKey] === 'frozen', 'FROZEN_RELEASE_COMBINATION_REQUIRED');
    assertStagedBootConfiguration(machine.config);
    plan.machines[key(target)] = machine;
  }
  await observe(plan, plan, dependencies, { frozen: true });
  const convergence = await dependencies.inspectDatabase();
  check(same(convergence.database, plan.database) && isConverged(convergence, true), 'RESUME_WORK_NOT_SETTLED');
  await current(plan, dependencies, plan.initialPhase);
  return plan;
}

export async function executeResume(plan, dependencies) {
  const { provider, save } = dependencies;
  check(typeof save === 'function', 'DURABLE_PRIVATE_JOURNAL_REQUIRED');
  const state = { formatVersion: 1, planDigest: digest(plan), status: 'started', step: 'preflight',
    machines: structuredClone(plan.machines), secrets: structuredClone(plan.secrets), receipts: {} };
  let opening = false;
  const persist = async (status, step) => {
    state.status = status; state.step = step; state.updatedAt = new Date(clock(dependencies)).toISOString(); await save(state);
  };
  const guard = async () => {
    budget(plan, dependencies);
    await barrier(plan, dependencies, plan.openingPhase);
    await observe(plan, state, dependencies);
    return current(plan, dependencies, plan.openingPhase);
  };
  const mutate = async (step, operation) => {
    await persist('mutation-started', step);
    await guard(); budget(plan, dependencies, 120000);
    const result = await operation();
    await persist('mutation-observed', step); return result;
  };
  await persist('started', 'preflight');
  try {
    budget(plan, dependencies, 120000);
    await barrier(plan, dependencies, plan.initialPhase);
    await observe(plan, state, dependencies, { frozen: true });
    const convergence = await dependencies.inspectDatabase();
    check(same(convergence.database, plan.database) && isConverged(convergence, true), 'RESUME_WORK_NOT_SETTLED');
    const boundary = { formatVersion: 1, cutoverId: plan.cutoverId, stopEpoch: plan.stopEpoch, candidates: plan.candidates,
      planDigest: digest(plan), readinessDigest: plan.readinessDigest, database: plan.database,
      openedAt: new Date(clock(dependencies)).toISOString(), convergenceDigest: digest(convergence) };
    state.boundary = boundary;
    await persist('recording-boundary', 'record-reopening');
    const before = await current(plan, dependencies, plan.initialPhase);
    // The staged normal secret alone can open a restarting VM. Publish the
    // irreversible write boundary BEFORE staging any normal boot setting.
    await dependencies.store.compareAndSwap(before, transition(before.record, before.record.stateVersion, 'advance', {
      cutoverId: plan.cutoverId, stopEpoch: plan.stopEpoch, phase: plan.openingPhase, evidenceDigest: digest(boundary),
    }, new Date(clock(dependencies)).toISOString()));
    opening = true;
    await persist('reopening-recorded', 'stage-normal-boot');
    for (const app of apps(plan)) {
      const target = plan.targets.find(item => item.app === app);
      await mutate('stage-normal-boot', () => provider.stage(target, () => current(plan, dependencies, plan.openingPhase), 'normal'));
      const staged = await provider.secrets(app);
      assertSecretStage(state.secrets[app], staged);
      state.secrets[app] = staged;
      await persist('normal-boot-staged', 'stage-normal-boot');
    }
    // Start the notification receiver before senders and reopen admission last.
    for (const role of ['summit', 'worker', 'api']) for (const target of plan.targets.filter(item => item.role === role)) {
      const updated = await mutate(`reopen-${role}`, () => provider.reopen(target, state.machines[key(target)],
        () => current(plan, dependencies, plan.openingPhase)));
      for (;;) {
        budget(plan, dependencies); await current(plan, dependencies, plan.openingPhase);
        try {
          const observed = await provider.inspect(target);
          check(observed.instance === updated.instance && same(observed.config, updated.config) && observed.image === updated.image,
            'REOPENED_MACHINE_CONFIGURATION_CHANGED');
          state.machines[key(target)] = observed; break;
        } catch (error) {
          if (!['RUNNING_MACHINE_EVIDENCE_REQUIRED', 'PROCESS_COMMAND_FAILED'].includes(error.code)) throw error;
          await pause(dependencies);
        }
      }
      for (;;) {
        budget(plan, dependencies); await current(plan, dependencies, plan.openingPhase);
        let receipt;
        try { receipt = await provider.process(target, 'status'); }
        catch (error) { if (error.code !== 'PROCESS_COMMAND_FAILED') throw error; await pause(dependencies); continue; }
        assertDrain(role, receipt, null, 'normal');
        check(same(await provider.inspect(target), state.machines[key(target)]), 'PROCESS_MACHINE_CHANGED');
        state.receipts[key(target)] = receipt; break;
      }
      await persist('normal-boot-verified', `reopen-${role}`);
    }
    await guard();
    const proof = { formatVersion: 1, planDigest: digest(plan), boundary, machines: state.machines,
      secrets: state.secrets, receipts: state.receipts, completedAt: new Date(clock(dependencies)).toISOString() };
    state.proof = proof;
    await persist('opened-awaiting-stability', 'observe-normal-service');
    return proof;
  } catch (error) {
    state.failure = error instanceof ControlError ? error.code : 'RESUME_EXECUTION_FAILED';
    // Even a CAS whose response was lost may have crossed the boundary. No
    // catch path stages frozen, resets the epoch, or restores the old backup.
    state.boundaryMayBeRecorded = opening || Boolean(state.boundary);
    await persist('failed-inspect-before-retry', state.step).catch(() => {});
    throw new ControlError(state.failure);
  }
}

export async function certifyStability(plan, proof, acceptance, dependencies) {
  check(proof?.planDigest === digest(plan), 'RESUME_PROOF_CHANGED');
  const { record } = await current(plan, dependencies, plan.openingPhase);
  const boundaryKey = plan.openingPhase === 'REOPENING' ? 'reopenBoundary' : 'recoveryReopenBoundary';
  check(record.cutover.evidence[boundaryKey] === digest(proof.boundary), 'REOPEN_BOUNDARY_CHANGED');
  const now = clock(dependencies);
  check(acceptance?.formatVersion === 1 && acceptance.operator === record.operator && acceptance.resumeProofDigest === digest(proof) &&
    acceptance.cutoverId === plan.cutoverId && acceptance.stopEpoch === plan.stopEpoch && same(acceptance.incomplete, []) &&
    Number.isFinite(Date.parse(acceptance.observedAt)) && Date.parse(acceptance.observedAt) >= Date.parse(proof.completedAt) &&
    Date.parse(acceptance.observedAt) <= now && Number.isFinite(Date.parse(acceptance.validUntil)) && now < Date.parse(acceptance.validUntil) &&
    Array.isArray(acceptance.checks) && acceptance.checks.length === stabilityChecks.length && stabilityChecks.every(kind =>
      acceptance.checks.filter(item => item.kind === kind && item.outcome === 'passed' && hash(item.reportDigest)).length === 1),
  'STABILITY_ACCEPTANCE_INCOMPLETE');
  await barrier(plan, dependencies, plan.openingPhase);
  await observe(plan, proof, dependencies);
  for (const target of plan.targets) assertDrain(target.role, await dependencies.provider.process(target, 'status'), null, 'normal');
  await observe(plan, proof, dependencies);
  const result = { formatVersion: 1, cutoverId: plan.cutoverId, stopEpoch: plan.stopEpoch, candidates: plan.candidates,
    database: plan.database, resumeProofDigest: digest(proof), acceptanceDigest: digest(acceptance), verifiedAt: new Date(now).toISOString() };
  await dependencies.save(result);
  const previous = await current(plan, dependencies, plan.openingPhase);
  check(previous.record.cutover.evidence[boundaryKey] === digest(proof.boundary), 'REOPEN_BOUNDARY_CHANGED');
  await dependencies.store.compareAndSwap(previous, transition(previous.record, previous.record.stateVersion, 'advance', {
    cutoverId: plan.cutoverId, stopEpoch: plan.stopEpoch, phase: plan.finalPhase, evidenceDigest: digest(result),
  }, new Date(clock(dependencies)).toISOString()));
  return result;
}
