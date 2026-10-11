// Subprocess integration tests for `orynr run` (non-interactive mode).
// These exercise the real CLI binary against a TestLLMServer running in the
// same process. See `test/lib/cli-process.ts` for the harness — each test uses
// `orynr.run(message, opts?)` to spawn `bun src/index.ts run ...` with
// `ORYNR_CONFIG_CONTENT` providing the test provider config inline.
import path from "node:path"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { reply } from "../../lib/llm-server"
import { cliIt, testModelID } from "../../lib/cli-process"
import { testProviderConfig } from "../../lib/test-provider"

describe("orynr run (non-interactive subprocess)", () => {
  // Happy path: prompt completes, output reaches stdout, process exits 0.
  // If this fails, all the others likely will too — debug here first.
  cliIt.concurrent(
    "exits 0 and writes the response to stdout on a successful prompt",
    ({ llm, orynr }) =>
      Effect.gen(function* () {
        yield* llm.text("hello from the test llm")
        const result = yield* orynr.run("say hi")
        orynr.expectExit(result, 0)
        expect(result.stdout).toBe("hello from the test llm\n")
      }),
    60_000,
  )

  cliIt.concurrent(
    "prints each completed text part in order around a tool continuation",
    ({ llm, orynr }) =>
      Effect.gen(function* () {
        yield* llm.push(
          reply().text("  before tool  ").tool("bash", {
            command: "printf tool-output",
            description: "Print deterministic output",
          }),
        )
        yield* llm.text("  after tool  ")

        const result = yield* orynr.run("use a tool", {
          extraArgs: ["--dangerously-skip-permissions"],
        })

        orynr.expectExit(result, 0)
        expect(result.stdout).toBe("before tool\nafter tool\n")
      }),
    60_000,
  )

  cliIt.concurrent(
    "prints reasoning before text only with --thinking",
    ({ llm, orynr }) =>
      Effect.gen(function* () {
        yield* llm.reason("  considering  ", { text: "  answer  " })
        const thinking = yield* orynr.run("think", { extraArgs: ["--thinking"] })
        orynr.expectExit(thinking, 0)
        expect(thinking.stdout).toBe("Thinking: considering\nanswer\n")

        yield* llm.reason("hidden", { text: "visible" })
        const plain = yield* orynr.run("think again")
        orynr.expectExit(plain, 0)
        expect(plain.stdout).toBe("visible\n")
      }),
    60_000,
  )

  // Regression for #27371: an unknown model used to hang the process forever
  // waiting on a session.status === idle event that never arrived. The fix
  // makes the SDK call surface an error promptly so the process exits nonzero.
  // We assert nonzero exit AND wall-clock under the harness timeout — a hang
  // would expire the timeout and produce a different (signal-killed) failure.
  cliIt.concurrent(
    "exits nonzero promptly when the model is unknown (regression for #27371)",
    ({ orynr }) =>
      Effect.gen(function* () {
        const result = yield* orynr.run("say hi", {
          model: "test/nonexistent-model",
          timeoutMs: 15_000,
        })
        expect(result.exitCode).not.toBe(0)
        expect(result.durationMs).toBeLessThan(15_000)
      }),
    30_000,
  )

  // The test provider's SSE error item is interpreted by the SDK as an unknown
  // finish, not a fatal provider/session error. Lock that distinction in so it
  // is not accidentally used as the failure compatibility oracle.
  cliIt.concurrent(
    "unknown stream finish preserves partial output and exits 0",
    ({ llm, orynr }) =>
      Effect.gen(function* () {
        yield* llm.push(
          reply().text("partial response").tool("bash", {
            command: "printf tool",
            description: "Print deterministic output",
          }),
        )
        yield* llm.fail("upstream provider exploded mid-stream")
        const result = yield* orynr.run("trigger midstream error", { timeoutMs: 30_000 })
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toBe("partial response\n")
        expect(result.stderr).not.toContain("upstream provider exploded mid-stream")
      }),
    60_000,
  )

  // --format json puts one JSON object per line on stdout for each emitted
  // event. Consumers (CI scripts, tooling) parse this stream. Asserts the
  // shape so a future event-emit change has to update this expectation.
  cliIt.concurrent(
    "--format json emits parseable line-delimited JSON to stdout",
    ({ llm, orynr }) =>
      Effect.gen(function* () {
        yield* llm.text("structured output")
        const result = yield* orynr.run("say hi", { format: "json" })
        orynr.expectExit(result, 0)

        const events = orynr.parseJsonEvents(result.stdout)
        expect(events.length).toBeGreaterThan(0)
        for (const evt of events) {
          expect(typeof evt.type).toBe("string")
          expect(typeof evt.sessionID).toBe("string")
        }
        expect(events.map((event) => event.type)).toEqual(["step_start", "text", "step_finish"])
        expect(events.map(({ timestamp: _, sessionID: __, ...event }) => event)).toEqual([
          { type: "step_start", part: expect.objectContaining({ type: "step-start" }) },
          {
            type: "text",
            part: expect.objectContaining({ type: "text", text: "structured output" }),
          },
          { type: "step_finish", part: expect.objectContaining({ type: "step-finish" }) },
        ])
        expect(result.stdout.endsWith("\n")).toBe(true)
        expect(
          result.stdout
            .split("\n")
            .slice(0, -1)
            .every((line) => line.length > 0),
        ).toBe(true)
      }),
    60_000,
  )

  cliIt.concurrent(
    "--format json emits a pure error record for a rejected prompt request",
    ({ orynr }) =>
      Effect.gen(function* () {
        const result = yield* orynr.run("use an unknown model", {
          model: "test/nonexistent-model",
          format: "json",
        })

        expect(result.exitCode).not.toBe(0)
        const events = orynr.parseJsonEvents(result.stdout)
        expect(events.map((event) => event.type)).toEqual(["error"])
        expect(events[0]).toEqual({
          type: "error",
          timestamp: expect.any(Number),
          sessionID: expect.any(String),
          error: expect.any(Object),
        })
        expect(result.stdout.split("\n").filter(Boolean)).toHaveLength(1)
      }),
    30_000,
  )

  cliIt.concurrent(
    "--format json preserves reasoning, tool, and continuation ordering",
    ({ llm, orynr }) =>
      Effect.gen(function* () {
        yield* llm.push(
          reply().reason("reasoning").text("before").tool("bash", {
            command: "printf tool",
            description: "Print deterministic output",
          }),
        )
        yield* llm.text("after")

        // The default agent is now `chat`, a delegation-only switchboard with
        // every tool except `task` denied. Select `build` explicitly (the tier
        // defaults to max, so it exists) to exercise a real tool execution.
        const result = yield* orynr.run("exercise json records", {
          agent: "build",
          format: "json",
          extraArgs: ["--thinking", "--dangerously-skip-permissions"],
        })

        expect(result.exitCode).toBe(0)
        const events = orynr.parseJsonEvents(result.stdout)
        expect(events.map((event) => event.type)).toEqual([
          "step_start",
          "reasoning",
          "text",
          "tool_use",
          "step_finish",
          "step_start",
          "text",
          "step_finish",
        ])
        expect(events.find((event) => event.type === "reasoning")?.part).toEqual(
          expect.objectContaining({ type: "reasoning", text: "reasoning" }),
        )
        expect(events.find((event) => event.type === "tool_use")?.part).toEqual(
          expect.objectContaining({
            type: "tool",
            tool: "bash",
            state: expect.objectContaining({ status: "completed" }),
          }),
        )
        expect(
          result.stdout
            .split("\n")
            .slice(0, -1)
            .every((line) => line.startsWith("{")),
        ).toBe(true)
      }),
    60_000,
  )

  cliIt.concurrent(
    "--format json records partial output for an unknown stream finish",
    ({ llm, orynr }) =>
      Effect.gen(function* () {
        yield* llm.push(
          reply().text("partial json").tool("bash", {
            command: "printf tool",
            description: "Print deterministic output",
          }),
        )
        yield* llm.fail("provider failed")
        // `build` instead of the default tool-less `chat` switchboard so the
        // bash call actually runs and the text/tool_use ordering is real.
        const result = yield* orynr.run("fail after output", { agent: "build", format: "json" })

        const events = orynr.parseJsonEvents(result.stdout)
        expect(result.exitCode).toBe(0)
        expect(events.map((event) => event.type)).toEqual([
          "step_start",
          "text",
          "tool_use",
          "step_finish",
          "step_start",
          "step_finish",
        ])
        expect(events[1]?.part).toEqual(expect.objectContaining({ type: "text", text: "partial json" }))
        expect(events.at(-1)?.part).toEqual(expect.objectContaining({ type: "step-finish", reason: "unknown" }))
      }),
    60_000,
  )

  cliIt.concurrent(
    "rejects requested permissions by default and allows them with the dangerous flag",
    ({ home, llm, orynr }) =>
      Effect.gen(function* () {
        // Permission flows need a tool-bearing agent: the default `chat`
        // switchboard denies every tool outright (no ask), so run as `build`.
        yield* llm.tool("bash", { command: "rm -f denied-file", description: "Remove a test file" })
        yield* llm.text("continued after rejection")
        const denied = yield* orynr.run("request permission", { agent: "build", permission: { bash: "ask" } })
        orynr.expectExit(denied, 0)
        expect(denied.stderr).toContain("permission requested: bash")
        expect(denied.stdout).toBe("")

        yield* llm.reset
        yield* llm.tool("bash", { command: "rm -f allowed-file", description: "Remove a test file" })
        yield* llm.text("continued after approval")
        const allowed = yield* orynr.run("request permission", {
          agent: "build",
          permission: { bash: "ask" },
          extraArgs: ["--dangerously-skip-permissions"],
        })
        orynr.expectExit(allowed, 0)
        expect(allowed.stderr).not.toContain("permission requested: bash")
        expect(allowed.stdout).toContain("continued after approval")

        yield* llm.reset
        yield* llm.tool("bash", { command: "touch explicitly-denied", description: "Create a denied marker" })
        yield* llm.text("continued after explicit denial")
        const explicitlyDenied = yield* orynr.run("request denied permission", {
          agent: "build",
          permission: { bash: "deny" },
          extraArgs: ["--dangerously-skip-permissions"],
        })
        orynr.expectExit(explicitlyDenied, 0)
        expect(explicitlyDenied.stdout).toContain("continued after explicit denial")
        expect(yield* Effect.promise(() => Bun.file(`${home}/explicitly-denied`).exists())).toBe(false)
      }),
    60_000,
  )

  cliIt.live(
    "attach mode sends client-local file contents without a shared path",
    ({ home, llm, orynr }) =>
      Effect.gen(function* () {
        const source = `${home}/client-only.txt`
        const sentinel = "client-only attachment sentinel"
        yield* Effect.promise(() => Bun.write(source, sentinel))
        yield* llm.text("attachment received")
        const server = yield* orynr.serve()

        const result = yield* orynr.run("read the attachment", {
          extraArgs: ["--attach", server.url, `--file=${source}`, "--"],
        })

        orynr.expectExit(result, 0)
        const input = JSON.stringify(yield* llm.inputs)
        expect(input).toContain(sentinel)
        expect(input).not.toContain(`file://${source}`)
      }),
    60_000,
  )

  cliIt.concurrent(
    "attach mode rejects local directories before prompt admission",
    ({ home, orynr }) =>
      Effect.gen(function* () {
        const result = yield* orynr.run("read the directory", {
          extraArgs: ["--attach", "http://127.0.0.1:1", `--file=${home}`, "--"],
        })

        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain("Cannot attach local directory without a shared filesystem")
      }),
    30_000,
  )

  // SIGINT must terminate an in-flight non-interactive run promptly instead of
  // leaking the CLI process.
  //
  // Spawned via `process.execPath` instead of the harness's `orynr.startRun`:
  // the harness spawns whatever `bun` resolves to on PATH, which on npm-shim
  // installs (e.g. Windows `bun.cmd`) inserts a wrapper process between the
  // test and the real CLI. `proc.kill("SIGINT")` then only kills the wrapper —
  // the actual run survives orphaned, keeps the stdout/stderr pipes open, and
  // the result never resolves. Spawning the test runner's own binary keeps the
  // run a single process on every platform so the signal reaches the CLI.
  cliIt.live(
    "SIGINT interrupts an active non-interactive run without leaking the process",
    ({ home, llm }) =>
      Effect.gen(function* () {
        yield* llm.hang
        const cliEntry = path.resolve(import.meta.dir, "../../../src/index.ts")
        const start = Date.now()
        const proc = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.spawn(
              [
                process.execPath,
                "run",
                "--conditions=browser",
                cliEntry,
                "run",
                "--model",
                testModelID,
                "wait forever",
              ],
              {
                cwd: home,
                // Mirrors the harness's isolated env (see test/lib/cli-process.ts
                // `isolatedEnv`) — kept inline because this test owns its spawn.
                env: {
                  ...process.env,
                  ORYNR_TEST_HOME: home,
                  HOME: home,
                  XDG_CONFIG_HOME: path.join(home, ".config"),
                  XDG_DATA_HOME: path.join(home, ".local/share"),
                  XDG_STATE_HOME: path.join(home, ".local/state"),
                  XDG_CACHE_HOME: path.join(home, ".cache"),
                  ORYNR_CONFIG_CONTENT: JSON.stringify(testProviderConfig(llm.url)),
                  ORYNR_DISABLE_PROJECT_CONFIG: "1",
                  ORYNR_PURE: "1",
                  ORYNR_DISABLE_AUTOUPDATE: "1",
                  ORYNR_DISABLE_AUTOCOMPACT: "1",
                  ORYNR_DISABLE_MODELS_FETCH: "1",
                  ORYNR_AUTH_CONTENT: "{}",
                },
                stdin: "ignore",
                stdout: "pipe",
                stderr: "pipe",
              },
            ),
          ),
          (child) =>
            Effect.promise(() => {
              child.kill()
              return child.exited
            }).pipe(Effect.ignore),
        )
        // Pipe closure is the leak oracle: any surviving process would hold
        // the write ends open and stall these reads past the test timeout.
        const stdout = new Response(proc.stdout).text()
        const stderr = new Response(proc.stderr).text()

        yield* llm.wait(1)
        proc.kill("SIGINT")
        const exitCode = yield* Effect.promise(() => proc.exited)
        yield* Effect.promise(() => Promise.all([stdout, stderr]))

        expect(exitCode).not.toBe(0)
        expect(Date.now() - start).toBeLessThan(30_000)
      }),
    30_000,
  )
})
