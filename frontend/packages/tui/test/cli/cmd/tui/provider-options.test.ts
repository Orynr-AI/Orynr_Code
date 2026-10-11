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

  test("shows whitelisted providers (incl. routers + xai/grok) and hides the rest", () => {
    const values = providerOptions([
      { id: "openai", name: "OpenAI" },
      { id: "deepseek", name: "DeepSeek" },
      { id: "openrouter", name: "OpenRouter" }, // whitelisted router
      { id: "xai", name: "xAI" }, // whitelisted (Grok)
      { id: "mistral", name: "Mistral" }, // whitelisted
      { id: "morph", name: "Morph" }, // not whitelisted
      { id: "aws", name: "AWS Bedrock" }, // not whitelisted
    ]).map((option) => option.value)
    expect(values).toContain("openai")
    expect(values).toContain("deepseek")
    expect(values).toContain("openrouter")
    expect(values).toContain("xai")
    expect(values).toContain("mistral")
    expect(values).not.toContain("morph")
    expect(values).not.toContain("aws")
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
