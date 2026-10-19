export * as ConfigPaths from "./paths"

import path from "path"
import { Flag } from "@orynr-ai/core/flag/flag"
import { Global } from "@orynr-ai/core/global"
import { unique } from "remeda"
import * as Effect from "effect/Effect"
import { FSUtil } from "@orynr-ai/core/fs-util"

export const files = Effect.fn("ConfigPaths.projectFiles")(function* (
  name: string,
  directory: string,
  worktree?: string,
) {
  const afs = yield* FSUtil.Service
  return (yield* afs.up({
    targets: [`${name}.jsonc`, `${name}.json`],
    start: directory,
    stop: worktree,
  })).toReversed()
})

// ".orynr" is the project folder the engine uses too (plugins, skills); ".orynrcode" still read for older projects.
export const DIR_TARGETS = [".orynr", ".orynrcode"]

export const directories = Effect.fn("ConfigPaths.directories")(function* (directory: string, worktree?: string) {
  const afs = yield* FSUtil.Service
  return unique([
    Global.Path.config,
    ...(!Flag.ORYNR_DISABLE_PROJECT_CONFIG
      ? yield* afs.up({
          targets: DIR_TARGETS,
          start: directory,
          stop: worktree,
        })
      : []),
    ...(yield* afs.up({
      targets: DIR_TARGETS,
      start: Global.Path.home,
      stop: Global.Path.home,
    })),
    ...(Flag.ORYNR_CONFIG_DIR ? [Flag.ORYNR_CONFIG_DIR] : []),
  ])
})

export function fileInDirectory(dir: string, name: string) {
  return [path.join(dir, `${name}.json`), path.join(dir, `${name}.jsonc`)]
}
