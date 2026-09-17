// opencode loads every export of a plugin module, so this file exports only the plugin.
import type { PluginModule } from "@opencode-ai/plugin"
import { createToolRouter } from "./plugin.js"

const plugin: PluginModule = {
  id: "opencode-toolrouter",
  server: (input, options) => createToolRouter(input, options),
}

export default plugin
