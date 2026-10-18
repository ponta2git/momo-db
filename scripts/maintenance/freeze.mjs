import { ControlError, digest, transition } from './control.mjs';
import { assertDrain, assertFrozenReadiness, assertSecretStage, assertSecretsUnchanged, assertStagedBootConfiguration, assertStop, check,
  modeKey, same, validateExternalEvidence, validateFreezeInput } from './freeze-contract.mjs';
import { isConverged } from './freeze-database.mjs';

const apps = plan => [...new Set(plan.targets.map(target => target.app))];
const key = target => `${target.app}:${target.id}`;
const clock = dependencies => dependencies.now?.() ?? Date.now();
const budget = (plan, dependencies) => check(clock(dependencies) < Date.parse(plan.deadline) - plan.recoveryReserveMs,
  'FREEZE_TIME_BUDGET_EXHAUSTED');
const pause = dependencies => dependencies.pause ? dependencies.pause() : new Promise(resolve => setTimeout(resolve, 1000));

async function inventory(plan, provider) {
  for (const app of apps(plan)) {
    const actual = await provider.list(app);
    check(same(actual.map(item => item.id).sort(), plan.targets.filter(item => item.app === app).map(item => item.id).sort()),
      'PROVIDER_MACHINE_INVENTORY_CHANGED');
  }
}

async function control(plan, dependencies, phase = 'DRAINING') {
  budget(plan, dependencies);
  const current = await dependencies.store.read();
  assertStop(current.record, plan, phase);
  return current;
}

async function barrier(plan, dependencies) {
  const current = await dependencies.store.read();
  assertStop(current.record, plan);
  const deployment = await dependencies.verifyDeployment(current.record, plan.approvals);
  check(digest(deployment) === plan.deploymentFreezeDigest, 'DEPLOYMENT_FREEZE_CHANGED');
  validateExternalEvidence(plan.externalEvidence, current.record, deployment, clock(dependencies));
}

export async function prepareFreeze(input, dependencies) {
  const current = await dependencies.store.read();
  validateFreezeInput(input, current.record, clock(dependencies));
  const cutover = current.record.cutover;
  const plan = { ...structuredClone(input), cutoverId: cutover.id, stopEpoch: cutover.stopEpoch,
    candidates: cutover.candidates, deploymentFreezeDigest: cutover.evidence.deploymentFreeze,
    createdAt: new Date(clock(dependencies)).toISOString(), machines: {}, secrets: {} };
  await barrier(plan, dependencies);
  await inventory(plan, dependencies.provider);
  for (const app of apps(plan)) {
    const secrets = await dependencies.provider.secrets(app);
    check(secrets.every(item => item.status === 'Deployed'), 'UNRELATED_STAGED_SECRETS_PRESENT');
    plan.secrets[app] = secrets;
  }
  for (const target of plan.targets) {
    const observed = await dependencies.provider.inspect(target);
    check(observed.id === target.id && observed.image === target.image && digest(observed.config) === target.configDigest &&
      [undefined, 'normal'].includes(observed.config.env?.[modeKey]), 'PREPARATION_RELEASE_CHANGED');
    assertStagedBootConfiguration(observed.config);
    assertDrain(target.role, await dependencies.provider.process(target, 'status'));
    check(same(await dependencies.provider.inspect(target), observed), 'PROCESS_MACHINE_CHANGED');
    plan.machines[key(target)] = observed;
  }
  const report = await dependencies.inspectDatabase();
  check(same(report.database, plan.database), 'MIGRATION_DATABASE_PROOF_CHANGED');
  // Active work is allowed during preparation, but never at the final stop.
  await control(plan, dependencies);
  return plan;
}

