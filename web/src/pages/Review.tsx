import { Link, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Layers } from "lucide-react";
import type { Flashcard } from "@shared/types";
import { EmptyState, Spinner } from "@/components/ui";
import { ReviewSession, type ReviewItem } from "@/features/ReviewSession";
import { api } from "@/lib/api";

/** One review session over every lecture's cards, or one folder's. */
export function ReviewPage() {
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const folderId = params.get("folder") ?? undefined;
  const key = ["review", folderId ?? "all"];
  const { data: items } = useQuery({ queryKey: key, queryFn: () => api.reviewItems(folderId) });
  const { data: folders = [] } = useQuery({ queryKey: ["folders"], queryFn: api.folders });
  const folder = folders.find((f) => f.id === folderId);

  const save = (item: ReviewItem, patch: Partial<Flashcard>) => {
    qc.setQueryData<ReviewItem[]>(key, (old) => (old ?? []).map((x) => (x.card.id === item.card.id ? { ...x, card: { ...x.card, ...patch } } : x)));
    void qc.invalidateQueries({ queryKey: ["flashcards", item.lectureId] });
    void qc.invalidateQueries({ queryKey: ["lectures"] });
    return api.updateCard(item.lectureId, item.card.id, patch);
  };

  return (
    <div className="mx-auto w-full max-w-[720px] px-4 pt-6 pb-24 sm:px-8">
      <Link
        to={folder ? `/?folder=${folder.id}` : "/"}
        className="-ml-2 inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] font-medium text-muted transition-colors hover:bg-surface-2 hover:text-text"
      >
        <ArrowLeft className="size-4" />
        {folder ? folder.name : "내 강의"}
      </Link>
      <h1 className="mt-3 mb-6 font-serif text-[26px] font-semibold tracking-tight">{folder ? `${folder.name} 복습` : "오늘의 복습"}</h1>
      {items ? (
        <ReviewSession
          items={items}
          onSave={save}
          empty={<EmptyState icon={<Layers />} title="복습할 카드가 없어요" description="강의 분석이 끝나면 카드가 만들어져요." />}
        />
      ) : (
        <div className="flex justify-center py-20">
          <Spinner />
        </div>
      )}
    </div>
  );
}
