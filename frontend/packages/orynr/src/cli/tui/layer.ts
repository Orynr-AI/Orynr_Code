import { run as runTui, type TuiInput } from "@orynr-ai/tui"
import { Global } from "@orynr-ai/core/global"
import { AppNodeBuilder } from "@orynr-ai/core/effect/app-node-builder"
import { Effect } from "effect"

export function run(input: TuiInput) {
  return runTui(input).pipe(Effect.provide(AppNodeBuilder.build(Global.node)))
}
