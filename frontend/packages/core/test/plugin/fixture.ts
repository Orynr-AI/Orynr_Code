import { AgentV2 } from "@orynr-ai/core/agent"
import { AISDK } from "@orynr-ai/core/aisdk"
import { Catalog } from "@orynr-ai/core/catalog"
import { CommandV2 } from "@orynr-ai/core/command"
import { Credential } from "@orynr-ai/core/credential"
import { AppNodeBuilder } from "@orynr-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@orynr-ai/core/effect/app-node-platform"
import { LayerNode } from "@orynr-ai/core/effect/layer-node"
import { EventV2 } from "@orynr-ai/core/event"
import { FileSystem } from "@orynr-ai/core/filesystem"
import { FSUtil } from "@orynr-ai/core/fs-util"
import { Integration } from "@orynr-ai/core/integration"
import { Location } from "@orynr-ai/core/location"
import { Npm } from "@orynr-ai/core/npm"
import { PluginV2 } from "@orynr-ai/core/plugin"
import { Reference } from "@orynr-ai/core/reference"
import { SkillV2 } from "@orynr-ai/core/skill"
import { Effect, Layer } from "effect"
import { tempLocationLayer } from "../fixture/location"

const npmLayer = Layer.succeed(
  Npm.Service,
  Npm.Service.of({
    add: () => Effect.succeed({ directory: "", entrypoint: undefined }),
    install: () => Effect.void,
    which: () => Effect.succeed(undefined),
  }),
)

export const PluginTestLayer = AppNodeBuilder.build(
  LayerNode.group([
    FileSystem.node,
    FSUtil.node,
    Location.node,
    Npm.node,
    Credential.node,
    EventV2.node,
    LayerNodePlatform.httpClient,
    PluginV2.node,
    AgentV2.node,
    AISDK.node,
    Catalog.node,
    CommandV2.node,
    Integration.node,
    Reference.node,
    SkillV2.node,
  ]),
  [
    [Location.node, tempLocationLayer],
    [Npm.node, npmLayer],
  ],
)
