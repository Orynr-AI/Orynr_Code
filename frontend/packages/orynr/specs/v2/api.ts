// @ts-nocheck

import { Orynrcode } from "@orynr-ai/core"
import { ReadTool } from "@orynr-ai/core/tools"

const orynr = Orynrcode.make({})

orynr.tool.add(ReadTool)

orynr.tool.add({
  name: "bash",
  schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The command to run.",
      },
    },
    required: ["command"],
  },
  execute(input, ctx) {},
})

orynr.auth.add({
  provider: "openai",
  type: "api",
  value: process.env.OPENAI_API_KEY,
})

orynr.agent.add({
  name: "build",
  permissions: [],
  model: {
    id: "gpt-5-5",
    provider: "openai",
    variant: "xhigh",
  },
})

const sessionID = await orynr.session.create({
  agent: "build",
})

orynr.subscribe((event) => {
  console.log(event)
})

await orynr.session.prompt({
  sessionID,
  text: "hey what is up",
})

await orynr.session.prompt({
  sessionID,
  text: "what is up with this",
  files: [
    {
      mime: "image/png",
      uri: "data:image/png;base64,xxxx",
    },
  ],
})

await orynr.session.wait()

console.log(await orynr.session.messages(sessionID))
