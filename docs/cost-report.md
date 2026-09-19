# Token and cost report

This report shows how many input tokens the plugin saves, and what that is worth in money.
It explains how each number was produced, so you can check it or run it again.
The last section shows how to use the plugin in opencode.

## Summary

- Without the plugin, opencode sends about **90,200 tokens** of MCP tool schemas on every model call.
- With the plugin, it sends about **7,300 tokens**. That saves about **82,900 tokens per model call (-92%)**.
- **Without prompt caching**, this saves about $0.41 per model call on Claude Opus 5.
- **With prompt caching**, this saves about $0.03-$0.17 per user message on short conversations.
  On long conversations, the plugin can cost more. See [Prompt caching changes the picture](#prompt-caching-changes-the-picture).
- These numbers do not include the price of the routing call to TypeSafe.

## 1. How the token numbers were measured

### Setup

The benchmark is `bench/opencode_e2e.py`. It runs real opencode (1.18.31) in two modes, `all` and `routed`.

| Part | What it is |
|---|---|
| MCP servers | 18 mock servers (`bench/mcp/mock_server.py`). They serve 296 real tool schemas copied from common MCP servers, such as GitHub, Slack, Linear, Notion, Playwright and Supabase (`bench/mcp/schemas/`). |
| Model | A mock OpenAI-compatible server (`bench/mock_llm.py`). It records every request that opencode sends. It answers at once and does not call tools. |
| Prompts | 72 labeled prompts (`bench/prompts.json`). For 70 of them, the label says which tool the task needs. |
| Modes | `all` is opencode alone. `routed` is opencode with this plugin (`minTools: 30`, all other options at their defaults). |

### What was counted

For each run, `mock_llm.py` stores the `tools` array of each request. It measures its size as
`len(json.dumps(tools))` characters. The benchmark takes the first request that has tools; that is the main agent call.
opencode also makes a second request that generates the session title, without tools, which is ignored.

Tokens are estimated as **characters / 4**. This is an approximation, not a real tokenizer count.
Real counts can differ by roughly 10-30%, depending on the model's tokenizer.

### Results

Source: `bench/results/opencode_e2e.json` (144 runs: 72 prompts x 2 modes).

| | `all` (opencode alone) | `routed` (with plugin) |
|---|---|---|
| Tools sent to the model (mean) | 306 | 17.7 |
| Tool schema characters (mean) | 360,736 | 29,185 (min 22,204, max 41,180) |
| Tool schema tokens (chars / 4) | ~90,200 | ~7,300 |
| Needed tool was sent | 70/70 | 69/70 |
| Median wall time per run | 1.8 s | 3.5 s |

**Saved per model call:** 360,736 - 29,185 = 331,551 characters, which is about **82,900 tokens (-92%)**.

opencode sends the tool list with every model call in a user message, not only the first one.
So a user message that takes 5 steps saves about 5 x 82,900 = 414,000 input tokens.

The 306 tools in `all` mode are the 296 MCP tools plus opencode's built-in tools.
The plugin never hides built-in tools.

The one miss was prompt "Is WEB-1234 going to breach its SLA?". The router picked other Jira tools but not
`jira_get_issue_sla`. In that case the model can still find the tool with `find_tools` and run it with `use_tool`.

## 2. How the tokens turn into money

Prices are Anthropic list prices per million input tokens:
Fable 5.1 $10, Opus 5 $5, Sonnet 5 $2, Haiku 4.5 $1.
Other providers charge different prices; the same method applies.

### Without prompt caching

Every call pays the full input price for the tool schemas. This is the best case for the plugin.
It fits providers or setups that do not cache prompts.

Saved per call = 82,900 tokens x price.

| Model | $ / 1M input | Saved per model call | Saved per 1,000 model calls |
|---|---|---|---|
| Fable 5.1 | $10 | $0.83 | $829 |
| Opus 5 | $5 | $0.41 | $414 |
| Sonnet 5 | $2 | $0.17 | $166 |
| Haiku 4.5 | $1 | $0.08 | $83 |

### Prompt caching changes the picture

opencode uses prompt caching with Anthropic models. A cache read costs about 0.1x the input price.
A cache write costs about 1.25x (5-minute cache).

- **Without the plugin**, the 90,200 tokens of tool schemas never change. After the first call, almost every call
  reads them from cache at 0.1x.
- **With the plugin**, the tool list can change on each new user message. When it changes, the next call must
  write the cache again at 1.25x. Later steps in the same user message read from cache.

Example: one user message that takes 5 model calls. Cost is shown in token-equivalents
(tokens x price multiplier), then in dollars.

| | Calculation | Token-equivalents | Opus 5 | Sonnet 5 | Haiku 4.5 |
|---|---|---|---|---|---|
| Without plugin | 5 reads x 90,200 x 0.1 | ~45,100 | $0.225 | $0.090 | $0.045 |
| With plugin | 1 write x 7,300 x 1.25 + 4 reads x 7,300 x 0.1 | ~12,000 | $0.060 | $0.024 | $0.012 |
| **Saved on tool schemas** | | ~33,000 | **$0.165** | **$0.066** | **$0.033** |

(Fable 5.1 is left out of this table because its cache read price is not 0.1x its input price.)

### The hidden cost: the conversation history cache

Tools come first in the prompt, before the system prompt and the message history.
A cache only matches from the start of the prompt. So when the tool list changes, the cache for the
**whole conversation history** is lost too. The history is then written again at 1.25x, instead of read at 0.1x.
That costs an extra 1.15 x (history tokens) per user message.

With 5 calls per user message, this extra cost equals the 33,000 token-equivalents saved above
when the history reaches about **33,000 / 1.15 = ~29,000 tokens**.
Past that point, a user message that changes the tool list costs more with the plugin than without it.

This only happens when the tool list is different from the previous user message.
If two user messages in a row pick the same tools, the cache still matches.
How often the tool list changes in real conversations has **not been measured yet**.

## 3. What these numbers do not include

- **The routing call.** The plugin calls TypeSafe's Jev once per user message. Its price is not in this report.
  Subtract it from the savings.
- **Latency.** Routing adds about 1 second per user message.
- **Task quality.** The mock model does not use tools. The benchmark measures what reaches the model,
  not whether a real model finishes the task. When the router misses a tool, the model needs extra
  `find_tools` and `use_tool` steps, and those steps cost tokens.
- **Real tokenizer counts.** All token numbers are characters / 4.

## 4. Benefits that are not about money

- **Fit.** 90,200 tokens of tool schemas do not fit in models with small context windows. With the plugin, they fit.
- **Room.** Each call has about 83,000 more tokens free for your code and conversation.

## 5. When the plugin saves money

| Your setup | Expected result |
|---|---|
| Provider without prompt caching, many MCP tools | Large savings on every model call |
| Prompt caching, short conversations | Small savings per user message |
| Prompt caching, long conversations where the needed tools change often | Can cost more than opencode alone |
| Fewer than 30 MCP tools | The plugin does nothing (`minTools`) |

## 6. How to use the plugin in opencode

### Install

```bash
git clone <this repo> && cd opencode-toolrouter
npm install && npm run build
export TYPESAFE_API_KEY=...   # https://console.typesafe.ai/settings/keys
```

### Configure

Add the plugin to your `opencode.json`. Use an absolute path to the build:

```json
{
  "plugin": [
    ["/absolute/path/to/opencode-toolrouter/dist/index.js", { "alwaysLoad": ["github"] }]
  ]
}
```

Your MCP servers stay in the `mcp` section as before. The plugin reads that section at startup.

### Use

Start opencode as usual. You do not need to change how you write requests.

1. At startup, the plugin lists the tools of each enabled MCP server. It caches the list in
   `~/.cache/opencode-toolrouter/`.
2. For each new user message, it asks Jev which MCP tools the request needs, and hides the others.
3. If the model needs a hidden tool, it calls `find_tools` to search for it, then `use_tool` to run it.
   `use_tool` asks permission under the real tool's name, so your permission rules still apply.
4. If routing fails or takes longer than `timeoutMs`, nothing is hidden.

### Tips

- Put stateful servers, such as a browser session, in `alwaysLoad`. `use_tool` runs a second copy of the server,
  and that copy does not share state with opencode's copy.
- Put servers you use in almost every message in `alwaysLoad`. This keeps the tool list more stable, which
  helps prompt caching.
- If you add or change MCP servers, set `refreshCatalog: true` once to list their tools again.
- All options are listed in the [README](../README.md#options).

## 7. Reproduce the numbers

```bash
npm install && npm run build
export TYPESAFE_API_KEY=...
python3 bench/opencode_e2e.py --prompts <comma-separated ids from bench/prompts.json>
```

The script prints one line per run and the mean for each mode. It writes all runs to
`bench/results/opencode_e2e.json`. It does not call a paid model; only the routing call uses your TypeSafe key.

To recompute the summary table from the results file:

```bash
python3 -c "
import json, statistics as st
r = json.load(open('bench/results/opencode_e2e.json'))
for m in ('all', 'routed'):
    x = [a for a in r if a['mode'] == m and a['requests']]
    c = st.mean(a['tools_chars'] for a in x)
    print(m, 'tools', round(st.mean(a['n_tools'] for a in x), 1), 'chars', round(c), 'tokens~', round(c / 4))
"
```
