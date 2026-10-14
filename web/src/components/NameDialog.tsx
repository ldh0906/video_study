import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button, Dialog, Input } from "@/components/ui";

/** A one-field dialog for naming things: renaming a lecture, creating or renaming a folder. */
export function NameDialog({
  open,
  title,
  description,
  initial = "",
  placeholder,
  confirmLabel = "저장",
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  description?: string;
  initial?: string;
  placeholder?: string;
  confirmLabel?: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<unknown>;
}) {
  const [value, setValue] = useState(initial);
  const [pending, setPending] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) setValue(initial);
  }, [open, initial]);

  const name = value.trim();
  const submit = async () => {
    if (!name || pending) return;
    setPending(true);
    try {
      await onSubmit(name);
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => !v && onClose()}
      title={title}
      description={description}
      className="max-w-md"
      initialFocus={input}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            취소
          </Button>
          <Button variant="primary" disabled={!name || name === initial.trim()} loading={pending} onClick={submit}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Input ref={input} value={value} onChange={(e) => setValue(e.target.value)} onFocus={(e) => e.currentTarget.select()} placeholder={placeholder} maxLength={200} />
      </form>
    </Dialog>
  );
}
