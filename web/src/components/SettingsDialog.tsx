import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AudioLines, Bot, CheckCircle2, Download, Eye, KeyRound, Plug, TerminalSquare, Wrench, XCircle } from "lucide-react";
import { toast } from "sonner";
import { OUTPUT_LANGUAGES, TRANSCRIPTION_MODELS } from "@shared/catalog";
import type { Connection, Provider, PublicSettings, Settings, ToolInfo, WhisperModel } from "@shared/types";
import { api, type SettingsPatch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ModelPicker } from "./ModelPicker";
import { Badge, Button, Dialog, Input, Label, Progress, Segmented, Switch } from "./ui";

const WHISPER_MODELS: { id: WhisperModel; label: string; size: string; blurb: string }[] = [
  { id: "large-v3-turbo-q5_0", label: "Large v3 Turbo", size: "547MB", blurb: "가장 정확함 · 한국어·전문용어에 추천" },
  { id: "medium-q5_0", label: "Medium", size: "514MB", blurb: "정확도와 속도의 균형" },
  { id: "small-q5_1", label: "Small", size: "181MB", blurb: "빠름 · 영어 강의에 적당" },
  { id: "base-q5_1", label: "Base", size: "57MB", blurb: "매우 빠름 · 정확도 낮음" },
];

type Section = "models" | "connection" | "transcription" | "processing" | "tools";

const NAV: { id: Section; label: string; icon: ReactNode }[] = [
  { id: "models", label: "AI 모델", icon: <Bot /> },
  { id: "connection", label: "연결 방식", icon: <Plug /> },
  { id: "transcription", label: "받아쓰기", icon: <AudioLines /> },
  { id: "processing", label: "분석 옵션", icon: <Eye /> },
  { id: "tools", label: "도구", icon: <Wrench /> },
];

export function useSettings() {
  return useQuery({ queryKey: ["settings"], queryFn: api.settings });
}

