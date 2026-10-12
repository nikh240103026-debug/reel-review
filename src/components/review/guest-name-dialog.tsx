"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

/** "What's your name?" — the only thing a guest is ever asked for. */
export function GuestNameDialog({
  open,
  initialName,
  dismissible,
  onSave,
  onClose,
}: {
  open: boolean;
  initialName?: string | null;
  dismissible: boolean;
  onSave: (name: string) => Promise<void> | void;
  onClose?: () => void;
}) {
  const [name, setName] = useState(initialName ?? "");
  const [busy, setBusy] = useState(false);
  const clean = name.replace(/\s+/g, " ").trim();

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && dismissible) onClose?.();
      }}
      disablePointerDismissal={!dismissible}
    >
      <DialogContent showCloseButton={dismissible} className="sm:max-w-xs">
        <form
          className="grid gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!clean) return;
            setBusy(true);
            await onSave(clean);
            setBusy(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>What&apos;s your name?</DialogTitle>
            <DialogDescription>Shown next to your comments. No account needed.</DialogDescription>
          </DialogHeader>
          <Input autoFocus maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" aria-label="Your name" />
          <Button type="submit" disabled={!clean || busy}>
            Continue
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
