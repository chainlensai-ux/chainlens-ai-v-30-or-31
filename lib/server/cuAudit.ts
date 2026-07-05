// lib/server/cuAudit.ts — shared, additive CU-risk diagnostic helper.
//
// Purpose: a single, cheap console.debug wrapper for the HIGH-RISK external-provider call sites
// flagged in docs/CU_AUDIT.md, so those log lines are consistent and greppable
// (`grep "\[CU-AUDIT\]"` in any log viewer) rather than each site inventing its own format. This
// file adds no behavior of its own — it never throws, never blocks, never changes what a caller
// does; it only logs.

export function logCuRisk(provider: string, context: string): void {
  // eslint-disable-next-line no-console
  console.debug('[CU-AUDIT]', provider, context)
}