export async function executeFreeze(plan, dependencies) {
  const { provider, save } = dependencies;
  check(typeof save === 'function', 'DURABLE_PRIVATE_JOURNAL_REQUIRED');
  const state = { formatVersion: 1, planDigest: digest(plan), status: 'started', step: 'preflight',
    machines: structuredClone(plan.machines), secrets: structuredClone(plan.secrets), drains: {}, updatedAt: null };
  const persist = async (status, step) => {
    state.status = status; state.step = step; state.updatedAt = new Date(clock(dependencies)).toISOString();
    await save(state);
  };
  const unchanged = async () => {
    await inventory(plan, provider);
    for (const app of apps(plan)) assertSecretsUnchanged(state.secrets[app], await provider.secrets(app));
    for (const target of plan.targets) check(same(await provider.inspect(target), state.machines[key(target)]), 'PROCESS_MACHINE_CHANGED');
  };
  // Artifact/provider lookups finish before the last mutable control read.
  const guard = async () => { await barrier(plan, dependencies); await unchanged(); await control(plan, dependencies); };
  const mutate = async (step, operation) => {
    await persist('mutation-started', step);
    await guard();
    // A bounded provider call must not start by borrowing the recovery reserve.
    check(clock(dependencies) + 120000 < Date.parse(plan.deadline) - plan.recoveryReserveMs, 'FREEZE_TIME_BUDGET_EXHAUSTED');
    const result = await operation();
    await persist('mutation-observed', step);
    return result;
  };
  const drain = async (role, stage) => {
    const request = { cutoverId: plan.cutoverId, stopEpoch: plan.stopEpoch, stage };
    for (const target of plan.targets.filter(item => item.role === role)) {
      let receipt = await mutate(`drain-${role}-${stage}`, () => provider.process(target, 'drain', request));
      for (;;) {
        check(same(await provider.inspect(target), state.machines[key(target)]), 'PROCESS_MACHINE_CHANGED');
        await control(plan, dependencies);
        if (assertDrain(role, receipt, request)) break;
        await pause(dependencies);
        receipt = await provider.process(target, 'status');
      }
      state.drains[key(target)] = receipt;
      await persist('drained', `drain-${role}-${stage}`);
    }
  };
  const converge = async all => {
    for (;;) {
      const report = await dependencies.inspectDatabase();
      check(same(report.database, plan.database), 'MIGRATION_DATABASE_PROOF_CHANGED');
      await unchanged();
      await control(plan, dependencies);
      if (isConverged(report, all)) return report;
      await pause(dependencies);
    }
  };
  await persist('started', 'preflight');
  try {
    await guard();
    for (const target of plan.targets) assertDrain(target.role, await provider.process(target, 'status'));
    // Staging changes only the next boot. Updating a running Machine would
    // reboot it, so no config update occurs until live work has drained.
    for (const app of apps(plan)) {
      const target = plan.targets.find(item => item.app === app);
      await mutate('stage-frozen-boot', () => provider.stage(target, () => control(plan, dependencies)));
      const staged = await provider.secrets(app);
      assertSecretStage(state.secrets[app], staged);
      state.secrets[app] = staged;
      await unchanged();
      await persist('boot-stop-staged', 'stage-frozen-boot');
    }
    await drain('api', 'admission');
    await drain('summit', 'admission');
    await converge(false);
    await drain('worker', 'admission');
    await drain('api', 'all');
    await drain('worker', 'all');
    // Keep the receiver alive until the final sender has settled.
    await drain('summit', 'all');
    await converge(true);
    for (const target of plan.targets) {
      const updated = await mutate(`freeze-boot-${target.role}`, () => provider.freeze(target,
        state.machines[key(target)], () => control(plan, dependencies)));
      for (;;) {
        await control(plan, dependencies);
        try {
          const observed = await provider.inspect(target);
          check(observed.instance === updated.instance && same(observed.config, updated.config) && observed.image === updated.image,
            'FROZEN_MACHINE_CONFIGURATION_CHANGED');
          state.machines[key(target)] = observed;
          break;
        } catch (error) {
          if (!['RUNNING_MACHINE_EVIDENCE_REQUIRED', 'PROCESS_COMMAND_FAILED'].includes(error.code)) throw error;
          await pause(dependencies);
        }
      }
      // Readiness may lag the VM start. Never retry a changed identity or a
      // successful response with the wrong target/ledger/maintenance contract.
      for (;;) {
        await control(plan, dependencies);
        let receipt;
        try { receipt = await provider.process(target, 'readiness'); }
        catch (error) {
          if (error.code !== 'PROCESS_COMMAND_FAILED') throw error;
          await pause(dependencies); continue;
        }
        assertFrozenReadiness(target.role, receipt, plan.database);
        if (target.role === 'worker') assertDrain('worker', await provider.process(target, 'status'), null, 'frozen');
        check(same(await provider.inspect(target), state.machines[key(target)]), 'PROCESS_MACHINE_CHANGED');
        break;
      }
      await persist('frozen-boot-verified', `freeze-boot-${target.role}`);
    }
    const convergence = await converge(true);
    await guard();
    const previous = await control(plan, dependencies);
    const proof = { formatVersion: 1, cutoverId: plan.cutoverId, stopEpoch: plan.stopEpoch, candidates: plan.candidates,
      frozenAt: new Date(clock(dependencies)).toISOString(), planDigest: digest(plan),
      deploymentFreezeDigest: plan.deploymentFreezeDigest, externalEvidenceDigest: digest(plan.externalEvidence),
      database: plan.database, machines: state.machines, secrets: state.secrets, drains: state.drains, convergence };
    state.proof = proof;
    await persist('finalizing', 'record-frozen');
    const record = transition(previous.record, previous.record.stateVersion, 'advance', {
      cutoverId: plan.cutoverId, stopEpoch: plan.stopEpoch, phase: 'FROZEN', evidenceDigest: digest(proof),
    }, new Date(clock(dependencies)).toISOString());
    state.control = await dependencies.store.compareAndSwap(previous, record);
    await persist('frozen', 'complete');
    return proof;
  } catch (error) {
    const code = error instanceof ControlError ? error.code : 'FREEZE_EXECUTION_FAILED';
    state.failure = code;
    // Any partially observed operation requires investigation and fresh stop
    // evidence. Never undo a stop or silently retry a provider mutation.
    try {
      const previous = await dependencies.store.read();
      assertStop(previous.record, plan);
      await dependencies.store.compareAndSwap(previous, transition(previous.record, previous.record.stateVersion, 'invalidate', {
        cutoverId: plan.cutoverId, stopEpoch: plan.stopEpoch, reason: 'uncertain-stop',
      }, new Date(clock(dependencies)).toISOString()));
    } catch { state.controlInvalidationUnconfirmed = true; }
    await persist('failed-inspect-before-retry', state.step).catch(() => {});
    throw new ControlError(code);
  }
}