export function SettingsDialog({ open, onOpenChange, initial = "models" }: { open: boolean; onOpenChange: (v: boolean) => void; initial?: Section }) {
  const [section, setSection] = useState<Section>(initial);
  useEffect(() => {
    if (open) setSection(initial);
  }, [open, initial]);
  const { data: s } = useSettings();
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: api.saveSettings,
    onSuccess: (next) => {
      qc.setQueryData(["settings"], next);
      qc.invalidateQueries({ queryKey: ["models"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const set = (patch: Partial<Settings>) => {
    if (s) qc.setQueryData<PublicSettings>(["settings"], { ...s, ...patch });
    save.mutate(patch);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="설정" description="모든 변경은 바로 저장됩니다." className="max-w-[860px]">
      {!s ? null : (
        <div className="flex flex-col gap-6 md:flex-row">
          <nav className="flex shrink-0 gap-1 overflow-x-auto md:w-44 md:flex-col">
            {NAV.map((n) => (
              <button
                key={n.id}
                onClick={() => setSection(n.id)}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium whitespace-nowrap transition-colors [&>svg]:size-4",
                  section === n.id ? "bg-surface-2 text-text" : "text-muted hover:text-text",
                )}
              >
                {n.icon}
                {n.label}
              </button>
            ))}
          </nav>
          <div className="min-h-[420px] min-w-0 flex-1 space-y-7">
            {section === "models" && <ModelsSection s={s} set={set} />}
            {section === "connection" && <ConnectionSection s={s} set={set} save={(p) => save.mutateAsync(p)} />}
            {section === "transcription" && <TranscriptionSection s={s} set={set} />}
            {section === "processing" && <ProcessingSection s={s} set={set} />}
            {section === "tools" && <ToolsSection />}
          </div>
        </div>
      )}
    </Dialog>
  );
}

function Block({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <h3 className="text-[14px] font-semibold">{title}</h3>
      {description ? <p className="mt-0.5 mb-3 text-[12.5px] leading-relaxed text-muted">{description}</p> : <div className="mb-3" />}
      {children}
    </section>
  );
}

interface SectionProps {
  s: PublicSettings;
  set: (patch: Partial<Settings>) => void;
}

function ModelsSection({ s, set }: SectionProps) {
  return (
    <>
      <Block title="분석 모델" description="강의 노트, 개념 정리, 퀴즈, 학습 자료를 만듭니다. 어려운 강의일수록 강한 모델과 높은 추론 강도가 좋아요.">
        <ModelPicker value={s.analysis} onChange={(analysis) => set({ analysis })} />
      </Block>
      <Block title="대화 모델" description="질문 답변과 서술형 채점에 씁니다. 빠른 모델이 쾌적합니다.">
        <ModelPicker value={s.chat} onChange={(chat) => set({ chat })} />
      </Block>
      <Block title="학습 자료 언어">
        <Segmented value={s.outputLanguage} onChange={(outputLanguage) => set({ outputLanguage })} options={OUTPUT_LANGUAGES.map((l) => ({ value: l.id, label: l.label }))} />
      </Block>
    </>
  );
}

function ToolRow({ name, info, action }: { name: string; info?: ToolInfo; action?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border px-3.5 py-3">
      {info?.ok ? <CheckCircle2 className="size-[18px] shrink-0 text-success" /> : <XCircle className="size-[18px] shrink-0 text-faint" />}
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{name}</div>
        <div className="truncate text-xs text-muted">{info ? (info.ok ? info.version ?? info.path : "설치되지 않음") : "확인 중…"}</div>
      </div>
      {action}
    </div>
  );
}

function ConnectionSection({ s, set, save }: SectionProps & { save: (p: SettingsPatch) => Promise<unknown> }) {
  const tools = useQuery({ queryKey: ["tools"], queryFn: () => api.tools() });
  const row = (provider: Provider, title: string, cli: string, cliInfo?: ToolInfo) => {
    const conn = s.connection[provider];
    const key = s.keys[provider];
    return (
      <Block
        title={title}
        description={
          conn === "cli"
            ? `설치된 ${cli} CLI로 로그인된 내 계정(구독)을 사용합니다. API 키가 필요 없어요.`
            : "API 키로 직접 호출합니다. 사용량만큼 API 요금이 청구됩니다."
        }
      >
        <Segmented
          value={conn}
          onChange={(v: Connection) => set({ connection: { ...s.connection, [provider]: v } })}
          options={[
            { value: "cli", label: <span className="flex items-center gap-1.5"><TerminalSquare className="size-3.5" />CLI · 내 계정</span> },
            { value: "api", label: <span className="flex items-center gap-1.5"><KeyRound className="size-3.5" />API 키</span> },
          ]}
        />
        <div className="mt-3">
          {conn === "cli" ? (
            <ToolRow
              name={`${cli} CLI`}
              info={cliInfo}
              action={!cliInfo?.ok && cliInfo ? <span className="text-xs text-muted">설치 후 터미널에서 로그인하세요</span> : undefined}
            />
          ) : (
            <KeyInput
              provider={provider}
              hint={key.set ? `${key.source === "env" ? "환경변수" : "저장됨"} · ${key.hint}` : "설정되지 않음"}
              onSave={(v) => save(provider === "openai" ? { openaiApiKey: v } : { anthropicApiKey: v })}
            />
          )}
        </div>
      </Block>
    );
  };
  return (
    <>
      {row("anthropic", "Claude", "Claude Code", tools.data?.claude)}
      {row("openai", "GPT", "Codex", tools.data?.codex)}
      <p className="rounded-xl bg-surface-2 px-3.5 py-3 text-[12.5px] leading-relaxed text-muted">
        CLI가 없다면 <code className="text-text">npm i -g @anthropic-ai/claude-code</code> 또는 <code className="text-text">npm i -g @openai/codex</code>로 설치한 뒤, 터미널에서 한 번 실행해 로그인하면 됩니다.
      </p>
    </>
  );
}

function KeyInput({ provider, hint, onSave }: { provider: Provider; hint: string; onSave: (v: string | null) => Promise<unknown> }) {
  const [v, setV] = useState("");
  return (
    <div>
      <Label hint={hint}>{provider === "openai" ? "OpenAI API 키" : "Anthropic API 키"}</Label>
      <form
        className="flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          await onSave(v.trim() || null);
          setV("");
          toast.success("API 키를 저장했습니다.");
        }}
      >
        <Input type="password" value={v} onChange={(e) => setV(e.target.value)} placeholder={provider === "openai" ? "sk-..." : "sk-ant-..."} autoComplete="off" />
        <Button type="submit" variant="primary">
          저장
        </Button>
      </form>
    </div>
  );
}

