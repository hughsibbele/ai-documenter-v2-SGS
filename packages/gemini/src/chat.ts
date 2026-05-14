// Minimal Gemini chat wrapper. Uses the v1beta REST endpoint directly so we
// don't pull in the SDK (matches v1's pattern in Gemini.gs and keeps the
// dependency surface small). Server-side use only — caller must keep the
// API key off the client.

const ENDPOINT_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export type GeminiMessage = {
  role: "user" | "model";
  text: string;
};

export type GeminiChatOptions = {
  apiKey: string;
  /** Defaults to gemini-3-flash. */
  model?: string;
  /** System instruction (separate from the message turns). */
  systemPrompt?: string;
  /** Conversation turns, oldest-first. The last turn is typically `user`. */
  messages: GeminiMessage[];
  /** When set, Gemini will fetch URL-context grounding for any URLs it finds in the prompt. */
  urlContext?: boolean;
  /** 0–1, default 0.4. Reflection coaching wants steady-not-floppy temperature. */
  temperature?: number;
  /** Default 4096 — long enough for a Socratic question, short enough to stay responsive. */
  maxOutputTokens?: number;
  /** Per Gemini 2.5+/3+: 'low' | 'medium' | 'high' | 'off'. Default 'off'. */
  thinkingLevel?: "off" | "low" | "medium" | "high";
};

export type GeminiChatResult = {
  text: string;
  /** Sources Gemini used via url-context grounding, when present. */
  citedUrls: string[];
};

export class GeminiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "GeminiError";
    this.status = status;
  }
}

export async function chatWithGemini(
  opts: GeminiChatOptions,
): Promise<GeminiChatResult> {
  if (!opts.apiKey) {
    throw new GeminiError("GEMINI_API_KEY is not configured", 0);
  }

  const model = opts.model ?? "gemini-3-flash-preview";
  const url = `${ENDPOINT_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(opts.apiKey)}`;

  const generationConfig: Record<string, unknown> = {
    temperature: opts.temperature ?? 0.4,
    maxOutputTokens: opts.maxOutputTokens ?? 4096,
  };
  if (opts.thinkingLevel && opts.thinkingLevel !== "off") {
    generationConfig.thinkingConfig = { thinkingLevel: opts.thinkingLevel };
  }

  const body: Record<string, unknown> = {
    contents: opts.messages.map((m) => ({
      role: m.role,
      parts: [{ text: m.text }],
    })),
    generationConfig,
  };
  if (opts.systemPrompt) {
    body.systemInstruction = { parts: [{ text: opts.systemPrompt }] };
  }
  if (opts.urlContext) {
    // Snake-case key per the v1beta REST contract; camelCase is silently
    // ignored, which makes Gemini answer without ever fetching the URLs.
    body.tools = [{ url_context: {} }];
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await safeText(res);
    throw new GeminiError(
      `Gemini API ${res.status}: ${text.slice(0, 300)}`,
      res.status,
    );
  }

  const json = (await res.json()) as GeminiResponse;
  const candidate = json.candidates?.[0];
  if (!candidate) {
    throw new GeminiError("Gemini returned no candidates", 502);
  }

  // Filter out thinking parts; concat text parts.
  const text = (candidate.content?.parts ?? [])
    .filter((p) => !p.thought)
    .map((p) => p.text ?? "")
    .join("");

  const citedUrls = extractCitedUrls(candidate);
  return { text, citedUrls };
}

// ---------------------------------------------------------------------------

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string; thought?: boolean }>;
    };
    groundingMetadata?: {
      groundingChunks?: Array<{ web?: { uri?: string } }>;
    };
    urlContextMetadata?: {
      urlMetadata?: Array<{ retrievedUrl?: string }>;
    };
  }>;
};

function extractCitedUrls(candidate: NonNullable<GeminiResponse["candidates"]>[number]): string[] {
  const urls = new Set<string>();
  for (const c of candidate.groundingMetadata?.groundingChunks ?? []) {
    if (c.web?.uri) urls.add(c.web.uri);
  }
  for (const u of candidate.urlContextMetadata?.urlMetadata ?? []) {
    if (u.retrievedUrl) urls.add(u.retrievedUrl);
  }
  return [...urls];
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "(no body)";
  }
}