async function inspectFrozen(plan, proof, dependencies) {
  check(proof?.planDigest === digest(plan), 'FREEZE_PROOF_PLAN_CHANGED');
  const current = await control(plan, dependencies, 'FROZEN');
  check(current.record.cutover.evidence.writersStopped === digest(proof), 'WRITERS_STOPPED_EVIDENCE_CHANGED');
  const deployment = await dependencies.verifyDeployment(current.record, plan.approvals);
  check(digest(deployment) === plan.deploymentFreezeDigest, 'DEPLOYMENT_FREEZE_CHANGED');
  validateExternalEvidence(plan.externalEvidence, current.record, deployment, clock(dependencies));
  await inventory(plan, dependencies.provider);
  for (const app of apps(plan)) assertSecretsUnchanged(proof.secrets[app], await dependencies.provider.secrets(app));
  for (const target of plan.targets) {
    check(same(await dependencies.provider.inspect(target), proof.machines[key(target)]), 'FROZEN_MACHINE_CONFIGURATION_CHANGED');
    assertFrozenReadiness(target.role, await dependencies.provider.process(target, 'readiness'), plan.database);
    if (target.role === 'worker') assertDrain('worker', await dependencies.provider.process(target, 'status'), null, 'frozen');
    check(same(await dependencies.provider.inspect(target), proof.machines[key(target)]), 'PROCESS_MACHINE_CHANGED');
  }
  const convergence = await dependencies.inspectDatabase();
  check(same(convergence.database, plan.database) && isConverged(convergence, true), 'FROZEN_DATABASE_CHANGED');
  await control(plan, dependencies, 'FROZEN');
  return { writersStoppedDigest: digest(proof), database: convergence.database };
}

export async function verifyFrozen(plan, proof, dependencies) {
  try { return await inspectFrozen(plan, proof, dependencies); }
  catch (error) {
    // A failed continuity check cannot leave an apparently valid stop receipt
    // available to a later backup or application attempt.
    try {
      const current = await dependencies.store.read();
      assertStop(current.record, plan, 'FROZEN');
      await dependencies.store.compareAndSwap(current, transition(current.record, current.record.stateVersion, 'invalidate', {
        cutoverId: plan.cutoverId, stopEpoch: plan.stopEpoch, reason: 'uncertain-stop',
      }, new Date(clock(dependencies)).toISOString()));
    } catch { /* The caller still fails; an unavailable control store never authorizes work. */ }
    throw error instanceof ControlError ? error : new ControlError('FREEZE_VERIFICATION_FAILED');
  }
}
