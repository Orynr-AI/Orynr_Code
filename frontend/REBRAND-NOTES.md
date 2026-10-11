# Rebrand notes — upstream → Orynrcode

Status 2026-09-25. The rebrand is complete: all workspace packages are `@orynr-ai/*`, the
SDK exports `createOrynrClient`, and user-visible strings, outbound User-Agents, headers,
env vars, config/data paths and internal ids all use the orynr / Orynrcode names.

Features that could only act as the upstream project were removed rather than renamed:
the upstream GitHub command and GitHub App integration, the IDE auto-install of the
upstream VS Code extension, upstream-install detection in `orynr uninstall`, and the
`script/github`, `script/stats`, `script/raw-changelog` tools.

## What still names the upstream project

Only the license and copyright notices remain. The MIT license requires them, so they
stay as they are:

- the MIT license text and its copyright line in the repository's root `NOTICE.md`
  (section 1). That is the single place; `frontend/LICENSE` and the package `LICENSE` files point to it.

Everything else that still used the upstream name was removed on 2026-09-25, because that
code never runs in the shipped product: the launcher only ever runs the compiled frontend
as `orynr-tui attach <url> --dir <folder>`, and logins/providers are handled by the Python
engine. That sweep removed:

- legacy config/data fallbacks (old config dir and file names, old headers, old env vars,
  old theme and sound-pack id aliases, old database renames, the old project-marker
  file, old managed-config locations, the old launcher env var);
- the upstream's own paid model gateways (provider and all special-casing); the
  embedded and runtime models.dev catalog is filtered so they never appear;
- the third-party auth plugins published under the upstream name, and the deprecated
  plugin-package list; the plugin compatibility field is now `engines.orynr`;
- the upstream release channels in the publish tooling (AUR, Homebrew, upstream URLs);
- identity strings sent to outside services (User-Agent, xAI referrer, Codex
  originator, Cerebras integration header, account client id), now all orynr.

## Compatibility shims that remain

- `core/src/env-compat.ts`: inbound `ORYNRCODE_*` env vars are mirrored to `ORYNR_*`.

## Guards

- `packages/orynr/script/publish.ts` throws unless `ORYNR_PUBLISH_CONFIRMED=1`.
- `Installation.latest()/upgrade()` are neutered (no upstream registry queries).
- `/share` requires an explicit `enterprise.url`; the TUI crash reporter copies a
  plain-text report instead of opening an issue upstream.

## Web-deliverable packages

`packages/console/*` and `packages/stats` were removed; the Orynrcode React platform
replaces them. `packages/ui` stays as the shared theme/asset base.
