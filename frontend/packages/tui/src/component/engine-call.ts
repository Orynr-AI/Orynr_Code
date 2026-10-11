import type { useSDK } from "../context/sdk"

// Plain engine routes the generated SDK has no methods for (/global/ready, /projects, /project/*, /knowledge,
// /sandbox). They MUST go through the SDK's own underlying client: inside the app, engine calls travel over the
// app's own connection, and a bare fetch() to the engine address never answered - the project picker sat on
// "Loading your projects..." holding the keyboard (found by verify_tui_drive, 2026-10-03).
type Reply = { data?: unknown; error?: unknown }
type Raw = {
  get(options: { url: string }): Promise<Reply>
  post(options: { url: string; body?: unknown; headers?: Record<string, string> }): Promise<Reply>
}

function raw(sdk: ReturnType<typeof useSDK>): Raw {
  return (sdk.client as unknown as { client: Raw }).client
}

export async function engineGet<T>(sdk: ReturnType<typeof useSDK>, url: string): Promise<T | undefined> {
  try {
    const r = await raw(sdk).get({ url })
    return (r.data ?? r.error) as T | undefined
  } catch {
    return undefined
  }
}

export async function enginePost<T>(sdk: ReturnType<typeof useSDK>, url: string, body: unknown): Promise<T | undefined> {
  try {
    const r = await raw(sdk).post({ url, body, headers: { "Content-Type": "application/json" } })
    return (r.data ?? r.error) as T | undefined
  } catch {
    return undefined
  }
}
