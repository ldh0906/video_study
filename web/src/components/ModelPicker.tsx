import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronsUpDown, Loader2, TerminalSquare, KeyRound, Zap } from "lucide-react";
import { toast } from "sonner";
import { EFFORT_LABELS } from "@shared/catalog";
import type { ModelChoice, ModelOption, Provider } from "@shared/types";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button, Input, Popover, Segmented } from "./ui";

const PROVIDERS: { value: Provider; label: string }[] = [
  { value: "anthropic", label: "Claude" },
  { value: "openai", label: "GPT" },
];

export function useModels(provider: Provider) {
  return useQuery({ queryKey: ["models", provider], queryFn: () => api.models(provider), staleTime: 60_000 });
}

function effortList(model: ModelOption | undefined) {
  return ["default", ...(model?.efforts ?? ["low", "medium", "high"])];
}

export function ModelPicker({ value, onChange, compact }: { value: ModelChoice; onChange: (v: ModelChoice) => void; compact?: boolean }) {
  const { data, isLoading } = useModels(value.provider);
  const models = data?.models ?? [];
  const current = models.find((m) => m.id === value.model);
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const [testing, setTesting] = useState(false);

  const switchProvider = async (provider: Provider) => {
    if (provider === value.provider) return;
    const list = (await api.models(provider).catch(() => null))?.models ?? [];
    const first = list[0];
    onChange({ provider, model: first?.id ?? "", effort: first?.defaultEffort ?? "default" });
  };

  const pickModel = (m: ModelOption) => {
    const efforts = effortList(m);
    onChange({ ...value, model: m.id, effort: efforts.includes(value.effort) ? value.effort : m.defaultEffort });
    setOpen(false);
  };

  const test = async () => {
    setTesting(true);
    try {
      const r = await api.testModel(value);
      toast.success(`연결 성공 · ${(r.ms / 1000).toFixed(1)}초`, { description: `${current?.label ?? value.model} 응답: “${r.text}”` });
    } catch (e) {
      toast.error("연결 실패", { description: (e as Error).message });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented value={value.provider} onChange={switchProvider} options={PROVIDERS} />
        {data ? (
          <span className="inline-flex items-center gap-1 text-xs text-faint">
            {data.connection === "cli" ? <TerminalSquare className="size-3.5" /> : <KeyRound className="size-3.5" />}
            {data.connection === "cli" ? (value.provider === "anthropic" ? "Claude Code 계정" : "Codex 계정") : "API 키"}
          </span>
        ) : null}
      </div>

      <Popover
        open={open}
        onOpenChange={setOpen}
        className="w-[min(420px,calc(100vw-32px))] p-1.5"
        trigger={
          <button
            type="button"
            className="flex w-full items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2.5 text-left transition-colors hover:border-border-strong"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{current?.label ?? (value.model || "모델 선택")}</div>
              {!compact ? <div className="truncate text-xs text-muted">{current?.blurb ?? (value.model ? value.model : "사용할 모델을 고르세요")}</div> : null}
            </div>
            {isLoading ? <Loader2 className="size-4 animate-spin text-faint" /> : <ChevronsUpDown className="size-4 text-faint" />}
          </button>
        }
      >
        <div className="max-h-[320px] overflow-y-auto">
          {models.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => pickModel(m)}
              className={cn("flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-surface-2", m.id === value.model && "bg-surface-2")}
            >
              <Check className={cn("mt-0.5 size-4 shrink-0 text-accent", m.id === value.model ? "opacity-100" : "opacity-0")} />
              <div className="min-w-0">
                <div className="text-[13px] font-medium">{m.label}</div>
                <div className="truncate text-xs text-muted">{m.blurb ?? m.id}</div>
              </div>
            </button>
          ))}
          {data?.error ? <div className="px-2.5 py-2 text-xs text-warning">{data.error}</div> : null}
        </div>
        <form
          className="mt-1 flex gap-1.5 border-t border-border p-1.5 pt-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!custom.trim()) return;
            onChange({ ...value, model: custom.trim(), effort: "default" });
            setCustom("");
            setOpen(false);
          }}
        >
          <Input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="직접 입력 (모델 ID)" className="h-8 text-[13px]" />
          <Button size="sm" type="submit">
            사용
          </Button>
        </form>
      </Popover>

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-xs font-medium text-muted">추론 강도 (effort)</span>
          <Button variant="ghost" size="sm" onClick={test} loading={testing} className="h-6 px-2 text-xs">
            {!testing ? <Zap className="size-3.5" /> : null} 연결 테스트
          </Button>
        </div>
        <Segmented
          size="sm"
          value={value.effort}
          onChange={(effort) => onChange({ ...value, effort })}
          options={effortList(current).map((e) => ({ value: e, label: EFFORT_LABELS[e] ?? e }))}
        />
      </div>
    </div>
  );
}
