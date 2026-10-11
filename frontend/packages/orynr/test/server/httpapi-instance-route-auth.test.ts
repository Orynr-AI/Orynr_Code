import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { ConfigProvider, Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { LayerNode } from "@orynr-ai/core/effect/layer-node"
import { Ripgrep } from "@orynr-ai/core/ripgrep"
import { EventPaths } from "../../src/server/routes/instance/httpapi/groups/event"
import { PtyPaths } from "../../src/server/routes/instance/httpapi/groups/pty"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { ServerAuth } from "../../src/server/auth"
import { PtyID } from "@orynr-ai/core/pty/schema"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

function app(input: { password?: string; username?: string }) {
  const handler = HttpRouter.toWebHandler(
    HttpApiApp.routes.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            ORYNR_SERVER_PASSWORD: input.password,
            ORYNR_SERVER_USERNAME: input.username,
          }),
        ),
      ),
    ),
    { disableLogger: true },
  ).handler

  return {
    fetch: (request: Request) => handler(request, HttpApiApp.context),
    request(input: string | URL | Request, init?: RequestInit) {
      return this.fetch(input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init))
    },
  }
}

function basic(username: string, password: string) {
  return ServerAuth.header({ username, password }) ?? ""
}

async function cancelBody(response: Response) {
  await response.body?.cancel().catch(() => {})
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const { live: liveEffect } = testEffect(LayerNode.compile(Ripgrep.node))

// The instance boots triggered by the auth tests below lazily provision the
// ripgrep binary into the global cache dir (which() -> cached download +
// extract). That provisioning runs outside instance scope, so on machines
// without ripgrep on PATH it can still be in flight when the preload teardown
// removes the test data dir — on Windows fs.rm then fails with EACCES because
// the extractor/binary is still live. Run it to completion first (declaration
// order guarantees this test executes before the instance-booting ones), so
// later boots hit the already-provisioned binary and spawn only short-lived
// rg processes that instance disposal reaps.
liveEffect(
  "provisions the ripgrep binary backing instance search routes",
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    )
    yield* Effect.promise(() => Bun.write(path.join(tmp.path, "probe.txt"), "probe"))
    const ripgrep = yield* Ripgrep.Service
    const entries = yield* ripgrep.find({ cwd: tmp.path, pattern: "*", limit: 10 })
    expect(entries.map((entry) => String(entry.path))).toContain("probe.txt")
  }),
  120_000,
)

describe("HttpApi instance route authorization", () => {
  test("requires configured auth before opening the instance event stream", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const server = app({ password: "secret" })
    const headers = { "x-orynr-directory": tmp.path }

    const missing = await server.request(EventPaths.event, { headers })
    await cancelBody(missing)
    expect(missing.status).toBe(401)

    const authed = await server.request(EventPaths.event, {
      headers: { ...headers, authorization: basic("orynr", "secret") },
    })
    await cancelBody(authed)
    expect(authed.status).toBe(200)
  })

  test("requires configured auth before resolving the PTY websocket route", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const server = app({ password: "secret" })
    const route = PtyPaths.connect.replace(":ptyID", PtyID.ascending())
    const headers = { "x-orynr-directory": tmp.path }

    const missing = await server.request(route, { headers })
    await cancelBody(missing)
    expect(missing.status).toBe(401)

    const authed = await server.request(route, {
      headers: { ...headers, authorization: basic("orynr", "secret") },
    })
    await cancelBody(authed)
    expect(authed.status).toBe(404)
  })
})
