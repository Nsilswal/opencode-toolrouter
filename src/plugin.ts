import { tool, type Hooks, type PluginInput, type PluginOptions } from "@opencode-ai/plugin"
import { McpCatalog, searchTools, type McpConfig } from "./catalog.js"
import { Router, type Route, type RouterOptions } from "./router.js"
import { httpTransport, type Transport } from "./typesafe.js"

export type ToolRouterOptions = RouterOptions & {
  /** TypeSafe API key. Defaults to the TYPESAFE_API_KEY environment variable. */
  apiKey?: string
  /** Server names or tool ids that are never hidden. */
  alwaysLoad?: string[]
  /** Skip routing when the MCP servers expose fewer tools than this. */
  minTools?: number
  /** Add find_tools and use_tool so the model can reach hidden tools. */
  fallback?: boolean
  /** Give up on routing (and hide nothing) after this long. */
  timeoutMs?: number
  /** Include this many characters of earlier conversation as routing context. */
  contextChars?: number
  /** Ignore the cached tool catalog and list tools from every server again. */
  refreshCatalog?: boolean
  /** For tests: replace the TypeSafe HTTP call. */
  transport?: Transport
}

const SERVICE = "opencode-toolrouter"

export async function createToolRouter(input: Pick<PluginInput, "client">, raw: PluginOptions = {}): Promise<Hooks> {
  const opts = raw as ToolRouterOptions
  const apiKey = opts.apiKey ?? process.env.TYPESAFE_API_KEY
  const minTools = opts.minTools ?? 30
  const timeoutMs = opts.timeoutMs ?? 8000
  const contextChars = opts.contextChars ?? 1500
  const alwaysLoad = new Set(opts.alwaysLoad ?? [])
  const transport = opts.transport ?? (apiKey ? httpTransport(apiKey) : undefined)

  const log = (level: "info" | "warn" | "error" | "debug", message: string, extra?: Record<string, unknown>) =>
    input.client.app.log({ body: { service: SERVICE, level, message, extra } }).catch(() => undefined)

  let catalog: McpCatalog | undefined
  let router: Router | undefined
  let ready: Promise<void> | undefined
  const hidden = new Map<string, Set<string>>() // sessionID -> tool ids hidden for the current request

  const start = (mcp: McpConfig | undefined) => {
    if (!transport) {
      void log("warn", "TYPESAFE_API_KEY is not set; tool routing is off")
      return
    }
    if (!mcp || Object.keys(mcp).length === 0 || ready) return
    catalog = new McpCatalog(mcp)
    ready = catalog.load({ refresh: opts.refreshCatalog }).then(() => {
      router = new Router(catalog!.tools, transport, opts)
      void log("info", `catalog ready: ${catalog!.tools.length} MCP tools`, { errors: catalog!.errors })
    }).catch((e) => void log("error", `could not load MCP tool catalog: ${e}`))
  }

  const keep = (key: string, server: string) => alwaysLoad.has(key) || alwaysLoad.has(server)

  const hooks: Hooks = {
    config: async (config) => start((config as { mcp?: McpConfig }).mcp),

    "chat.message": async (_input, output) => {
      const sessionID = output.message.sessionID
      hidden.delete(sessionID)
      const request = output.parts
        .filter((p) => p.type === "text" && !p.synthetic && !p.ignored)
        .map((p) => (p as { text: string }).text)
        .join("\n")
        .trim()
      if (!request || !ready || !catalog) return
      const outcome = await Promise.race([ready.then(() => "ready"), sleep(timeoutMs).then(() => "timeout")])
      if (outcome !== "ready" || !router || router.size < minTools) return

      let route: Route
      let context = ""
      try {
        context = contextChars > 0 ? await recentContext(input.client, sessionID, contextChars) : ""
        route = await router.route(request, context, AbortSignal.timeout(timeoutMs))
      } catch (e) {
        void log("warn", `routing failed, loading all tools: ${e}`)
        return
      }

      const picked = new Set(route.tools)
      const tools = { ...(output.message.tools ?? {}) }
      const hide = new Set<string>()
      for (const t of catalog.tools) {
        if (picked.has(t.key) || keep(t.key, t.server) || tools[t.key] === true) continue
        tools[t.key] = false
        hide.add(t.key)
      }
      output.message.tools = tools
      hidden.set(sessionID, hide)
      void log("info", `loaded ${catalog.tools.length - hide.size}/${catalog.tools.length} MCP tools`, {
        tools: route.tools, latencyMs: Math.round(route.latencyMs), needsTool: route.needsTool, usage: route.usage,
        request: request.slice(0, 200), contextChars: context.length,
      })
    },
  }

  if (opts.fallback !== false) {
    hooks.tool = {
      find_tools: tool({
        description:
          "Search MCP tools that were not loaded for this request. Use it only when none of your available tools " +
          "can do what you need. Returns tool names with their input schemas; run one with use_tool.",
        args: { query: tool.schema.string().describe("What the tool should do, in a few words") },
        async execute(args, ctx) {
          if (!catalog) return "No MCP tool catalog is available."
          const pool = hidden.get(ctx.sessionID)
          const candidates = pool ? catalog.tools.filter((t) => pool.has(t.key)) : catalog.tools
          const found = searchTools(candidates, args.query)
          if (found.length === 0) return `No hidden MCP tools match "${args.query}".`
          return found.map((t) =>
            `## ${t.key}\n${t.description.slice(0, 600)}\ninput schema: ${JSON.stringify(t.inputSchema).slice(0, 2000)}`).join("\n\n")
        },
      }),
      use_tool: tool({
        description: "Run an MCP tool found with find_tools. Pass its exact name and arguments that match its input schema.",
        args: {
          name: tool.schema.string().describe("Exact tool name from find_tools"),
          arguments: tool.schema.record(tool.schema.string(), tool.schema.any()).describe("Tool arguments"),
        },
        async execute(args, ctx) {
          if (!catalog?.get(args.name)) return `Unknown tool "${args.name}". Call find_tools first.`
          // Same permission id opencode uses for this MCP tool, so the user's approval rules still apply.
          await ctx.ask({ permission: args.name, patterns: ["*"], always: ["*"], metadata: { via: "use_tool" } })
          return catalog.call(args.name, args.arguments ?? {})
        },
      }),
    }
  }
  return hooks
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

async function recentContext(client: PluginInput["client"], sessionID: string, chars: number): Promise<string> {
  try {
    const res = await client.session.messages({ path: { id: sessionID }, query: { limit: 6 } })
    const lines: string[] = []
    for (const m of res.data ?? []) {
      const text = m.parts.filter((p) => p.type === "text" && !p.synthetic).map((p) => (p as { text: string }).text).join(" ")
      if (text) lines.push(`${m.info.role}: ${text}`)
    }
    return lines.join("\n").slice(-chars)
  } catch {
    return ""
  }
}
