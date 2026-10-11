import { LayerNode } from "@orynr-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { SessionID } from "./schema"
import { Effect, Layer, Context } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionStatusEvent } from "@orynr-ai/schema/session-status-event"

export const Info = SessionStatusEvent.Info
export type Info = SessionStatusEvent.Info

export const Event = SessionStatusEvent

export interface Interface {
  readonly get: (sessionID: SessionID) => Effect.Effect<Info>
  readonly list: () => Effect.Effect<Map<SessionID, Info>>
  readonly set: (sessionID: SessionID, status: Info) => Effect.Effect<void>
  // Single writer for a run's terminal state: emits idle tagged with WHY it ended.
  readonly finish: (
    sessionID: SessionID,
    outcome: SessionStatusEvent.Outcome,
    errorType?: string,
  ) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@orynr/SessionStatus") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service

    const state = yield* InstanceState.make(
      Effect.fn("SessionStatus.state")(() => Effect.succeed(new Map<SessionID, Info>())),
    )

    const get = Effect.fn("SessionStatus.get")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      return data.get(sessionID) ?? { type: "idle" as const }
    })

    const list = Effect.fn("SessionStatus.list")(function* () {
      return new Map(yield* InstanceState.get(state))
    })

    const set = Effect.fn("SessionStatus.set")(function* (sessionID: SessionID, status: Info) {
      const data = yield* InstanceState.get(state)
      yield* events.publish(Event.Status, { sessionID, status })
      if (status.type === "idle") {
        yield* events.publish(Event.Idle, { sessionID })
        data.delete(sessionID)
        return
      }
      data.set(sessionID, status)
    })

    const finish = Effect.fn("SessionStatus.finish")(function* (
      sessionID: SessionID,
      outcome: SessionStatusEvent.Outcome,
      errorType?: string,
    ) {
      yield* set(sessionID, { type: "idle", outcome, ...(errorType ? { errorType } : {}) })
    })

    return Service.of({ get, list, set, finish })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2Bridge.node] })

export * as SessionStatus from "./status"
