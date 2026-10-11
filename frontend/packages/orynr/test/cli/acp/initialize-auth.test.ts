import { describe, expect } from "bun:test"
import type { AuthenticateResponse, InitializeResponse } from "@agentclientprotocol/sdk"
import { Effect } from "effect"
import { cliIt, type CliFixture } from "../../lib/cli-process"
import { createAcpClient as createJsonRpcAcpClient } from "./acp-test-client"
import { expectErrorCode, initialize } from "./helpers"

// Spawn `orynr acp` with --port 0 so the OS assigns a free port for its
// internal server. The CLI default (4096) collides with any already-running
// orynr instance and across parallel test files, killing the subprocess at
// boot (ServeError) before it can answer a single JSON-RPC request.
function createAcpClient(orynr: CliFixture["orynr"]) {
  return Effect.gen(function* () {
    return createJsonRpcAcpClient(yield* orynr.acp({ extraArgs: ["--port", "0"] }))
  })
}

describe("orynr acp initialize/auth subprocess", () => {
  cliIt.live(
    "initialize responds with capabilities",
    ({ orynr }) =>
      Effect.gen(function* () {
        const initialized = yield* initialize(yield* createAcpClient(orynr))

        expect(initialized.protocolVersion).toBe(1)
        expect(initialized.agentCapabilities?.promptCapabilities?.embeddedContext).toBe(true)
        expect(initialized.agentCapabilities?.promptCapabilities?.image).toBe(true)
        expect(initialized.agentCapabilities?.mcpCapabilities?.http).toBe(true)
        expect(initialized.agentCapabilities?.mcpCapabilities?.sse).toBe(true)
        expect(initialized.agentCapabilities?.loadSession).toBe(true)
        expect(initialized.agentCapabilities?.sessionCapabilities?.close).toEqual({})
        expect(initialized.agentCapabilities?.sessionCapabilities?.fork).toEqual({})
        expect(initialized.agentCapabilities?.sessionCapabilities?.list).toEqual({})
        expect(initialized.agentCapabilities?.sessionCapabilities?.resume).toEqual({})
        expect(initialized.agentInfo?.name).toBe("Orynrcode")
      }),
    60_000,
  )

  cliIt.live(
    "auth negotiation is explicit and safe",
    ({ orynr }) =>
      Effect.gen(function* () {
        const acp = yield* createAcpClient(orynr)
        const initialized = yield* initialize(acp)

        expect(initialized.authMethods?.[0]?.id).toBe("orynr-login")
        expect(initialized.authMethods?.[0]?._meta?.["terminal-auth"]).toBeDefined()
        expect(yield* acp.request<AuthenticateResponse>("authenticate", { methodId: "orynr-login" })).toMatchObject({
          result: {},
        })

        const rejected = yield* acp.request<AuthenticateResponse>("authenticate", { methodId: "missing-auth-method" })
        expectErrorCode(rejected.error, -32602)
        expect(JSON.stringify(rejected.error)).not.toContain(process.env.ORYNR_AUTH_CONTENT ?? "not-present")
      }),
    60_000,
  )

  cliIt.live(
    "initialize without terminal-auth metadata keeps auth command implicit",
    ({ orynr }) =>
      Effect.gen(function* () {
        const acp = yield* createAcpClient(orynr)
        const initialized = yield* acp.request<InitializeResponse>("initialize", { protocolVersion: 1 })

        expect(initialized.result?.authMethods?.[0]?.id).toBe("orynr-login")
        expect(initialized.result?.authMethods?.[0]?._meta?.["terminal-auth"]).toBeUndefined()
      }),
    60_000,
  )
})
