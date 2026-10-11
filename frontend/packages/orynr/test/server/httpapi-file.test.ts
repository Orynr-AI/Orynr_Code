import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import { Context, Effect } from "effect"
import path from "path"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { FilePaths } from "../../src/server/routes/instance/httpapi/groups/file"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { pollWithTimeout } from "../lib/effect"

const context = Context.empty() as Context.Context<unknown>

function request(route: string, directory: string, query?: Record<string, string>) {
  const url = new URL(`http://localhost${route}`)
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value)
  }
  return HttpApiApp.webHandler().handler(
    new Request(url, {
      headers: {
        "x-orynr-directory": directory,
      },
    }),
    context,
  )
}

// Resolve the ripgrep binary to completion before any test disposes an
// instance. RipgrepBinary.filepath is wrapped in Effect.cached: if the first
// resolution (a download when no system rg is available) is interrupted by
// instance disposal, the interrupt exit is cached forever and every later
// search endpoint fails with an empty 503. Warming through the same web
// handler guarantees the process-wide cache holds a success before the
// afterEach disposal below can interrupt anything.
beforeAll(async () => {
  await using tmp = await tmpdir({ git: true })
  await Bun.write(path.join(tmp.path, "warmup.txt"), "needle")
  const deadline = Date.now() + 120_000
  while (true) {
    const response = await request(FilePaths.findText, tmp.path, { pattern: "needle" })
    if (response.status === 200) break
    if (Date.now() > deadline) {
      throw new Error(`ripgrep warmup did not complete: last status ${response.status}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  await disposeAllInstances()
  await resetDatabase()
}, 130_000)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("file HttpApi", () => {
  test("serves read endpoints", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "hello.txt"), "hello")

    const [list, content, status] = await Promise.all([
      request(FilePaths.list, tmp.path, { path: "." }),
      request(FilePaths.content, tmp.path, { path: "hello.txt" }),
      request(FilePaths.status, tmp.path),
    ])

    expect(list.status).toBe(200)
    expect(await list.json()).toContainEqual(
      expect.objectContaining({ name: "hello.txt", path: "hello.txt", type: "file" }),
    )

    expect(content.status).toBe(200)
    expect(await content.json()).toMatchObject({ type: "text", content: "hello" })

    expect(status.status).toBe(200)
    expect(await status.json()).toEqual([])
  })

  test(
    "serves search endpoints",
    async () => {
      await using tmp = await tmpdir({ git: true })
      await Bun.write(path.join(tmp.path, "hello.txt"), "needle")

      const [text, symbols] = await Promise.all([
        request(FilePaths.findText, tmp.path, { pattern: "needle" }),
        request(FilePaths.findSymbol, tmp.path, { query: "hello" }),
      ])
      const files = await Effect.runPromise(
        pollWithTimeout(
          Effect.promise(async () => {
            const response = await request(FilePaths.findFile, tmp.path, { query: "hello", type: "file" })
            const body = await response.json()
            return body.includes("hello.txt") ? { response, body } : undefined
          }),
          "file search index was not ready",
          "15 seconds",
        ),
      )

      expect(text.status).toBe(200)
      expect(await text.json()).toContainEqual(expect.objectContaining({ line_number: 1 }))

      expect(files.response.status).toBe(200)
      expect(files.body).toContain("hello.txt")

      expect(symbols.status).toBe(200)
      expect(await symbols.json()).toEqual([])
    },
    20_000,
  )
})
