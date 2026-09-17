// Read MCP tool definitions from the servers in the opencode config, and call them for the fallback.
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { CatalogTool } from "./router.js"

export type LocalServer = { type: "local"; command: string[]; environment?: Record<string, string>; enabled?: boolean; timeout?: number }
export type RemoteServer = { type: "remote"; url: string; headers?: Record<string, string>; enabled?: boolean; timeout?: number; oauth?: unknown }
export type McpConfig = Record<string, LocalServer | RemoteServer>

// Same rules opencode uses for MCP tool ids (packages/opencode/src/mcp/catalog.ts).
export const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_")
export const toolKey = (server: string, tool: string) => `${sanitize(server)}_${sanitize(tool)}`

const CACHE_VERSION = 1

/** Respect XDG_CACHE_HOME so sandboxed runs share one catalog cache. */
export function defaultCacheDir() {
  return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "opencode-toolrouter")
}

export class McpCatalog {
  tools: CatalogTool[] = []
  errors: Record<string, string> = {}
  private clients = new Map<string, Promise<Client>>()
  private byKey = new Map<string, CatalogTool & { rawServer: string }>()

  constructor(private readonly config: McpConfig, private readonly cacheDir = defaultCacheDir()) {}

  private enabledServers() {
    return Object.entries(this.config).filter(([, s]) => s && s.enabled !== false && !(s.type === "remote" && s.oauth))
  }

  private cachePath() {
    const hash = createHash("sha256").update(JSON.stringify([CACHE_VERSION, this.enabledServers()])).digest("hex").slice(0, 16)
    return join(this.cacheDir, `catalog-${hash}.json`)
  }

  /** Load tool definitions from the cache, or connect to every server and list them. */
  async load({ refresh = false }: { refresh?: boolean } = {}): Promise<void> {
    const path = this.cachePath()
    if (!refresh) {
      try {
        const cached = JSON.parse(await readFile(path, "utf8"))
        this.setTools(cached.tools)
        return
      } catch {
        // no usable cache
      }
    }
    const listed: (CatalogTool & { rawServer: string })[] = []
    await Promise.all(this.enabledServers().map(async ([name]) => {
      try {
        const client = await this.client(name)
        let cursor: string | undefined
        do {
          const page = await client.listTools(cursor ? { cursor } : {})
          for (const t of page.tools) {
            listed.push({ key: toolKey(name, t.name), server: sanitize(name), rawServer: name, name: t.name,
              description: (t.description ?? "").trim(), inputSchema: (t.inputSchema ?? { type: "object" }) as Record<string, unknown> })
          }
          cursor = page.nextCursor
        } while (cursor)
      } catch (e) {
        this.errors[name] = e instanceof Error ? e.message : String(e)
      }
    }))
    listed.sort((a, b) => a.key.localeCompare(b.key))
    this.setTools(listed)
    // Only cache a complete listing, so a server that failed once is retried next start.
    if (Object.keys(this.errors).length === 0 && listed.length > 0) {
      await mkdir(this.cacheDir, { recursive: true })
      await writeFile(path, JSON.stringify({ version: CACHE_VERSION, tools: listed }))
    }
  }

  setTools(tools: (CatalogTool & { rawServer: string })[]) {
    this.tools = tools
    this.byKey = new Map(tools.map((t) => [t.key, t]))
  }

  get(key: string) {
    return this.byKey.get(key)
  }

  private client(server: string): Promise<Client> {
    let c = this.clients.get(server)
    if (!c) {
      c = this.connect(server)
      c.catch(() => this.clients.delete(server))
      this.clients.set(server, c)
    }
    return c
  }

  private async connect(server: string): Promise<Client> {
    const cfg = this.config[server]
    const client = new Client({ name: "opencode-toolrouter", version: "0.1.0" })
    if (cfg.type === "local") {
      const [command, ...args] = cfg.command
      const env = Object.fromEntries(Object.entries({ ...process.env, ...cfg.environment }).filter(([, v]) => v !== undefined)) as Record<string, string>
      await client.connect(new StdioClientTransport({ command, args, env, stderr: "ignore" }))
    } else {
      await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers } }))
    }
    return client
  }

  /** Call a tool through the plugin's own connection to its server. */
  async call(key: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.byKey.get(key)
    if (!tool) throw new Error(`Unknown tool: ${key}`)
    const client = await this.client(tool.rawServer)
    const result = await client.callTool({ name: tool.name, arguments: args })
    const content = (result.content ?? []) as { type: string; text?: string }[]
    const text = content.map((c) => (c.type === "text" ? c.text : `[${c.type} content]`)).join("\n")
    return result.isError ? `Tool error: ${text}` : text
  }

  async close() {
    await Promise.all([...this.clients.values()].map(async (c) => (await c.catch(() => undefined))?.close()))
    this.clients.clear()
  }
}

/** Simple keyword search over tool names and descriptions, for the find_tools fallback. */
export function searchTools(tools: CatalogTool[], query: string, limit = 5): CatalogTool[] {
  const words = (s: string) => s.toLowerCase().replace(/([a-z])([A-Z])/g, "$1 $2").split(/[^a-z0-9]+/).filter((w) => w.length > 1)
  const q = new Set(words(query))
  if (q.size === 0) return []
  const scored = tools.map((t) => {
    const nameWords = words(`${t.server} ${t.name}`)
    const descWords = words(t.description)
    let score = 0
    for (const w of q) {
      if (nameWords.includes(w)) score += 3
      else if (nameWords.some((n) => n.startsWith(w) || w.startsWith(n))) score += 1.5
      if (descWords.includes(w)) score += 1
    }
    return { t, score }
  })
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.t)
}
