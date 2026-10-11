import type { TuiPlugin, TuiPluginModule } from "@orynr-ai/plugin/tui"
import HomeFooter from "./home/footer"
import HomeTips from "./home/tips"
import SidebarContext from "./sidebar/context"
import SidebarFiles from "./sidebar/files"
import SidebarFooter from "./sidebar/footer"
import SidebarLsp from "./sidebar/lsp"
import SidebarMcp from "./sidebar/mcp"
import SidebarSandbox from "./sidebar/sandbox"
import SidebarTeam from "./sidebar/team"
import SidebarTodo from "./sidebar/todo"
import DiffViewer from "./system/diff-viewer"
import Notifications from "./system/notifications"
import Permission from "./system/permission"
import PluginManager from "./system/plugins"
import Sandbox from "./system/sandbox"
import WhichKey from "./system/which-key"

export type BuiltinTuiPlugin = Omit<TuiPluginModule, "id"> & {
  id: string
  tui: TuiPlugin
  enabled?: boolean
}

export function createBuiltinPlugins(options: { experimentalEventSystem: boolean }): BuiltinTuiPlugin[] {
  return [
    HomeFooter,
    HomeTips,
    SidebarContext,
    SidebarMcp,
    SidebarLsp,
    SidebarSandbox,
    SidebarTeam,
    SidebarTodo,
    SidebarFiles,
    SidebarFooter,
    Notifications,
    PluginManager,
    WhichKey,
    DiffViewer,
    Sandbox,
    Permission,
  ]
}