function TranscriptionSection({ s, set }: SectionProps) {
  const qc = useQueryClient();
  const tools = useQuery({
    queryKey: ["tools"],
    queryFn: () => api.tools(),
    refetchInterval: (q) => (Object.values(q.state.data?.downloads ?? {}).some((d) => d.status === "downloading") ? 1000 : false),
  });
  const install = useMutation({
    mutationFn: api.installWhisper,
    onSuccess: () => {
      toast.success("로컬 Whisper 엔진을 설치했습니다.");
      qc.invalidateQueries({ queryKey: ["tools"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const w = tools.data?.whisper;
  const downloads = tools.data?.downloads ?? {};
  const binDl = downloads["whisper-bin"];

  return (
    <>
      <Block title="받아쓰기 엔진" description="강의 음성을 텍스트로 바꿉니다. Claude/Codex CLI는 오디오를 받지 않으므로 로컬 Whisper를 추천합니다.">
        <div className="grid gap-2">
          {TRANSCRIPTION_MODELS.map((m) => (
            <button
              key={m.id}
              onClick={() => set({ transcription: m.id })}
              className={cn(
                "flex items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-colors",
                s.transcription === m.id ? "border-accent bg-accent-soft" : "border-border hover:border-border-strong",
              )}
            >
              <span className={cn("size-4 shrink-0 rounded-full border-2", s.transcription === m.id ? "border-accent bg-accent shadow-[inset_0_0_0_2px_var(--surface)]" : "border-border-strong")} />
              <div className="min-w-0">
                <div className="text-[13px] font-medium">{m.label}</div>
                <div className="text-xs text-muted">{m.blurb}</div>
              </div>
            </button>
          ))}
        </div>
        {s.transcription !== "local-whisper" && !s.keys.openai.set ? (
          <p className="mt-2 text-xs text-warning">OpenAI API 받아쓰기는 API 키(크레딧)가 필요합니다.</p>
        ) : null}
      </Block>

      {s.transcription === "local-whisper" ? (
        <Block title="로컬 Whisper" description="whisper.cpp 공식 빌드를 내려받아 이 PC의 CPU로 실행합니다. 긴 강의는 시간이 걸리지만 무료이고 오프라인으로 동작해요.">
          <ToolRow
            name="whisper.cpp 엔진"
            info={w}
            action={
              !w?.ok ? (
                <Button size="sm" variant="primary" loading={install.isPending} onClick={() => install.mutate()}>
                  {!install.isPending ? <Download className="size-3.5" /> : null}
                  설치
                </Button>
              ) : undefined
            }
          />
          {binDl?.status === "downloading" ? <Progress className="mt-2" value={binDl.total ? binDl.received / binDl.total : 0} /> : null}
          <div className="mt-3 grid gap-2">
            {WHISPER_MODELS.map((m) => {
              const installed = w?.models.includes(m.id);
              const dl = downloads[m.id];
              return (
                <div
                  key={m.id}
                  className={cn("rounded-xl border px-3.5 py-2.5", s.whisperModel === m.id ? "border-accent bg-accent-soft" : "border-border")}
                >
                  <div className="flex items-center gap-3">
                    <button className="min-w-0 flex-1 text-left" onClick={() => set({ whisperModel: m.id })}>
                      <div className="flex items-center gap-2 text-[13px] font-medium">
                        {m.label} <span className="text-xs font-normal text-faint">{m.size}</span>
                        {s.whisperModel === m.id ? <Badge tone="accent">사용 중</Badge> : null}
                      </div>
                      <div className="text-xs text-muted">{m.blurb}</div>
                    </button>
                    {installed ? (
                      <CheckCircle2 className="size-[18px] text-success" />
                    ) : dl?.status === "downloading" ? (
                      <span className="text-xs text-muted tabular-nums">{dl.total ? Math.round((dl.received / dl.total) * 100) : 0}%</span>
                    ) : (
                      <Button
                        size="sm"
                        onClick={async () => {
                          await api.installWhisperModel(m.id);
                          set({ whisperModel: m.id });
                          qc.invalidateQueries({ queryKey: ["tools"] });
                        }}
                      >
                        <Download className="size-3.5" /> 받기
                      </Button>
                    )}
                  </div>
                  {dl?.status === "downloading" ? <Progress className="mt-2" value={dl.total ? dl.received / dl.total : 0} /> : null}
                  {dl?.status === "error" ? <p className="mt-1 text-xs text-danger">{dl.error}</p> : null}
                </div>
              );
            })}
          </div>
        </Block>
      ) : null}

      <Block title="강의 언어" description="비워두면 자동으로 감지합니다. 알고 있다면 지정하는 편이 더 정확해요.">
        <Segmented
          value={s.spokenLanguage}
          onChange={(spokenLanguage) => set({ spokenLanguage })}
          options={[
            { value: "", label: "자동 감지" },
            { value: "ko", label: "한국어" },
            { value: "en", label: "English" },
            { value: "ja", label: "日本語" },
            { value: "zh", label: "中文" },
          ]}
        />
      </Block>

      <Block title="자막 활용" description="URL 강의에 자막이 있으면 받아쓰기 대신 쓸 수 있어요. 자막은 즉시 처리됩니다.">
        <Segmented
          value={s.subtitlePolicy}
          onChange={(subtitlePolicy) => set({ subtitlePolicy })}
          options={[
            { value: "prefer", label: "제작자 자막 우선" },
            { value: "only", label: "자막만 (자동 자막 포함)" },
            { value: "ai", label: "항상 직접 받아쓰기" },
          ]}
        />
      </Block>
    </>
  );
}

function ProcessingSection({ s, set }: SectionProps) {
  return (
    <>
      <Block title="화면 분석" description="슬라이드·판서가 바뀌는 장면을 캡처해 AI에게 함께 보여줍니다. 수식·도표가 많은 강의에서 노트 품질이 크게 좋아져요.">
        <div className="flex items-center justify-between rounded-xl border border-border px-3.5 py-3">
          <span className="text-[13px] font-medium">슬라이드·판서 캡처 사용</span>
          <Switch checked={s.visualAnalysis} onChange={(visualAnalysis) => set({ visualAnalysis })} label="화면 분석" />
        </div>
        {s.visualAnalysis ? (
          <div className="mt-3">
            <Label hint="파트(약 5~10분)당 AI에게 보낼 최대 장면 수">파트당 장면 수</Label>
            <Segmented
              value={String(s.framesPerSection)}
              onChange={(v) => set({ framesPerSection: Number(v) })}
              options={["3", "6", "10", "16"].map((v) => ({ value: v, label: v }))}
            />
          </div>
        ) : null}
      </Block>
      <Block title="동시 처리" description="여러 파트를 동시에 분석합니다. 높을수록 빠르지만 계정 사용 한도에 빨리 닿을 수 있어요.">
        <Segmented value={String(s.concurrency)} onChange={(v) => set({ concurrency: Number(v) })} options={["1", "2", "3", "4", "6"].map((v) => ({ value: v, label: v }))} />
      </Block>
      <Block title="URL 다운로드 화질">
        <Segmented
          value={s.downloadQuality}
          onChange={(downloadQuality) => set({ downloadQuality })}
          options={[
            { value: "480", label: "480p" },
            { value: "720", label: "720p" },
            { value: "1080", label: "1080p" },
          ]}
        />
      </Block>
      <Block title="로그인이 필요한 사이트" description="강의 사이트에 로그인된 브라우저의 쿠키를 yt-dlp가 사용합니다. (Chrome은 실행 중이면 실패할 수 있어 Firefox를 추천)">
        <Segmented
          value={s.cookiesFromBrowser}
          onChange={(cookiesFromBrowser) => set({ cookiesFromBrowser })}
          options={[
            { value: "", label: "사용 안 함" },
            { value: "chrome", label: "Chrome" },
            { value: "edge", label: "Edge" },
            { value: "firefox", label: "Firefox" },
            { value: "whale", label: "Whale" },
          ]}
        />
      </Block>
    </>
  );
}

function ToolsSection() {
  const qc = useQueryClient();
  const tools = useQuery({ queryKey: ["tools"], queryFn: () => api.tools() });
  const install = useMutation({
    mutationFn: api.installYtdlp,
    onSuccess: () => {
      toast.success("yt-dlp를 설치했습니다.");
      qc.invalidateQueries({ queryKey: ["tools"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Block title="외부 도구" description="영상 처리와 다운로드에 쓰는 도구들입니다.">
      <div className="grid gap-2">
        <ToolRow name="ffmpeg · 오디오/영상 처리" info={tools.data?.ffmpeg} />
        <ToolRow
          name="yt-dlp · URL 강의 다운로드"
          info={tools.data?.ytdlp}
          action={
            <Button size="sm" loading={install.isPending} onClick={() => install.mutate()}>
              {tools.data?.ytdlp.ok ? "업데이트" : "설치"}
            </Button>
          }
        />
        <ToolRow name="Claude Code CLI" info={tools.data?.claude} />
        <ToolRow name="Codex CLI" info={tools.data?.codex} />
        <ToolRow name="whisper.cpp · 로컬 받아쓰기" info={tools.data?.whisper} />
      </div>
      <Button variant="ghost" size="sm" className="mt-3" onClick={() => qc.fetchQuery({ queryKey: ["tools"], queryFn: () => api.tools(true) })}>
        다시 확인
      </Button>
    </Block>
  );
}
