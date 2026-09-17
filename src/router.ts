// Pick the MCP tools a request needs with one Jev call.
import type { ChoiceAnswer, NoulAnswer, SystemOneResponse, Transport } from "./typesafe.js"

export type CatalogTool = {
  key: string // opencode tool id: `${server}_${tool}`, sanitized
  server: string // sanitized server name
  name: string // tool name as the MCP server reports it
  description: string
  inputSchema: Record<string, unknown>
}

export type RouterOptions = {
  model?: string
  usesThreshold?: number
  serverThreshold?: number
  perServer?: number
  maxTools?: number
  noneThreshold?: number
}

export type Route = {
  tools: string[] // tool keys to keep, most likely first
  needsTool: number
  servers: Record<string, number>
  latencyMs: number
  usage?: SystemOneResponse["usage"]
  model?: string
}

export const NONE = "__none__"
const DESC_CHARS = 240
const LISTING = 30
const MAX_OPTIONS = 255

export class Router {
  private readonly bySrv = new Map<string, CatalogTool[]>()
  private readonly questions: Record<string, unknown>
  private readonly opts: Required<RouterOptions>

  constructor(tools: CatalogTool[], private readonly transport: Transport, opts: RouterOptions = {}) {
    this.opts = {
      model: "jev-latest", usesThreshold: 0.5, serverThreshold: 0.3, perServer: 2, maxTools: 10, noneThreshold: 0.9,
      ...opts,
    }
    for (const t of tools) {
      const list = this.bySrv.get(t.server) ?? []
      list.push(t)
      this.bySrv.set(t.server, list)
    }
    // Jev's Choice takes at most 255 options; split very large servers into parts.
    for (const [server, list] of [...this.bySrv]) {
      if (list.length <= MAX_OPTIONS) continue
      this.bySrv.delete(server)
      for (let i = 0; i < list.length; i += MAX_OPTIONS) this.bySrv.set(`${server}#${i / MAX_OPTIONS + 1}`, list.slice(i, i + MAX_OPTIONS))
    }
    this.questions = this.buildQuestions()
  }

  get size() {
    return [...this.bySrv.values()].reduce((n, l) => n + l.length, 0)
  }

  private serverDescription(server: string) {
    const all = this.bySrv.get(server)!
    // Sample evenly across the server. Taking the first N would describe a large server by one
    // alphabetical corner of it (all of Atlassian's confluence_* tools, none of its jira_* ones).
    const step = Math.max(1, Math.ceil(all.length / LISTING))
    const names = all.filter((_, i) => i % step === 0).slice(0, LISTING).map((t) => t.name)
    return `Tool server '${server}' with ${all.length} tools, including: ${names.join(", ")}`
  }

  private buildQuestions() {
    const criteria: Record<string, string> = {}
    for (const s of this.bySrv.keys()) criteria[s] = this.serverDescription(s)
    criteria[NONE] = "No tool is needed; the request can be answered directly."
    const q: Record<string, unknown> = {
      server: {
        type: "choice",
        instructions:
          "Which tool server would an AI coding assistant need to call first to carry out `request`? " +
          "Pick the no-tool option if the request needs none of these servers.",
        criteria,
      },
    }
    for (const [s, list] of this.bySrv) {
      const c = Object.fromEntries(list.map((t) => [t.key, t.description.slice(0, DESC_CHARS) || null]))
      q[`first::${s}`] = { type: "choice", criteria: c,
        instructions: `If the assistant uses the '${s}' tools for \`request\`, which one would it call first?` }
      q[`action::${s}`] = { type: "choice", criteria: c,
        instructions: `If the assistant uses the '${s}' tools for \`request\`, which one performs the main thing the ` +
          "user asked for (the final action or answer, not a preliminary lookup)?" }
      q[`uses::${s}`] = { type: "noul",
        instructions: `Will fully completing \`request\` require calling at least one tool from '${s}' (${this.serverDescription(s)})?` }
    }
    return q
  }

  async route(request: string, context = "", signal = AbortSignal.timeout(10_000)): Promise<Route> {
    const t0 = performance.now()
    const resp = await this.transport(
      { model: this.opts.model, questions: this.questions, state: { request, recent_context: context } }, signal)
    const route = this.select(resp.answers)
    route.latencyMs = performance.now() - t0
    route.usage = resp.usage
    route.model = resp.model
    return route
  }

  select(answers: SystemOneResponse["answers"]): Route {
    const choice = (k: string) => answers[k] as ChoiceAnswer
    const noul = (k: string) => (answers[k] as NoulAnswer).noul
    const pServer = choice("server").probabilities
    const pNone = pServer[NONE] ?? 0
    const servers: Record<string, number> = {}
    for (const s of this.bySrv.keys()) servers[s] = Math.max(noul(`uses::${s}`), pServer[s] ?? 0)
    const route: Route = { tools: [], needsTool: 1 - pNone, servers, latencyMs: 0 }
    if (pNone >= this.opts.noneThreshold) return route

    const ranked = [...this.bySrv.keys()].sort((a, b) => servers[b] - servers[a])
    let chosen = ranked.filter((s) => noul(`uses::${s}`) >= this.opts.usesThreshold || (pServer[s] ?? 0) >= this.opts.serverThreshold)
    if (chosen.length === 0) chosen = ranked.slice(0, 1)
    // Round-robin over the chosen servers, so the maxTools budget cannot be spent entirely on the
    // first server and starve the second one a multi-server task needs.
    const perServerPicks = chosen.map((s) => {
      const names: string[] = []
      for (let rank = 0; rank < this.opts.perServer; rank++) {
        for (const key of [`first::${s}`, `action::${s}`]) {
          const top = Object.entries(choice(key).probabilities).sort((a, b) => b[1] - a[1])[rank]
          if (top && !names.includes(top[0])) names.push(top[0])
        }
      }
      return names
    })
    const picks: string[] = []
    for (let rank = 0; picks.length < this.opts.maxTools && perServerPicks.some((n) => n.length > rank); rank++) {
      for (const names of perServerPicks) {
        if (names[rank] && !picks.includes(names[rank]) && picks.length < this.opts.maxTools) picks.push(names[rank])
      }
    }
    route.tools = picks
    return route
  }
}
