// Minimal client for TypeSafe's System One API.

export const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone"

export type ChoiceAnswer = { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
export type NoulAnswer = { type: "noul"; noul: number }
export type SystemOneResponse = {
  model: string
  answers: Record<string, ChoiceAnswer | NoulAnswer>
  usage?: { input_tokens: number; output_tokens: number }
}
export type Transport = (body: unknown, signal: AbortSignal) => Promise<SystemOneResponse>

export class TypeSafeError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
  }
}

export function httpTransport(apiKey: string, endpoint = DEFAULT_ENDPOINT, maxRetries = 3): Transport {
  return async (body, signal) => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      })
      if (res.ok) return (await res.json()) as SystemOneResponse
      if ((res.status === 429 || res.status === 529) && attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt))
        continue
      }
      throw new TypeSafeError(`TypeSafe API returned ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status)
    }
  }
}
