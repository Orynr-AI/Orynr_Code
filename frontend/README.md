<div align="center">

# Orynrcode

**A terminal-first, local-model coding agent.**

Run a capable AI coding agent entirely in your terminal — with your own model,
your own machine, and an optional fully-isolated Docker sandbox.

</div>

---

## Acknowledgements

Orynrcode is built on the outstanding foundation of **[orynrcode](https://orynrcode.ai)**.
Its clean architecture, Effect-based engine, and polished terminal UI are what made this
project possible.

**A sincere thank-you to the orynrcode team** for building and open-sourcing such a strong
framework. orynrcode is released under the MIT License; the original license and copyright
notice are retained in [`Orynrcode_License.txt`](./Orynrcode_License.txt) as required.

If you find Orynrcode useful, please consider supporting and starring
[orynrcode](https://orynrcode.ai) — the upstream work deserves the credit.

---

## What is Orynrcode?

Orynrcode is a coding agent that lives in your terminal. It reads and edits your codebase,
runs commands, plans and executes multi-step work, and can delegate to specialist agents —
all driven by a model of your choosing, including a local model on your own hardware.

It is designed to be **private by default**: your code and your model stay on infrastructure
you control, and shell commands can be confined to an isolated container.

## Features

- **Terminal-first UI** — a fast, keyboard-driven TUI; no browser or cloud account required.
- **Local-model first** — point it at any OpenAI-compatible endpoint (local or hosted).
- **Isolated execution sandbox** — run every command inside a per-project Docker container
  (true kernel-level isolation, project bind-mounted at `/workspace`), or run locally.
  Switch anytime with `/sandbox`.
- **Self-aware agents** — the agent knows whether it is sandboxed and refuses host actions
  it cannot safely perform.
- **Multiple agent modes:**
  - `chat` — the default switchboard that routes work to the right specialist
  - `build` — full read/write/execute implementation
  - `plan` — read-only planning that produces an approach before any edits
  - `autonomous` / `ralph` — keep-going, self-driving execution toward a goal
  - `research` / `thinking` — read-only investigation and reasoning, with a depth dial
  - `code-analyzer` / `risk-analyzer` — read-only code understanding and change-risk review
  - `character` — a warm, read-only personal-assistant persona
- **Permission model** — granular allow/deny/ask rules per tool and path, with a shared
  risk-confirmation gate for destructive or outward-facing actions.
- **Source-based upgrades** — `orynr upgrade` pulls the latest straight from this repository.

## Requirements

- **[Bun](https://bun.sh) 1.3.14+** (the project pins `bun@1.3.14`)
- A model endpoint — a local server (e.g. an OpenAI-compatible `llama.cpp` / vLLM server)
  or any hosted provider
- **Docker Desktop** *(optional)* — only needed for the isolated container sandbox

## Getting Started

```bash
# 1. Clone (private repo — requires access)
git clone https://github.com/Orynr-AI/orynrcode.git
cd orynrcode

# 2. Install dependencies
bun install

# 3. Launch the terminal UI
bun run --cwd packages/orynr dev
```

The `orynr` command (from `packages/orynr`) is the single entry point. With no arguments it
opens the TUI; it also exposes subcommands such as `orynr serve`, `orynr run`, and
`orynr sandbox`.

## Configuration

Configuration lives in `orynr.json` / `orynr.jsonc` at your project root, or globally under
`~/.config/orynr/`. Point Orynrcode at your model:

```jsonc
{
  "provider": {
    "local": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Local model",
      "options": {
        "baseURL": "http://<your-host>:<port>/v1",
        "apiKey": "local-no-key"
      },
      "models": {
        "your-model": { "name": "Your Model" }
      }
    }
  },
  "model": "local/your-model",
  "small_model": "local/your-model"
}
```

Choose the execution runtime the same way (or interactively with `/sandbox`):

```jsonc
{ "sandbox": { "runtime": "docker" } }   // or "local"
```

Project-level agents, tools, and rules can be added under `.orynrcode/`.

## Usage

- **Command palette** — `Ctrl+M` opens the list of available actions.
- **Switch sandbox** — `/sandbox` picks `local` or `docker` (with a safe copy-out step when
  leaving a running container).
- **View subagents** — `Ctrl+Shift+Z` jumps to a running subagent's session.
- **Switch agents** — use the agent picker to move between `plan`, `build`, `chat`, etc.
- **Upgrade** — `orynr upgrade` fast-forwards this checkout and reinstalls dependencies.

## Project Structure

A Bun workspace monorepo. The most important packages:

| Package | Role |
|---|---|
| `packages/core` | Shared engine — sessions, tools, config, providers, permissions |
| `packages/orynr` | The `orynr` application: CLI, server, agents, sandbox |
| `packages/tui` | The terminal user interface |
| `packages/server` | HTTP API surface |
| `packages/llm` | Model/provider transport layer |
| `packages/sdk` / `sdk-next` | Client SDKs for embedding the engine |
| `packages/plugin` | Plugin API |

## Development

```bash
bun run typecheck     # type-check the workspace
bun test              # run the test suite
```

## License

**Proprietary.** Copyright © Orynr LLC. All rights reserved. See [`LICENSE`](./LICENSE).

This product includes third-party open-source software (notably orynrcode, MIT). Those
notices are retained in [`Orynrcode_License.txt`](./Orynrcode_License.txt).
