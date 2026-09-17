import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { McpCatalog, sanitize, searchTools, toolKey, type McpConfig } from "../src/catalog.js"
import { createToolRouter } from "../src/plugin.js"
import { NONE, Router, type CatalogTool } from "../src/router.js"
import type { SystemOneResponse } from "../src/typesafe.js"

const MCP_DIR = join(__dirname, "..", "bench", "mcp")
const mockServer = (name: string) => ({
  type: "local" as const,
  command: ["python3", join(MCP_DIR, "mock_server.py"), name, join(MCP_DIR, "schemas", `${name}.json`)],
  environment: { MOCK_STOP: "0" },
})

/** Answer the router's questions: pick `first`/`action` per server, and `uses` per server. */
function fakeJev(pick: { server: Record<string, number>; first?: Record<string, string>; action?: Record<string, string>; uses?: Record<string, number> }) {
  return async (body: any): Promise<SystemOneResponse> => {
    const answers: SystemOneResponse["answers"] = {
      server: { type: "choice", choice: "", probabilities: pick.server, confidence: 0.9 },
    }
    for (const [key, q] of Object.entries<any>(body.questions)) {
      if (key === "server") continue
      const [kind, s] = key.split("::")
      if (kind === "uses") answers[key] = { type: "noul", noul: pick.uses?.[s] ?? 0 }
      else {
        const want = (kind === "first" ? pick.first : pick.action)?.[s]
        const names = Object.keys(q.criteria)
        answers[key] = { type: "choice", choice: want ?? names[0], confidence: 0.9,
          probabilities: Object.fromEntries(names.map((n) => [n, want ? (n === want ? 1 : 0) : 1 / names.length])) }
      }
    }
    return { model: "jev-test", answers, usage: { input_tokens: 10, output_tokens: 1 } }
  }
}

const fakeClient = {
  app: { log: async () => ({}) },
  session: { messages: async () => ({ data: [] }) },
} as any

const tool = (server: string, name: string, description = ""): CatalogTool =>
  ({ key: toolKey(server, name), server: sanitize(server), name, description, inputSchema: { type: "object" } })

describe("naming and search", () => {
  it("matches opencode's MCP tool ids", () => {
    expect(toolKey("brave-search", "brave_web_search")).toBe("brave-search_brave_web_search")
    expect(toolKey("my.server", "get item")).toBe("my_server_get_item")
  })

  it("finds tools by name and description words", () => {
    const tools = [tool("slack", "slack_add_reaction", "Add an emoji reaction to a message"), tool("github", "create_issue", "Create an issue")]
    expect(searchTools(tools, "emoji reaction")[0].name).toBe("slack_add_reaction")
    expect(searchTools(tools, "zzz")).toEqual([])
  })
})

describe("Router.select", () => {
  const tools = [tool("github", "list_pull_requests"), tool("github", "create_issue"), tool("slack", "slack_post_message"),
    tool("slack", "slack_list_channels"), tool("time", "get_current_time")]

  it("keeps every server the task uses", async () => {
    const r = new Router(tools, fakeJev({
      server: { github: 0.8, slack: 0.1, time: 0, [NONE]: 0.1 },
      first: { github: "github_list_pull_requests", slack: "slack_slack_list_channels" },
      action: { github: "github_list_pull_requests", slack: "slack_slack_post_message" },
      uses: { github: 0.99, slack: 0.9, time: 0.01 },
    }))
    const route = await r.route("Summarize open PRs and post to #eng")
    expect(route.tools).toContain("github_list_pull_requests")
    expect(route.tools).toContain("slack_slack_post_message")
    expect(route.tools).not.toContain("time_get_current_time")
  })

  it("keeps no MCP tools when none are needed", async () => {
    const r = new Router(tools, fakeJev({ server: { github: 0, slack: 0, time: 0, [NONE]: 0.97 } }))
    expect((await r.route("What is a mutex?")).tools).toEqual([])
  })

  it("splits servers over the 255-option limit", () => {
    const many = Array.from({ length: 300 }, (_, i) => tool("big", `t${i}`))
    expect(new Router(many, fakeJev({ server: {} })).size).toBe(300)
  })
})

