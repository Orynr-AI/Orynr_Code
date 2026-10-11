export * as SessionStatusEvent from "./session-status-event"

import { Schema } from "effect"
import { optional } from "./schema"
import { Event } from "./event"
import { NonNegativeInt } from "./schema"
import { SessionID } from "./session-id"

export const Outcome = Schema.Literals(["finished", "cancelled", "error", "stuck"])
export type Outcome = Schema.Schema.Type<typeof Outcome>

export const Info = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("idle"),
    // Why the run ended (additive; absent ⇒ a plain/finished idle for old consumers).
    outcome: optional(Outcome),
    // For outcome:"error", a machine-readable cause: "max_steps" | "budget_exceeded" | "cancelled" | ...
    errorType: optional(Schema.String),
  }),
  Schema.Struct({
    // Busy, but blocked on a human decision (a permission prompt).
    type: Schema.Literal("waiting"),
    reason: optional(Schema.String),
  }),
  Schema.Struct({
    // Cooperatively paused (loop-level break-and-resumable).
    type: Schema.Literal("paused"),
    reason: optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("retry"),
    attempt: NonNegativeInt,
    message: Schema.String,
    action: optional(
      Schema.Struct({
        reason: Schema.String,
        provider: Schema.String,
        title: Schema.String,
        message: Schema.String,
        label: Schema.String,
        link: optional(Schema.String),
      }),
    ),
    next: NonNegativeInt,
  }),
  Schema.Struct({
    type: Schema.Literal("busy"),
  }),
]).annotate({ identifier: "SessionStatus" })
export type Info = Schema.Schema.Type<typeof Info>

export const Status = Event.define({
  type: "session.status",
  schema: {
    sessionID: SessionID,
    status: Info,
  },
})

// deprecated
export const Idle = Event.define({
  type: "session.idle",
  schema: {
    sessionID: SessionID,
  },
})

export const Definitions = Event.inventory(Status, Idle)
