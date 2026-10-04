import Anthropic from "@anthropic-ai/sdk";
import { apiKey } from "../settings";
import { LLMError, type GenerateOptions, type GenerateResult } from "./index";

let client: Anthropic | null = null;
let clientKey = "";

function anthropicClient(): Anthropic {
  const key = apiKey("anthropic");
  if (!key) throw new LLMError("Anthropic API 키가 설정되지 않았습니다. 설정에서 키를 입력해 주세요.", "auth");
  if (!client || clientKey !== key) {
    client = new Anthropic({ apiKey: key, maxRetries: 4, timeout: 20 * 60 * 1000 });
    clientKey = key;
  }
  return client;
}

/** Models whose thinking is controlled with a token budget instead of adaptive thinking + effort. */
const BUDGET_THINKING = /haiku-4-5|sonnet-4-5|opus-4-5|opus-4-1|claude-3/;
/** Models that accept server-side refusal fallbacks ("default" routing). */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-1"]);
const BUDGETS: Record<string, number> = { low: 2048, medium: 6000, high: 16000 };

export async function anthropicGenerate(opts: GenerateOptions): Promise<GenerateResult> {
  const anthropic = anthropicClient();
  const { model, effort } = opts.choice;
  let maxTokens = Math.round(opts.maxTokens ?? 32000);

  const messages: Anthropic.Beta.BetaMessageParam[] = opts.messages.map((m) => {
    if (m.role === "assistant") return { role: "assistant", content: m.content };
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    for (const img of m.images ?? []) {
      if (img.caption) content.push({ type: "text", text: img.caption });
      content.push({ type: "image", source: { type: "base64", media_type: img.mime, data: img.data } });
    }
    content.push({ type: "text", text: m.content });
    return { role: "user", content };
  });

  const params: Anthropic.Beta.MessageCreateParamsStreaming = {
    model,
    max_tokens: maxTokens,
    stream: true,
    system: [
      {
        type: "text",
        text: opts.system,
        ...(opts.cacheSystem ? { cache_control: { type: "ephemeral" as const } } : {}),
      },
    ],
    messages,
  };

  const outputConfig: Anthropic.Beta.BetaOutputConfig = {};
  if (BUDGET_THINKING.test(model)) {
    const budget = BUDGETS[effort];
    if (budget) {
      params.thinking = { type: "enabled", budget_tokens: budget };
      params.max_tokens = maxTokens = Math.min(64000, maxTokens + budget);
    }
  } else {
    params.thinking = { type: "adaptive" };
    if (effort && effort !== "default" && effort !== "none") {
      outputConfig.effort = effort as Anthropic.Beta.BetaOutputConfig["effort"];
    }
  }
  if (opts.jsonSchema) outputConfig.format = { type: "json_schema", schema: opts.jsonSchema.schema };
  if (Object.keys(outputConfig).length) params.output_config = outputConfig;
  if (FALLBACK_MODELS.has(model)) {
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }

  try {
    const stream = anthropic.beta.messages.stream(params, { signal: opts.signal });
    if (opts.onDelta) stream.on("text", (delta) => opts.onDelta!(delta));
    const msg = await stream.finalMessage();
    if (msg.stop_reason === "refusal") {
      const why = msg.stop_details?.explanation ?? msg.stop_details?.category ?? "";
      throw new LLMError(`Claude가 이 요청을 거절했습니다${why ? `: ${why}` : ""}. 다른 모델로 시도해 보세요.`, "refusal");
    }
    const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    const u = msg.usage;
    return {
      text,
      truncated: msg.stop_reason === "max_tokens",
      usage: {
        input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        output: u.output_tokens ?? 0,
      },
    };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new LLMError("Anthropic API 키가 유효하지 않습니다.", "auth");
    if (err instanceof Anthropic.BadRequestError) {
      const e = new LLMError(`Claude 요청 오류: ${err.message}`);
      (e as unknown as { status: number }).status = 400;
      throw e;
    }
    throw err;
  }
}

export async function listAnthropicModels(): Promise<string[]> {
  const anthropic = anthropicClient();
  const ids: string[] = [];
  for await (const m of anthropic.models.list()) ids.push(m.id);
  return ids;
}
