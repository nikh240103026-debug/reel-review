"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Ban, Check, Copy, Link2, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Pill, Section, StatusBadge } from "@/components/status";
import { api, errorText } from "@/lib/client/api";
import { formatDateTime, timeAgo } from "@/lib/format";
import type { ReviewLinkDTO } from "@/shared/dto";

export function CopyButton({ value, label = "Copy link" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="xs"
      variant="outline"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          toast.error("Could not access the clipboard; copy the link manually.");
        }
      }}
    >
      {copied ? <Check /> : <Copy />} {copied ? "Copied" : label}
    </Button>
  );
}

export function CreateLinkDialog({
  projectId,
  videos,
  defaultVideoId,
  open,
  onOpenChange,
}: {
  projectId: string;
  videos: { id: string; title: string }[];
  defaultVideoId?: string | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const router = useRouter();
  const [videoId, setVideoId] = useState<string>(defaultVideoId ?? "");
  const [canComment, setCanComment] = useState(true);
  const [expiry, setExpiry] = useState<"never" | "7" | "30" | "custom">("never");
  const [customDate, setCustomDate] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<ReviewLinkDTO | null>(null);

  function expiresAt(): string | null {
    if (expiry === "never") return null;
    if (expiry === "custom") return customDate ? new Date(`${customDate}T23:59:59`).toISOString() : null;
    return new Date(Date.now() + Number(expiry) * 86400_000).toISOString();
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const { link } = await api<{ link: ReviewLinkDTO }>(`/api/editor/projects/${projectId}/links`, {
        body: { videoId: videoId || null, canComment, expiresAt: expiresAt(), label: label || null },
      });
      setCreated(link);
      router.refresh();
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setCreated(null);
      }}
    >
      <DialogContent className="sm:max-w-md">
        {created ? (
          <div className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Review link ready</DialogTitle>
              <DialogDescription>
                Anyone with this link can {created.can_comment ? "watch and comment" : "watch"} without an account. Revoke it any time.
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2">
              <Input readOnly value={created.url ?? ""} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
              {created.url && <CopyButton value={created.url} label="Copy" />}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={create} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Share for review</DialogTitle>
              <DialogDescription>Creates a private, unguessable link. Clients only enter their name.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor="scope">Access to</Label>
              <select
                id="scope"
                value={videoId}
                onChange={(e) => setVideoId(e.target.value)}
                className="h-8 rounded-lg border border-input bg-input/30 px-2.5 text-sm"
              >
                <option value="">Whole project (all videos)</option>
                {videos.map((v) => (
                  <option key={v.id} value={v.id}>
                    Only: {v.title}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center justify-between rounded-lg border px-3 py-2">
              <div>
                <div className="text-sm">Allow comments</div>
                <div className="text-xs text-muted-foreground">Off = view-only link</div>
              </div>
              <Switch checked={canComment} onCheckedChange={setCanComment} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="expiry">Expires</Label>
              <div className="flex gap-2">
                <select
                  id="expiry"
                  value={expiry}
                  onChange={(e) => setExpiry(e.target.value as typeof expiry)}
                  className="h-8 flex-1 rounded-lg border border-input bg-input/30 px-2.5 text-sm"
                >
                  <option value="never">Never (revoke manually)</option>
                  <option value="7">In 7 days</option>
                  <option value="30">In 30 days</option>
                  <option value="custom">On a date…</option>
                </select>
                {expiry === "custom" && (
                  <Input type="date" className="w-40" value={customDate} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setCustomDate(e.target.value)} />
                )}
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="label">Label (optional, only you see it)</Label>
              <Input id="label" maxLength={200} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Sent to marketing team" />
            </div>
            <DialogFooter>
              <Button type="submit" disabled={busy || (expiry === "custom" && !customDate)}>
                {busy ? <Loader2 className="animate-spin" /> : <Link2 />} Create link
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function ReviewLinksPanel({
  projectId,
  links,
  videos,
  defaultVideoId,
}: {
  projectId: string;
  links: ReviewLinkDTO[];
  videos: { id: string; title: string }[];
  defaultVideoId?: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const visible = links.filter((l) => showInactive || l.state === "active").filter((l) => !defaultVideoId || l.video_id === defaultVideoId || l.scope === "project");

  async function patch(id: string, body: Record<string, unknown>, msg: string) {
    try {
      await api(`/api/editor/links/${id}`, { method: "PATCH", body });
      toast.success(msg);
      router.refresh();
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  return (
    <Section
      title="Review links"
      actions={
        <Button size="xs" variant="outline" onClick={() => setOpen(true)}>
          <Plus /> New link
        </Button>
      }
    >
      {visible.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">No active review links.</p>
      ) : (
        <ul className="divide-y">
          {visible.map((l) => (
            <li key={l.id} className="space-y-2 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-medium">{l.label || (l.scope === "project" ? "Whole project" : l.video_title)}</span>
                <StatusBadge status={l.state} />
                <Pill>{l.can_comment ? "Can comment" : "View only"}</Pill>
                {l.scope === "video" && l.label && <Pill>{l.video_title}</Pill>}
              </div>
              <div className="text-xs text-muted-foreground">
                Created {timeAgo(l.created_at)} · {l.expires_at ? `expires ${formatDateTime(l.expires_at)}` : "no expiry"} · last opened {timeAgo(l.last_used_at)}
              </div>
              {l.state === "active" && (
                <div className="flex flex-wrap gap-2">
                  {l.url && <CopyButton value={l.url} />}
                  <Button size="xs" variant="outline" onClick={() => patch(l.id, { canComment: !l.can_comment }, "Permissions updated")}>
                    {l.can_comment ? "Make view-only" : "Allow comments"}
                  </Button>
                  <Button
                    size="xs"
                    variant="destructive"
                    onClick={() => {
                      if (confirm("Revoke this link? Anyone using it will lose access immediately.")) patch(l.id, { revoke: true }, "Link revoked");
                    }}
                  >
                    <Ban /> Revoke
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {links.some((l) => l.state !== "active") && (
        <button onClick={() => setShowInactive((s) => !s)} className="w-full border-t px-4 py-2 text-left text-xs text-muted-foreground hover:text-foreground">
          {showInactive ? "Hide revoked/expired links" : `Show ${links.filter((l) => l.state !== "active").length} revoked/expired link(s)`}
        </button>
      )}
      <CreateLinkDialog projectId={projectId} videos={videos} defaultVideoId={defaultVideoId} open={open} onOpenChange={setOpen} />
    </Section>
  );
}
