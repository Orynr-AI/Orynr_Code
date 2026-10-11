// Per-run USD budget for a whole task (delegation) tree. Module-level so a root run and its delegated
// child runs share ONE pool — a child charges its cost to the nearest ancestor budget, so a delegation
// tree can never exceed the root's allowance. Mirrors OpenHands' max_budget_per_task (checked between
// steps, the same cadence as its per-iteration check).

interface Budget {
  limit: number
  original: number
  spent: number
  action: "ask" | "allow" | "deny"
}

const budgets = new Map<string, Budget>()

// Register a budget for a run (no-op if there is no positive limit, or the run already has one).
export function begin(sessionID: string, cost: number | undefined, action: "ask" | "allow" | "deny" | undefined) {
  if (cost === undefined || cost <= 0) return
  if (budgets.has(sessionID)) return
  budgets.set(sessionID, { limit: cost, original: cost, spent: 0, action: action ?? "ask" })
}

// Stop tracking a run's budget (called when the root run ends).
export function end(sessionID: string) {
  budgets.delete(sessionID)
}

// The budget entry registered directly on `sessionID`, if any (used to find the governing root).
export function status(key: string | undefined): Budget | undefined {
  if (!key) return undefined
  return budgets.get(key)
}

// Add `cost` USD to the governing budget at `key` (the resolved root of the tree).
export function charge(key: string | undefined, cost: number) {
  if (!key || cost <= 0) return
  const b = budgets.get(key)
  if (b) b.spent += cost
}

// True when the tree at `key` has spent at or beyond its limit.
export function exceeded(key: string | undefined): boolean {
  const b = status(key)
  return b !== undefined && b.spent >= b.limit
}

// After the user approves an over-budget pause, extend the allowance by one more original budget so the
// run continues without immediately re-prompting on the very next step.
export function grant(key: string | undefined) {
  if (!key) return
  const b = budgets.get(key)
  if (b) b.limit += b.original
}

export * as SessionBudget from "./budget"
