import { afterEach, describe, expect, test } from "bun:test"
import { Option, Redacted } from "effect"
import { Flag } from "@orynr-ai/core/flag/flag"
import { ServerAuth } from "../../src/server/auth"

const original = {
  ORYNR_SERVER_PASSWORD: Flag.ORYNR_SERVER_PASSWORD,
  ORYNR_SERVER_USERNAME: Flag.ORYNR_SERVER_USERNAME,
}

afterEach(() => {
  Flag.ORYNR_SERVER_PASSWORD = original.ORYNR_SERVER_PASSWORD
  Flag.ORYNR_SERVER_USERNAME = original.ORYNR_SERVER_USERNAME
})

describe("ServerAuth", () => {
  test("does not emit auth headers without a password", () => {
    Flag.ORYNR_SERVER_PASSWORD = undefined
    Flag.ORYNR_SERVER_USERNAME = "alice"

    expect(ServerAuth.header()).toBeUndefined()
    expect(ServerAuth.headers()).toBeUndefined()
  })

  test("defaults to the orynr username", () => {
    Flag.ORYNR_SERVER_PASSWORD = "secret"
    Flag.ORYNR_SERVER_USERNAME = undefined

    expect(ServerAuth.headers()).toEqual({
      Authorization: `Basic ${Buffer.from("orynr:secret").toString("base64")}`,
    })
  })

  test("uses the configured username", () => {
    Flag.ORYNR_SERVER_PASSWORD = "secret"
    Flag.ORYNR_SERVER_USERNAME = "alice"

    expect(ServerAuth.headers()).toEqual({
      Authorization: `Basic ${Buffer.from("alice:secret").toString("base64")}`,
    })
  })

  test("prefers explicit credentials", () => {
    Flag.ORYNR_SERVER_PASSWORD = "secret"
    Flag.ORYNR_SERVER_USERNAME = "alice"

    expect(ServerAuth.headers({ password: "cli-secret", username: "bob" })).toEqual({
      Authorization: `Basic ${Buffer.from("bob:cli-secret").toString("base64")}`,
    })
  })

  test("validates decoded credentials against effect config", () => {
    const config = { password: Option.some("secret"), username: "alice" }

    expect(ServerAuth.required(config)).toBe(true)
    expect(ServerAuth.authorized({ username: "alice", password: Redacted.make("secret") }, config)).toBe(true)
    expect(ServerAuth.authorized({ username: "orynr", password: Redacted.make("secret") }, config)).toBe(false)
  })
})
