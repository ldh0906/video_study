import { z } from "zod";
import type { ModelChoice } from "../../shared/types";
import { getSettings } from "../settings";
import { anthropicGenerate } from "./anthropic";
import { claudeCliGenerate, codexCliGenerate } from "./cli";
import { openaiGenerate } from "./openai";

export interface LLMImage {
  mime: "image/jpeg" | "image/png";
  data: string; // base64
  caption?: string;
}

export interface LLMMessage {
  role: "user" | "assistant";
  content: string;
  images?: LLMImage[];
}

export interface LLMUsage {
  input: number;
  output: number;
}

export interface GenerateOptions {
  choice: ModelChoice;
  system: string;
  messages: LLMMessage[];
  maxTokens?: number;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  /** mark the system prompt as cacheable (Anthropic prompt caching; OpenAI caches automatically) */
  cacheSystem?: boolean;
  /** JSON schema for structured output */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
}

export interface GenerateResult {
  text: string;
  usage: LLMUsage;
  truncated: boolean;
}

export class LLMError extends Error {
  constructor(
    message: string,
    readonly kind: "auth" | "refusal" | "truncated" | "schema" | "other" = "other",
  ) {
    super(message);
  }
}

export function generateText(opts: GenerateOptions): Promise<GenerateResult> {
  const viaCli = getSettings().connection[opts.choice.provider] === "cli";
  if (opts.choice.provider === "openai") return viaCli ? codexCliGenerate(opts) : openaiGenerate(opts);
  return viaCli ? claudeCliGenerate(opts) : anthropicGenerate(opts);
}

/**
 * Convert a zod schema to the JSON-schema subset both providers accept for
 * strict structured output: every property required, no extra properties, and
 * no numeric/length constraints.
 */
export function strictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  const DROP = new Set(["$schema", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "minItems", "maxItems", "pattern", "format", "default"]);
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (DROP.has(k)) continue;
      out[k] = k === "properties" ? Object.fromEntries(Object.entries(v as object).map(([pk, pv]) => [pk, walk(pv)])) : walk(v);
    }
    if (out.type === "object" && out.properties) {
      out.required = Object.keys(out.properties as object);
      out.additionalProperties = false;
    }
    return out;
  };
  return walk(raw) as Record<string, unknown>;
}

/** Pull the first JSON object out of a model reply (used when native structured output isn't available). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end < start) throw new LLMError("모델 응답에서 JSON을 찾지 못했습니다.", "schema");
  return JSON.parse(body.slice(start, end + 1));
}

export async function generateObject<S extends z.ZodType>(
  opts: Omit<GenerateOptions, "jsonSchema" | "onDelta"> & { schema: S; name: string },
): Promise<{ object: z.infer<S>; usage: LLMUsage }> {
  const jsonSchema = { name: opts.name, schema: strictJsonSchema(opts.schema) };
  const usage: LLMUsage = { input: 0, output: 0 };
  const add = (u: LLMUsage) => {
    usage.input += u.input;
    usage.output += u.output;
  };

  let native = true;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await generateText({
        ...opts,
        jsonSchema: native ? jsonSchema : undefined,
        system: native
          ? opts.system
          : `${opts.system}\n\nRespond with a single JSON object (no prose, no code fences) that matches this JSON schema:\n${JSON.stringify(jsonSchema.schema)}`,
        maxTokens: (opts.maxTokens ?? 32000) * (attempt > 0 ? 1.5 : 1),
      });
      add(res.usage);
      if (res.truncated) throw new LLMError("응답이 최대 토큰 한도에서 잘렸습니다.", "truncated");
      const parsed = opts.schema.safeParse(native ? JSON.parse(res.text) : extractJson(res.text));
      if (!parsed.success) throw new LLMError(`응답 형식 오류: ${parsed.error.message.slice(0, 300)}`, "schema");
      return { object: parsed.data, usage };
    } catch (err) {
      lastError = err;
      if (opts.signal?.aborted) throw err;
      if (err instanceof LLMError && (err.kind === "auth" || err.kind === "refusal")) throw err;
      // Some models/accounts reject structured output; fall back to prompt-and-parse.
      if (native && isSchemaRejection(err)) native = false;
      else if (!(err instanceof LLMError) && !(err instanceof SyntaxError)) throw err;
    }
  }
  throw lastError;
}

function isSchemaRejection(err: unknown) {
  const status = (err as { status?: number }).status;
  const msg = String((err as Error).message ?? "");
  return status === 400 && /schema|format|output_config|json/i.test(msg);
}
