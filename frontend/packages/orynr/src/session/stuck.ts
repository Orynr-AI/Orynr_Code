// Stuck / loop detector — the smart, EARLY stop that fires before the hard step cap when the agent is
// spinning its wheels: repeating the same action, repeating the same error, monologuing with no tool
// calls, or oscillating between two actions. Ported from OpenHands' StuckDetector (four windowed
// scenarios). Pure analysis over the recent action/observation stream, so it works across turns (and,
// later, across Ralph's synthetic re-prompts — which don't reset the window).

export interface Thresholds {
  readonly enabled: boolean
  readonly action_observation: number // repeated identical action+result (default 4)
  readonly action_error: number // repeated identical failing action (default 3)
  readonly monologue: number // consecutive text-only turns, no tool call (default 3)
  readonly alternating: number // A-B-A-B oscillation length (default 6)
  readonly scan_window: number // how many recent steps to consider (default 20)
}

export const DEFAULTS: Thresholds = {
  enabled: true,
  action_observation: 4,
  action_error: 3,
  monologue: 3,
  alternating: 6,
  scan_window: 20,
}

// One normalized step in the recent stream. `action` is a "tool:inputJSON" signature, or null for a
// text-only (monologue) turn. `observation` is a signature of the result, or null.
export interface Step {
  readonly action: string | null
  readonly observation: string | null
  readonly isError: boolean
}

export type Reason = "repeat_action" | "repeat_error" | "monologue" | "alternating"

// Merge partial config over the defaults.
export function thresholds(cfg?: Partial<Thresholds>): Thresholds {
  return { ...DEFAULTS, ...(cfg ?? {}) }
}

// Return the stuck reason if the recent stream trips a scenario, else null. Deterministic.
export function analyze(steps: readonly Step[], t: Thresholds): Reason | null {
  if (!t.enabled) return null
  const window = steps.slice(-t.scan_window)

  // 3. Monologue: the last N turns are all text-only (the model talks but never acts).
  const tailMono = window.slice(-t.monologue)
  if (tailMono.length >= t.monologue && tailMono.every((s) => s.action === null)) return "monologue"

  const acted = window.filter((s) => s.action !== null)

  // 2. Repeating action-error: last N acted turns all failed with the SAME action+error (lower
  //    threshold than repeat_action, so a failing loop is caught sooner). Checked before scenario 1.
  const tailErr = acted.slice(-t.action_error)
  if (
    tailErr.length >= t.action_error &&
    tailErr.every((s) => s.isError && s.action === tailErr[0].action && s.observation === tailErr[0].observation)
  )
    return "repeat_error"

  // 1. Repeating action+observation: last N acted turns identical (same action AND same result).
  const tailAO = acted.slice(-t.action_observation)
  if (
    tailAO.length >= t.action_observation &&
    tailAO.every((s) => s.action === tailAO[0].action && s.observation === tailAO[0].observation)
  )
    return "repeat_action"

  // 4. Alternating: the last N acted turns oscillate between exactly two distinct actions (A B A B …).
  const tailAlt = acted.slice(-t.alternating)
  if (tailAlt.length >= t.alternating) {
    const a = tailAlt[0].action
    const b = tailAlt[1].action
    if (a !== b && tailAlt.every((s, i) => s.action === (i % 2 === 0 ? a : b))) return "alternating"
  }

  return null
}

export const MESSAGE: Record<Reason, string> = {
  repeat_action: "the same action is being repeated with the same result",
  repeat_error: "the same action keeps failing the same way",
  monologue: "several turns have passed with no tool call",
  alternating: "the agent is oscillating between two actions",
}

export * as SessionStuck from "./stuck"