describe("plugin with real stdio MCP servers", () => {
  const config: McpConfig = { github: mockServer("github"), slack: mockServer("slack") }
  const cacheDir = mkdtempSync(join(tmpdir(), "toolrouter-test-"))
  let catalog: McpCatalog

  afterAll(async () => catalog?.close())

  it("lists tools from the servers and calls them", async () => {
    catalog = new McpCatalog(config, cacheDir)
    await catalog.load()
    expect(catalog.errors).toEqual({})
    expect(catalog.tools.length).toBe(26 + 8)
    expect(await catalog.call("slack_slack_list_channels", {})).toContain("C04ENG1")
  }, 30_000)

  it("hides unrouted MCP tools on the user message and exposes them through find_tools/use_tool", async () => {
    process.env.HOME = cacheDir // keep the plugin's catalog cache out of the real home folder
    const hooks = await createToolRouter({ client: fakeClient }, {
      minTools: 1,
      transport: fakeJev({
        server: { github: 0.9, slack: 0.05, [NONE]: 0.05 },
        first: { github: "github_create_issue" }, action: { github: "github_create_issue" },
        uses: { github: 0.99, slack: 0.02 },
      }),
    })
    await hooks.config!({ mcp: config } as any)

    const output = {
      message: { sessionID: "s1", tools: { slack_slack_get_users: true } } as any,
      parts: [{ type: "text", text: "File a bug on acme/web: login is broken on Safari" }] as any,
    }
    await hooks["chat.message"]!({ sessionID: "s1" } as any, output)

    const tools = output.message.tools as Record<string, boolean>
    expect(tools.github_create_issue).toBeUndefined() // routed: stays visible
    expect(tools.slack_slack_post_message).toBe(false) // unrouted: hidden
    expect(tools.slack_slack_get_users).toBe(true) // an explicit user choice is kept

    const ctx = { sessionID: "s1", ask: async () => {} } as any
    const found = await hooks.tool!.find_tools.execute({ query: "post a message to a channel" }, ctx)
    expect(found).toContain("slack_slack_post_message")
    const ran = await hooks.tool!.use_tool.execute({ name: "slack_slack_post_message", arguments: { channel_id: "C04ENG1", text: "hi" } }, ctx)
    expect(ran).not.toContain("Unknown tool")
  }, 30_000)

  it("hides nothing when routing fails", async () => {
    const hooks = await createToolRouter({ client: fakeClient }, {
      minTools: 1, transport: async () => { throw new Error("boom") },
    })
    await hooks.config!({ mcp: config } as any)
    const output = { message: { sessionID: "s2" } as any, parts: [{ type: "text", text: "anything" }] as any }
    await hooks["chat.message"]!({ sessionID: "s2" } as any, output)
    expect(output.message.tools).toBeUndefined()
  }, 30_000)
})

describe("regressions", () => {
  it("describes a large server by sampling across it, not by its first tools", async () => {
    // Sorted catalogs put all of Atlassian's confluence_* tools first; describing the server by
    // those alone sent every Jira request to Linear instead.
    const tools = [
      ...Array.from({ length: 60 }, (_, i) => tool("atlassian", `confluence_op_${i}`)),
      ...Array.from({ length: 40 }, (_, i) => tool("atlassian", `jira_op_${i}`)),
    ]
    let sent: any
    const r = new Router(tools, async (body) => {
      sent = body
      return fakeJev({ server: { atlassian: 1 }, uses: { atlassian: 1 } })(body)
    })
    await r.route("Move WEB-1234 to In Progress")
    const description = sent.questions.server.criteria.atlassian as string
    expect(description).toContain("100 tools")
    expect(description).toMatch(/jira_op_/)
    expect(description).toMatch(/confluence_op_/)
  })

  it("spreads the tool budget across servers", async () => {
    const tools = ["a", "b", "c"].flatMap((s) => [tool(s, "one"), tool(s, "two"), tool(s, "three")])
    const r = new Router(tools, fakeJev({
      server: { a: 0.5, b: 0.3, c: 0.2 },
      first: { a: "a_one", b: "b_one", c: "c_one" },
      action: { a: "a_two", b: "b_two", c: "c_two" },
      uses: { a: 0.9, b: 0.8, c: 0.7 },
    }), { maxTools: 3 })
    const route = await r.route("touch all three")
    expect(new Set(route.tools.map((t) => t.split("_")[0]))).toEqual(new Set(["a", "b", "c"]))
  })
})
