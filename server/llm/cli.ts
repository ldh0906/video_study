import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA_DIR } from "../paths";
import type { ModelOption, ToolInfo } from "../../shared/types";
import { LLMError, type GenerateOptions, type GenerateResult, type LLMMessage } from "./index";

/**
 * Runs the locally installed Claude Code CLI (`claude`) or Codex CLI (`codex`)
 * so requests use the account the user is signed into — no API key needed.
 */

const WORK_DIR = path.join(DATA_DIR, "tmp", "cli");
fs.mkdirSync(WORK_DIR, { recursive: true });

const CLAUDE_BIN = process.env.CLAUDE_CLI_PATH || "claude";
const CODEX_BIN = process.env.CODEX_CLI_PATH || "codex";

/** Child env without API keys, so the CLIs use the signed-in account rather than a stray key. */
function childEnv(drop: string[]) {
  const env = { ...process.env };
  for (const k of drop) delete env[k];
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}

interface Proc {
  code: number;
  stderr: string;
}

function runCli(
  bin: string,
  args: string[],
  stdin: string,
  env: NodeJS.ProcessEnv,
  onLine: (line: string) => void,
  signal?: AbortSignal,
): Promise<Proc> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: WORK_DIR, env, windowsHide: true });
    let stderr = "";
    let partial = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      partial += d;
      const lines = partial.split(/\r?\n/);
      partial = lines.pop() ?? "";
      for (const l of lines) if (l.trim()) onLine(l);
    });
    child.stderr.on("data", (d: string) => {
      if (stderr.length < 100_000) stderr += d;
    });
    const onAbort = () => child.kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err: NodeJS.ErrnoException) => {
      signal?.removeEventListener("abort", onAbort);
      if (err.code === "ENOENT") reject(new LLMError(`${bin} CLI를 찾을 수 없습니다. 설치 후 로그인해 주세요.`, "auth"));
      else reject(err);
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (partial.trim()) onLine(partial);
      if (signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
      resolve({ code: code ?? -1, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}

/** CLIs take one prompt, so earlier turns are folded into the final user message. */
function flatten(messages: LLMMessage[]): string {
  if (messages.length === 1) return messages[0].content;
  const history = messages
    .slice(0, -1)
    .map((m) => `<${m.role}>\n${m.content}\n</${m.role}>`)
    .join("\n\n");
  return `<conversation_so_far>\n${history}\n</conversation_so_far>\n\n${messages.at(-1)!.content}`;
}

function tempFile(ext: string, content: string | Buffer) {
  const file = path.join(WORK_DIR, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  fs.writeFileSync(file, content);
  return file;
}

// ---------------------------------------------------------------------------
// Claude Code CLI
// ---------------------------------------------------------------------------

export async function claudeCliGenerate(opts: GenerateOptions): Promise<GenerateResult> {
  const sysFile = tempFile(".txt", opts.system);
  const last = opts.messages.at(-1)!;
  const content: unknown[] = [];
  for (const img of last.images ?? []) {
    if (img.caption) content.push({ type: "text", text: img.caption });
    content.push({ type: "image", source: { type: "base64", media_type: img.mime, data: img.data } });
  }
  content.push({ type: "text", text: flatten(opts.messages) });
  const input = `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`;

  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--tools",
    "",
    "--model",
    opts.choice.model,
    "--no-session-persistence",
    "--safe-mode",
    "--system-prompt-file",
    sysFile,
  ];
  const effort = opts.choice.effort;
  if (effort && !["default", "none", "minimal"].includes(effort)) args.push("--effort", effort);
  if (opts.jsonSchema) args.push("--json-schema", JSON.stringify(opts.jsonSchema.schema));

  let result: Record<string, unknown> | null = null;
  let streamed = "";
  try {
    const proc = await runCli(
      CLAUDE_BIN,
      args,
      input,
      childEnv(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]),
      (line) => {
        let msg: Record<string, any>;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (msg.type === "stream_event") {
          const ev = msg.event;
          if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
            streamed += ev.delta.text;
            opts.onDelta?.(ev.delta.text);
          }
        } else if (msg.type === "result") {
          result = msg;
        }
      },
      opts.signal,
    );
    const r = result as Record<string, any> | null;
    if (!r) {
      const hint = proc.stderr.trim().split(/\r?\n/).slice(-3).join(" ");
      throw new LLMError(`Claude CLI가 응답 없이 종료되었습니다 (code ${proc.code}). ${hint || "`claude`로 로그인되어 있는지 확인해 주세요."}`);
    }
    if (r.is_error) {
      const text = String(r.result ?? r.subtype ?? "알 수 없는 오류");
      const kind = /login|auth|credential|api key/i.test(text) ? "auth" : /refus|declin/i.test(text) ? "refusal" : "other";
      throw new LLMError(`Claude CLI 오류: ${text}`, kind);
    }
    const u = r.usage ?? {};
    const text = opts.jsonSchema && r.structured_output !== undefined ? JSON.stringify(r.structured_output) : String(r.result ?? streamed);
    return {
      text,
      truncated: r.stop_reason === "max_tokens",
      usage: {
        input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        output: u.output_tokens ?? 0,
      },
    };
  } finally {
    fs.rmSync(sysFile, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Codex CLI
// ---------------------------------------------------------------------------

export async function codexCliGenerate(opts: GenerateOptions): Promise<GenerateResult> {
  const last = opts.messages.at(-1)!;
  const images = (last.images ?? []).map((img) => tempFile(img.mime === "image/png" ? ".png" : ".jpg", Buffer.from(img.data, "base64")));
  const captions = (last.images ?? []).map((img, i) => `Image ${i + 1}: ${img.caption ?? ""}`).join("\n");
  const schemaFile = opts.jsonSchema ? tempFile(".json", JSON.stringify(opts.jsonSchema.schema)) : null;
  const outFile = path.join(WORK_DIR, `${Date.now()}-${Math.random().toString(36).slice(2)}.out.txt`);

  const prompt = [
    `<instructions>\n${opts.system}\n</instructions>`,
    "Answer directly from the material in this message. Do not run shell commands, read files or browse; no tools are needed.",
    images.length ? `The attached images, in order:\n${captions}` : "",
    flatten(opts.messages),
  ]
    .filter(Boolean)
    .join("\n\n");

  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "--sandbox",
    "read-only",
    "-m",
    opts.choice.model,
    "-o",
    outFile,
  ];
  const effort = opts.choice.effort;
  if (effort && effort !== "default") args.push("-c", `model_reasoning_effort="${effort}"`);
  if (schemaFile) args.push("--output-schema", schemaFile);
  for (const img of images) args.push("-i", img);
  args.push("-");

  let text = "";
  let usage = { input: 0, output: 0 };
  let failure = "";
  try {
    const proc = await runCli(
      CODEX_BIN,
      args,
      prompt,
      childEnv(["OPENAI_API_KEY"]),
      (line) => {
        let ev: Record<string, any>;
        try {
          ev = JSON.parse(line);
        } catch {
          return;
        }
        if (ev.type === "item.completed" && ev.item?.type === "agent_message") {
          const t = String(ev.item.text ?? "");
          if (!opts.jsonSchema && t) opts.onDelta?.(text ? `\n\n${t}` : t);
          text = text && !opts.jsonSchema ? `${text}\n\n${t}` : t;
        } else if (ev.type === "turn.completed" && ev.usage) {
          usage = { input: ev.usage.input_tokens ?? 0, output: (ev.usage.output_tokens ?? 0) + (ev.usage.reasoning_output_tokens ?? 0) };
        } else if (ev.type === "turn.failed" || ev.type === "error") {
          failure = String(ev.error?.message ?? ev.message ?? "알 수 없는 오류");
        }
      },
      opts.signal,
    );
    if (fs.existsSync(outFile)) {
      const final = fs.readFileSync(outFile, "utf8").trim();
      if (final) text = opts.jsonSchema ? final : text || final;
    }
    if (failure && !text) {
      const kind = /login|auth|401|unauthorized/i.test(failure) ? "auth" : "other";
      throw new LLMError(`Codex CLI 오류: ${failure}`, kind);
    }
    if (!text) {
      const hint = proc.stderr.trim().split(/\r?\n/).filter((l) => !/rmcp::transport/.test(l)).slice(-3).join(" ");
      throw new LLMError(`Codex CLI가 응답 없이 종료되었습니다 (code ${proc.code}). ${hint || "`codex login`으로 로그인되어 있는지 확인해 주세요."}`);
    }
    return { text, truncated: false, usage };
  } finally {
    for (const f of [...images, schemaFile, outFile]) if (f) fs.rmSync(f, { force: true });
  }
}

// ---------------------------------------------------------------------------
// discovery
// ---------------------------------------------------------------------------

function version(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(bin, ["--version"], { windowsHide: true });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? out.trim().split(/\r?\n/)[0] : null));
  });
}

export async function cliStatus(): Promise<{ claude: ToolInfo; codex: ToolInfo }> {
  const [c, x] = await Promise.all([version(CLAUDE_BIN), version(CODEX_BIN)]);
  return {
    claude: { ok: Boolean(c), path: c ? CLAUDE_BIN : null, version: c ?? undefined },
    codex: { ok: Boolean(x), path: x ? CODEX_BIN : null, version: x ?? undefined },
  };
}

/** Models the signed-in Codex account can use, from the CLI's own model cache. */
export function codexModels(): ModelOption[] {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  try {
    const data = JSON.parse(fs.readFileSync(path.join(home, "models_cache.json"), "utf8"));
    const models: any[] = Array.isArray(data) ? data : (data.models ?? []);
    return models
      .filter((m) => m.slug && m.visibility !== "hide")
      .map((m) => ({
        id: m.slug,
        label: m.display_name ?? m.slug,
        blurb: m.description ?? undefined,
        efforts: (m.supported_reasoning_levels ?? []).map((x: any) => x.effort).filter(Boolean),
        defaultEffort: m.default_reasoning_level ?? "medium",
      }));
  } catch {
    return [];
  }
}
