# Third-party notices

Orynr Engine is an independent implementation, but it stands on the shoulders of open-source work and we
want to credit it honestly and completely. This file lists the third-party software whose code, assets, or
runtime we use or redistribute, with each original license retained as required. For the people behind these
projects, see [THANKS.md](THANKS.md).

The installed app (Orynr Code, `ora.exe`) bundles the licenses of every runtime dependency in its
`THIRD_PARTY_LICENSES` folder — see **§3** below. These licences apply to those components; the app's own
terms are in `EULA.txt`. Questions: info@orynr.com · https://orynr.com

--------------------------------------------------------------------------------

## 1. Terminal UI and prompt/tool assets (MIT License)

**Used:** the agent/system **prompt templates** and **tool descriptions** under
`orynr_server/assets/prompt/` and `orynr_server/assets/tool/` are reused (in whole or in part) from an
MIT-licensed open-source coding-agent project, and the bundled terminal UI in `frontend/` is a vendored,
rebranded derivative of that project's TUI.

**Not derived:** the engine's own source — the HTTP server, session engine, tools, providers, agents,
storage — is original code written for Orynr LLC, not a translation of that project's source.

Used under the MIT License. As that license requires, its full text and the original copyright notice are
retained below, unchanged.

```
MIT License

Copyright (c) 2025 opencode

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

--------------------------------------------------------------------------------

## 2. opentui — the terminal-UI framework the bundled TUI is built on

**Used:** the bundled TUI depends on `@opentui/core`, `@opentui/solid`, `@opentui/keymap` (and
`opentui-spinner`), which are compiled into the packaged TUI binary.

Source: https://github.com/sst/opentui — used under the MIT License, retained in full below.

```
MIT License

Copyright (c) 2025 opentui

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

--------------------------------------------------------------------------------

## 3. Bundled runtime dependencies (Python + npm)

The packaged build redistributes its runtime dependencies, so their licenses travel with it. Rather than
hand-maintain a list that would drift, the build generates a complete, accurate bundle from the actually
installed packages:

- **Python** (from `requirements.txt`: fastapi, uvicorn, litellm, pydantic, SQLAlchemy, httpx, GitPython,
  wasmtime, Pillow, cryptography, mcp, …) — a mix of MIT / BSD / Apache-2.0 / HPND.
- **npm / bun** (the TUI: @opentui/*, solid-js, …) — predominantly MIT.

Run `python scripts/collect_licenses.py` (see that script) to emit `output/THIRD_PARTY_LICENSES/` with the
full license text of every dependency. That folder MUST ship inside/next to `output/orynr.exe`. The build
pipeline runs it automatically before packaging.

--------------------------------------------------------------------------------

## 4. Not part of this engine

For the avoidance of doubt, the Orynr **engine** does **not** include or redistribute **OpenHands**
(`github.com/All-Hands-AI/OpenHands`) or any graph library — those were used only on the separate
**platform** side (the retired code-agent), which carries its own attribution. If a platform distribution
ships OpenHands or a graph component, that distribution must include their licenses (Apache-2.0 for
OpenHands, plus whatever the graph component uses). This is flagged for the platform in `PLATFORM_DELTA.md`.

The Orynr Engine's own code is proprietary — see `LICENSE`.

--------------------------------------------------------------------------------

## 5. Ideas credited (no code copied)

The change analysis used for code reviews (`orynr_server/review/changes.py`: "changed functions no test calls",
a per-function risk score, and reviewing only the changed regions within a line budget) follows ideas from
**code-review-graph** by Tirth Kanani (MIT License, `github.com/tirth8205/code-review-graph`, version 2.3.9).
It is our own implementation; no source from that project is included.
