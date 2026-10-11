import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { Config } from "@/config/config"

// `orynr sandbox` — show or set the execution sandbox runtime.
// Persists to the GLOBAL config (patched, so other settings like your model are preserved).
// The bash tool reads config per-command, so a change takes effect on the next command (no restart).
export const SandboxCommand = effectCmd({
  command: "sandbox [runtime]",
  describe: "show or set the execution sandbox runtime (local or docker)",
  builder: (yargs) =>
    yargs.positional("runtime", {
      type: "string",
      choices: ["local", "docker"] as const,
      describe: "runtime to switch to; omit to show the current runtime",
    }),
  handler: Effect.fn("Cli.sandbox")(function* (args) {
    const config = yield* Config.Service
    if (!args.runtime) {
      const cfg = yield* config.get()
      const current = cfg.sandbox?.runtime ?? "local"
      console.log(`sandbox runtime: ${current}${current === "local" ? " (default)" : ""}`)
      console.log("switch with: orynr sandbox local   |   orynr sandbox docker")
      return
    }
    const result = yield* config.updateGlobal({ sandbox: { runtime: args.runtime } })
    console.log(
      result.changed
        ? `sandbox runtime set to: ${args.runtime} (takes effect on the next command)`
        : `sandbox runtime already: ${args.runtime}`,
    )
  }),
})
