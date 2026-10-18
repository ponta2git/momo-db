import { ControlError, digest, validateControl, validateReceipt } from './control.mjs';
import { githubApi, controlBranch, controlRepository } from './github-store.mjs';

const check = (condition, code) => { if (!condition) throw new ControlError(code); };
const same = (left, right) => digest(left) === digest(right);
export const deploymentEnvironments = [
  { repository: 'ponta2git/momo-db', name: 'production-db', approval: true },
  { repository: 'ponta2git/momo-db', name: 'CI Actions', approval: false },
  { repository: 'ponta2git/momo-result', name: 'production', approval: true },
];

export function approvalPolicy(environment) {
  const rules = environment.protection_rules;
  check(Array.isArray(rules), 'ENVIRONMENT_PROTECTION_UNAVAILABLE');
  return rules.filter(rule => rule.type === 'required_reviewers' || rule.type === 'wait_timer').map(rule =>
    rule.type === 'required_reviewers' ? {
      type: rule.type, preventSelfReview: rule.prevent_self_review,
      reviewers: rule.reviewers.map(item => ({ type: item.type, id: item.reviewer.id }))
        .sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`)),
    } : { type: rule.type, minutes: rule.wait_timer }).sort((a, b) => a.type.localeCompare(b.type));
}

export function verifyEnvironment(environment, policies, expected, cutoverId, previousApproval) {
  check(environment.name === expected.name && environment.can_admins_bypass === false, 'ENVIRONMENT_ADMIN_BYPASS_NOT_DISABLED');
  check(environment.deployment_branch_policy?.custom_branch_policies === true &&
    environment.deployment_branch_policy.protected_branches === false, 'EXACT_DEPLOYMENT_BRANCH_POLICY_REQUIRED');
  check(policies.total_count === 1 && policies.branch_policies?.length === 1 &&
    policies.branch_policies[0].type === 'branch' && policies.branch_policies[0].name === `cutover/${cutoverId}`, 'OLD_DEPLOYMENT_REFS_NOT_REJECTED');
  const approvals = approvalPolicy(environment);
  check(!expected.approval || approvals.some(rule => rule.type === 'required_reviewers' && rule.reviewers.length > 0), 'EXISTING_APPROVAL_REQUIRED');
  check(same(approvals, previousApproval), 'EXISTING_APPROVAL_POLICY_CHANGED');
  return { repository: expected.repository, environment: expected.name, branch: `cutover/${cutoverId}`, approvalDigest: digest(approvals) };
}

// Run by the authorized operator, not by a workflow token with broadened
// administration permissions. No configuration is changed by this verifier.
export async function verifyDeploymentFreeze(record, previousApprovals, request = githubApi) {
  validateControl(record);
  check(record.cutover && record.cutover.candidates, 'PINNED_CUTOVER_REQUIRED');
  check(Array.isArray(previousApprovals) && previousApprovals.length === deploymentEnvironments.length, 'PREVIOUS_APPROVAL_SNAPSHOT_REQUIRED');
  const environments = [];
  for (const expected of deploymentEnvironments) {
    const path = `repos/${expected.repository}/environments/${encodeURIComponent(expected.name)}`;
    const [environment, policies] = await Promise.all([request(path), request(`${path}/deployment-branch-policies?per_page=100`)]);
    const previous = previousApprovals.find(item => item.repository === expected.repository && item.environment === expected.name);
    check(previous && Array.isArray(previous.approvals), 'PREVIOUS_APPROVAL_SNAPSHOT_REQUIRED');
    environments.push(verifyEnvironment(environment, policies, expected, record.cutover.id, previous.approvals));
  }
  const protection = await request(`repos/${controlRepository}/branches/${controlBranch}/protection`);
  check(protection.enforce_admins?.enabled === true && protection.allow_force_pushes?.enabled === false &&
    protection.allow_deletions?.enabled === false, 'CONTROL_REF_PROTECTION_REQUIRED');
  // Personal repositories cannot use organization push restrictions. Verify
  // the actual write principals instead; unknown or extra writers stop this gate.
  const collaborators = await request(`repos/${controlRepository}/collaborators?per_page=100&affiliation=all`);
  check(Array.isArray(collaborators) && collaborators.length < 100, 'CONTROL_WRITER_INVENTORY_INCOMPLETE');
  const writers = collaborators.filter(item => item.permissions?.push || item.permissions?.maintain || item.permissions?.admin);
  check(writers.length === 1 && writers[0].login === record.operator, 'SINGLE_CONTROL_WRITER_REQUIRED');
  return { formatVersion: 1, cutoverId: record.cutover.id, stopEpoch: record.cutover.stopEpoch,
    candidates: record.cutover.candidates, environments, controlProtection: true,
    // Existing approved/running jobs and credentials held outside GitHub still
    // need the separate drain/writer inventory proof before FROZEN.
    incomplete: ['already-authorized-jobs', 'external-writers', 'old-workflow-rejection-exercise'] };
}

export async function captureApprovalPolicies(request = githubApi) {
  const results = [];
  for (const expected of deploymentEnvironments) {
    const environment = await request(`repos/${expected.repository}/environments/${encodeURIComponent(expected.name)}`);
    const approvals = approvalPolicy(environment);
    check(!expected.approval || approvals.some(rule => rule.type === 'required_reviewers' && rule.reviewers.length), 'EXISTING_APPROVAL_REQUIRED');
    results.push({ repository: expected.repository, environment: expected.name, approvals });
  }
  return results;
}

export async function verifyProducer(receipt, request = githubApi) {
  validateReceipt(receipt);
  const repository = receipt.execution.repository;
  const expectedSha = receipt.operation === 'database' ? receipt.candidates.db : receipt.candidates.result;
  const expectedWorkflow = receipt.operation === 'database' ? '.github/workflows/ci.yml' : '.github/workflows/deploy.yml';
  const producer = receipt.producer;
  const run = await request(`repos/${repository}/actions/runs/${producer.runId}/attempts/${producer.runAttempt}`);
  check(String(run.id) === producer.runId && run.run_attempt === producer.runAttempt && run.head_sha === expectedSha &&
    run.head_branch === 'master' && run.event === 'push' && run.path === expectedWorkflow &&
    run.status === 'completed' && run.conclusion === 'success', 'SUCCESSFUL_FIXED_PRODUCER_REQUIRED');
  const suffix = `-${producer.runId}-${producer.runAttempt}`;
  const allowedNames = receipt.operation === 'database' ? [`db-candidate${suffix}`] :
    ['runtime-image', 'analysis-worker-image', 'analysis-candidate-metadata'].map(name => `${name}${suffix}`);
  const artifacts = [];
  for (const expected of producer.artifacts) {
    const artifact = await request(`repos/${repository}/actions/artifacts/${expected.id}`);
    check(String(artifact.id) === expected.id && artifact.expired === false && artifact.digest === `sha256:${expected.digest}` &&
      String(artifact.workflow_run?.id) === producer.runId && artifact.workflow_run.head_sha === expectedSha &&
      artifact.workflow_run.head_branch === 'master' && allowedNames.includes(artifact.name), 'PRODUCER_ARTIFACT_CHANGED_OR_EXPIRED');
    artifacts.push({ id: expected.id, name: artifact.name, digest: expected.digest });
  }
  const requiredNames = receipt.operation === 'database' ? allowedNames :
    [`runtime-image${suffix}`, `analysis-candidate-metadata${suffix}`];
  check(requiredNames.every(name => artifacts.some(item => item.name === name)), 'PRODUCER_ARTIFACT_SET_INCOMPLETE');
  return { runId: producer.runId, runAttempt: producer.runAttempt, sha: expectedSha, artifacts };
}
