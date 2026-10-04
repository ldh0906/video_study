import OpenAI from "openai";
import type { ResponseCreateParamsStreaming, ResponseInputItem } from "openai/resources/responses/responses";
import { apiKey } from "../settings";
import { LLMError, type GenerateOptions, type GenerateResult } from "./index";

let client: OpenAI | null = null;
let clientKey = "";

export function openaiClient(): OpenAI {
  const key = apiKey("openai");
  if (!key) throw new LLMError("OpenAI API 키가 설정되지 않았습니다. 설정에서 키를 입력해 주세요.", "auth");
  if (!client || clientKey !== key) {
    client = new OpenAI({ apiKey: key, maxRetries: 4, timeout: 20 * 60 * 1000 });
    clientKey = key;
  }
  return client;
}

export async function openaiGenerate(opts: GenerateOptions): Promise<GenerateResult> {
  const openai = openaiClient();
  const input: ResponseInputItem[] = opts.messages.map((m) => {
    if (m.role === "assistant") return { role: "assistant", content: m.content };
    const parts: Array<
      { type: "input_text"; text: string } | { type: "input_image"; image_url: string; detail: "auto" }
    > = [];
    for (const img of m.images ?? []) {
      if (img.caption) parts.push({ type: "input_text", text: img.caption });
      parts.push({ type: "input_image", image_url: `data:${img.mime};base64,${img.data}`, detail: "auto" });
    }
    parts.push({ type: "input_text", text: m.content });
    return { role: "user", content: parts };
  });

  const params: ResponseCreateParamsStreaming = {
    model: opts.choice.model,
    instructions: opts.system,
    input,
    stream: true,
    store: false,
    max_output_tokens: Math.round(opts.maxTokens ?? 32000),
  };
  const effort = opts.choice.effort;
  if (effort && effort !== "default") params.reasoning = { effort: effort as OpenAI.ReasoningEffort };
  if (opts.jsonSchema) {
    params.text = {
      format: { type: "json_schema", name: opts.jsonSchema.name, schema: opts.jsonSchema.schema, strict: true },
    };
  }

  try {
    const stream = openai.responses.stream(params, { signal: opts.signal });
    if (opts.onDelta) stream.on("response.output_text.delta", (e) => opts.onDelta!(e.delta));
    const res = await stream.finalResponse();
    const truncated = res.status === "incomplete" && res.incomplete_details?.reason === "max_output_tokens";
    if (res.status === "incomplete" && res.incomplete_details?.reason === "content_filter") {
      throw new LLMError("OpenAI 콘텐츠 필터에 의해 응답이 중단되었습니다.", "refusal");
    }
    const refusal = res.output
      .flatMap((o) => (o.type === "message" ? o.content : []))
      .find((c) => c.type === "refusal");
    if (refusal && refusal.type === "refusal") throw new LLMError(`모델이 응답을 거부했습니다: ${refusal.refusal}`, "refusal");
    return {
      text: res.output_text,
      truncated,
      usage: { input: res.usage?.input_tokens ?? 0, output: res.usage?.output_tokens ?? 0 },
    };
  } catch (err) {
    if (err instanceof OpenAI.AuthenticationError) throw new LLMError("OpenAI API 키가 유효하지 않습니다.", "auth");
    if (err instanceof OpenAI.APIError && err.status === 400) {
      const e = new LLMError(`OpenAI 요청 오류: ${err.message}`);
      (e as unknown as { status: number }).status = 400;
      throw e;
    }
    throw err;
  }
}

export async function listOpenAIModels(): Promise<string[]> {
  const openai = openaiClient();
  const ids: string[] = [];
  for await (const m of openai.models.list()) ids.push(m.id);
  return ids
    .filter((id) => /^(gpt-[45]|o\d|chatgpt)/.test(id))
    .filter((id) => !/(transcribe|tts|audio|realtime|search|image|codex|embedding|whisper|-\d{4}-\d{2}-\d{2}$)/.test(id))
    .sort()
    .reverse();
}
