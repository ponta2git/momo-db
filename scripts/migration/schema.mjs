// pg_restore maps owners and omits ACLs locally. Keep the complete original
// inventory encrypted, and compare this structural projection separately.
// This never certifies application-role/SECURITY DEFINER behavior.
export function schemaStructure(schema) {
  const visit = value => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value)
      .filter(([name]) => !['owner', 'privileges', 'position', 'comparisonDefinition', 'comparisonChecks'].includes(name))
      .map(([name, child]) => [name, visit(name === 'definition' && Object.hasOwn(value, 'comparisonDefinition') ? value.comparisonDefinition :
        name === 'checks' && Object.hasOwn(value, 'comparisonChecks') ? value.comparisonChecks : child)]));
  };
  return visit(schema);
}
