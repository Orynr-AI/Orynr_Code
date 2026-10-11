import { describe, expect, test } from "bun:test"
import { providerOptions } from "../../../../src/component/dialog-provider"

describe("providerOptions", () => {
  test("offers adding a local or network server first", () => {
    expect(providerOptions([{ id: "openai", name: "OpenAI" }])[0]).toMatchObject({
      title: "Local or network server",
      value: "__orynr_local_server__",
      category: "Self-hosted",
    })
  })

  test("the Self-hosted group holds only that entry", () => {
    const options = providerOptions(
      [
        { id: "openai", name: "OpenAI" },
        { id: "lmstudio", name: "LMStudio" }, // catalog preset for a self-hosted server
        { id: "local", name: "GPU box llama.cpp", options: { baseURL: "http://192.168.1.50:8080/v1" } },
        { id: "gpu-box", name: "My GPU server", options: { baseURL: "http://10.0.0.5:8005/v1" } },
      ],
      ["local", "gpu-box"],
    )
    expect(options.filter((option) => option.category === "Self-hosted").map((option) => option.value)).toEqual([
      "__orynr_local_server__",
    ])
    const values = options.map((option) => option.value)
    expect(values).not.toContain("lmstudio")
    expect(values).not.toContain("local")
    expect(values).not.toContain("gpu-box")
    expect(values).not.toContain("__orynr_custom_provider__")
  })

  test("shows every cloud provider, never opencode's own (2.2.8: the whitelist hid ~130 of them)", () => {
    const values = providerOptions([
      { id: "openai", name: "OpenAI" },
      { id: "deepseek", name: "DeepSeek" },
      { id: "morph", name: "Morph" },
      { id: "aws", name: "AWS Bedrock" },
      { id: "opencode", name: "OpenCode Zen" },
      { id: "opencode-go", name: "OpenCode Go" },
    ]).map((option) => option.value)
    for (const id of ["openai", "deepseek", "morph", "aws"]) expect(values).toContain(id)
    expect(values).not.toContain("opencode")
    expect(values).not.toContain("opencode-go")
  })

  test("keeps a connected cloud provider even when it is not whitelisted", () => {
    const values = providerOptions([{ id: "morph", name: "Morph" }], ["morph"]).map((option) => option.value)
    expect(values).toContain("morph")
  })

  test("orders cloud providers by priority after the local server entry", () => {
    expect(
      providerOptions([
        { id: "google", name: "Google" },
        { id: "openai", name: "OpenAI" },
        { id: "anthropic", name: "Anthropic" },
        { id: "deepseek", name: "DeepSeek" },
        { id: "github-copilot", name: "GitHub Copilot" },
      ]).map((option) => option.value),
    ).toEqual(["__orynr_local_server__", "openai", "github-copilot", "anthropic", "google", "deepseek"])
  })

  test("does not collide with a configured provider named other", () => {
    const values = providerOptions([{ id: "other", name: "Other Provider" }], ["other"]).map((option) => option.value)
    expect(new Set(values).size).toBe(values.length)
  })
})
