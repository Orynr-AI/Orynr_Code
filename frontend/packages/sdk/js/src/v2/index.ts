export * from "./client.js"
export * from "./server.js"

import { createOrynrClient } from "./client.js"
import { createOrynrServer } from "./server.js"
import type { ServerOptions } from "./server.js"

export * as data from "./data.js"

export async function createOrynr(options?: ServerOptions) {
  const server = await createOrynrServer({
    ...options,
  })

  const client = createOrynrClient({
    baseUrl: server.url,
  })

  return {
    client,
    server,
  }
}
