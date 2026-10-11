import { describe, expect } from "bun:test"
import type {
  CloseSessionResponse,
  ListSessionsResponse,
  LoadSessionResponse,
  ResumeSessionResponse,
} from "@agentclientprotocol/sdk"
import { Duration, Effect } from "effect"
import { cliIt, type CliFixture } from "../../lib/cli-process"
import { createAcpClient as createJsonRpcAcpClient, expectOk, selectConfigOption } from "./acp-test-client"
import { initialize, newSession, verifierConfig } from "./helpers"

// The ACP subprocess boots an HTTP server that defaults to port 4096 with no
// fallback — a stale or parallel orynr process holding that port kills the
// child at startup (ServeError) and every request times out. Pass --port 0 so
// Server.listen falls back to any free port; the port itself is irrelevant
// here since these tests speak JSON-RPC over stdio.
const acpArgs = ["--port", "0"]

function createAcpClient(input: Pick<CliFixture, "orynr">, env?: Record<string, string>) {
  return Effect.gen(function* () {
    return createJsonRpcAcpClient(yield* input.orynr.acp({ ...(env ? { env } : {}), extraArgs: acpArgs }))
  })
}

describe("orynr acp lifecycle subprocess", () => {
  cliIt.live(
    "stdin EOF exits cleanly",
    ({ orynr }) =>
      Effect.gen(function* () {
        const acp = yield* orynr.acp({ extraArgs: acpArgs })
        acp.close()

        const code = yield* Effect.promise(() => acp.exited).pipe(Effect.timeout(Duration.seconds(5)))
        expect(code).toBe(0)
      }),
    60_000,
  )

  cliIt.live(
    "close capability and close request",
    ({ home, llm, orynr }) =>
      Effect.gen(function* () {
        const acp = yield* createAcpClient(
          { orynr },
          { ORYNR_CONFIG_CONTENT: JSON.stringify(verifierConfig(llm.url)) },
        )
        const initialized = yield* initialize(acp)
        expect(initialized.agentCapabilities?.sessionCapabilities?.close).toEqual({})

        const session = yield* newSession(acp, home)
        expectOk(yield* acp.request<CloseSessionResponse>("session/close", { sessionId: session.sessionId }))
      }),
    60_000,
  )

  cliIt.live(
    "loadSession capability and load request return session config options",
    ({ home, llm, orynr }) =>
      Effect.gen(function* () {
        const acp = yield* createAcpClient(
          { orynr },
          { ORYNR_CONFIG_CONTENT: JSON.stringify(verifierConfig(llm.url)) },
        )
        const initialized = yield* initialize(acp)
        expect(initialized.agentCapabilities?.loadSession).toBe(true)
        const session = yield* newSession(acp, home)
        const loaded = expectOk(
          yield* acp.request<LoadSessionResponse>("session/load", {
            cwd: home,
            sessionId: session.sessionId,
            mcpServers: [],
          }),
        )

        expect(selectConfigOption(loaded.configOptions, "model")?.category).toBe("model")
      }),
    60_000,
  )

  cliIt.live(
    "list request includes a live ACP-created session",
    ({ home, llm, orynr }) =>
      Effect.gen(function* () {
        const acp = yield* createAcpClient(
          { orynr },
          { ORYNR_CONFIG_CONTENT: JSON.stringify(verifierConfig(llm.url)) },
        )
        yield* initialize(acp)
        const session = yield* newSession(acp, home)
        const listed = expectOk(yield* acp.request<ListSessionsResponse>("session/list", { cwd: home }))

        expect(listed.sessions.some((item) => item.sessionId === session.sessionId)).toBe(true)
      }),
    60_000,
  )

  cliIt.live(
    "resume capability advertisement",
    ({ orynr }) =>
      Effect.gen(function* () {
        const initialized = yield* initialize(yield* createAcpClient({ orynr }))

        expect(initialized.agentCapabilities?.sessionCapabilities?.resume).toEqual({})
      }),
    60_000,
  )

  cliIt.live(
    "resume request returns session config options",
    ({ home, llm, orynr }) =>
      Effect.gen(function* () {
        const acp = yield* createAcpClient(
          { orynr },
          { ORYNR_CONFIG_CONTENT: JSON.stringify(verifierConfig(llm.url)) },
        )
        yield* initialize(acp)
        const session = yield* newSession(acp, home)
        const resumed = expectOk(
          yield* acp.request<ResumeSessionResponse>("session/resume", {
            cwd: home,
            sessionId: session.sessionId,
            mcpServers: [],
          }),
        )

        expect(selectConfigOption(resumed.configOptions, "model")?.category).toBe("model")
      }),
    60_000,
  )
})
