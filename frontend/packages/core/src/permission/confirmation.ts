// The 3-way confirmation truth table. Given the policy mode + the action's risk level, decide whether
// to UPGRADE an already-allowed tool call to "ask" (pause for the human). Applied dynamically inside
// the live Permission.ask AFTER a rule already resolved to "allow" (a "deny" returns earlier), so this
// can only ever ADD friction — it can never soften a deny. Pure and deterministic.

import { RANK, type Level } from "./risk"

export type Mode = "never" | "risky" | "always"

// The resolved policy carried into Permission.ask (agent override, else global; absent ⇒ "never").
export interface Input {
  readonly mode: Mode
  readonly threshold?: Level
}

// Tools that CHANGE state (the "doing" set). `task` is intentionally excluded — delegation is governed
// by the tier / containment rules, not by the confirmation policy.
const MUTATING = new Set(["edit", "write", "patch", "apply_patch", "bash"])

export interface Decision {
  readonly tool: string
  readonly mode: Mode
  readonly level: Level
  readonly threshold?: Level
}

// True ⇒ upgrade this allowed action to "ask".
export function shouldConfirm(input: Decision): boolean {
  const { mode, tool, level } = input
  if (mode === "never") return false
  // "risky": pause when the risk meets the threshold, or is unknown (fail-closed toward asking).
  const risky = level === "unknown" || RANK[level] >= RANK[input.threshold ?? "medium"]
  if (mode === "risky") return risky
  // "always": every mutating action, plus anything the "risky" policy would already catch.
  return MUTATING.has(tool) || risky
}

export * as Confirmation from "./confirmation"
