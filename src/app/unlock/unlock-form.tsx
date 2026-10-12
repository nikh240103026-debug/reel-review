"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Clapperboard, KeyRound, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, errorText } from "@/lib/client/api";

export function UnlockForm({ next }: { next: string }) {
  const router = useRouter();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/editor-session", { body: { accessKey: key } });
      router.replace(next);
      router.refresh();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="w-full max-w-sm rounded-xl border bg-card p-6">
      <div className="mb-6 flex items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Clapperboard className="size-4" />
        </span>
        <span className="font-semibold tracking-tight">ReelReview</span>
      </div>
      <h1 className="text-base font-medium">Editor workspace</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Enter the editor access key from your server configuration. Clients never need this; they use review links.
      </p>
      <div className="mt-5 space-y-2">
        <Label htmlFor="key">Access key</Label>
        <Input id="key" type="password" autoComplete="current-password" autoFocus value={key} onChange={(e) => setKey(e.target.value)} />
      </div>
      {error && <p className="mt-3 text-sm text-destructive" role="alert">{error}</p>}
      <Button type="submit" className="mt-5 w-full" disabled={busy || !key}>
        {busy ? <Loader2 className="animate-spin" /> : <KeyRound />}
        Unlock
      </Button>
    </form>
  );
}
