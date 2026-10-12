"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Bot, Cpu, Database, HardDrive, KeyRound, Loader2, Plus, Trash2, Wrench } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Pill, Section, StatusBadge } from "@/components/status";
import { CopyButton } from "@/components/editor/review-links-panel";
import { api, errorText } from "@/lib/client/api";
import { timeAgo } from "@/lib/format";
import { ADAPTERS } from "@/shared/operations";
import type { DeviceDTO } from "@/shared/dto";
import type { SystemStatus } from "@/lib/services/system";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-[13px] break-all sm:text-right">{children}</span>
    </div>
  );
}

export function SettingsView({ status, devices: initialDevices }: { status: SystemStatus; devices: DeviceDTO[] }) {
  const router = useRouter();
  const [devices, setDevices] = useState(initialDevices);
  const [registerOpen, setRegisterOpen] = useState(false);

  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const { devices } = await api<{ devices: DeviceDTO[] }>("/api/editor/devices");
        setDevices(devices);
      } catch {
        /* keep last known */
      }
    }, 10_000);
    return () => clearInterval(t);
  }, []);

  async function revoke(d: DeviceDTO) {
    if (!confirm(`Revoke “${d.name}”? Its token stops working immediately and running jobs return to the queue.`)) return;
    try {
      await api(`/api/editor/devices/${d.id}`, { method: "DELETE" });
      toast.success("Device revoked");
      const { devices } = await api<{ devices: DeviceDTO[] }>("/api/editor/devices");
      setDevices(devices);
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  return (
    <div className="grid gap-6 px-4 py-6 sm:px-6 xl:grid-cols-2">
      <Section title={<span className="flex items-center gap-2"><HardDrive className="size-4" /> Video storage</span>}>
        <div className="divide-y">
          <Row label="Driver">
            {status.storage.driver === "s3" ? "S3-compatible (Cloudflare R2)" : "Local filesystem"}{" "}
            {status.storage.mode === "local_dev" && <Pill tone="warning">Local development mode</Pill>}
          </Row>
          <Row label="Location">{status.storage.description}</Row>
          <Row label="Connectivity">
            {status.storage.ok === true ? <StatusBadge status="ready" /> : status.storage.ok === false ? <span className="text-destructive">{status.storage.error}</span> : "Not checked"}
          </Row>
          <Row label="Signed URL lifetime">{Math.round(status.security.signedUrlTtlSeconds / 60)} minutes</Row>
        </div>
        {status.storage.mode === "local_dev" && (
          <p className="border-t px-4 py-2.5 text-xs text-muted-foreground">
            Files are stored on this server&apos;s disk. Set S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY and R2_ACCOUNT_ID for Cloudflare R2 in production.
          </p>
        )}
      </Section>

      <Section title={<span className="flex items-center gap-2"><Database className="size-4" /> Database</span>}>
        <div className="divide-y">
          <Row label="Driver">
            {status.database.driver === "postgres" ? "PostgreSQL (Supabase)" : "PGlite (embedded PostgreSQL)"}{" "}
            {status.database.mode === "local_dev" && <Pill tone="warning">Local development mode</Pill>}
          </Row>
          <Row label="Status">{status.database.ok ? <StatusBadge status="ready" /> : <span className="text-destructive">{status.database.error}</span>}</Row>
        </div>
        {status.database.mode === "local_dev" && (
          <p className="border-t px-4 py-2.5 text-xs text-muted-foreground">Set DATABASE_URL to your Supabase connection string and run npm run db:migrate for production.</p>
        )}
      </Section>

      <Section title={<span className="flex items-center gap-2"><Bot className="size-4" /> Claude</span>}>
        <div className="divide-y">
          <Row label="API key">{status.claude.configured ? <StatusBadge status="ready" /> : <Pill tone="warning">Not configured</Pill>}</Row>
          <Row label="Model">{status.claude.model}</Row>
          <Row label="Effort">{status.claude.effort}</Row>
          <Row label="Frame stills for context">{status.media.ffmpeg ? "Enabled (server ffmpeg found)" : "Unavailable (no ffmpeg on server)"}</Row>
        </div>
        {!status.claude.configured && (
          <p className="border-t px-4 py-2.5 text-xs text-muted-foreground">Without a key, AI Review can only produce clearly labelled offline drafts (no AI).</p>
        )}
      </Section>

      <Section title={<span className="flex items-center gap-2"><KeyRound className="size-4" /> Editor access</span>}>
        <div className="divide-y">
          <Row label="Protection">{status.security.editorKeyConfigured ? "Access key + signed session cookie" : <span className="text-destructive">EDITOR_ACCESS_KEY not set</span>}</Row>
          <Row label="App URL">{status.security.appUrl}</Row>
          <Row label="Secure cookies">{status.security.secureCookies ? "Yes (HTTPS)" : <Pill tone="warning">No (HTTP — local only)</Pill>}</Row>
          <Row label="Server metadata probe">{status.media.ffprobe ? "ffprobe available" : "Browser metadata only"}</Row>
        </div>
        <p className="border-t px-4 py-2.5 text-xs text-muted-foreground">
          Rotate EDITOR_ACCESS_KEY to sign out every editor session. Clients never use this key; they only receive review links.
        </p>
      </Section>

      <Section
        className="xl:col-span-2"
        title={<span className="flex items-center gap-2"><Cpu className="size-4" /> Editing devices</span>}
        actions={
          <Button size="xs" variant="outline" onClick={() => setRegisterOpen(true)}>
            <Plus /> Register device
          </Button>
        }
      >
        {devices.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">No devices yet. Register the computer that runs your editing software.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-[13px]">
              <thead className="border-b text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-normal">Device</th>
                  <th className="px-4 py-2 font-normal">Status</th>
                  <th className="px-4 py-2 font-normal">Adapters</th>
                  <th className="px-4 py-2 font-normal">Platform</th>
                  <th className="px-4 py-2 font-normal">Last seen</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {devices.map((d) => (
                  <tr key={d.id}>
                    <td className="px-4 py-2.5 font-medium">
                      <span className="flex items-center gap-2">
                        <span className={`size-2 rounded-full ${d.online ? "bg-success" : "bg-white/20"}`} aria-label={d.online ? "online" : "offline"} />
                        {d.name}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      {d.status === "active" ? <Pill tone={d.online ? "success" : "neutral"}>{d.online ? "Online" : "Disconnected"}</Pill> : <StatusBadge status={d.status} />}
                      {d.status === "pending" && d.registration_expires_at && new Date(d.registration_expires_at).getTime() < Date.now() && (
                        <span className="ml-2 text-xs text-muted-foreground">code expired</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="flex flex-wrap gap-1">
                        {d.adapters.length ? d.adapters.map((a) => <Pill key={a}>{ADAPTERS[a as keyof typeof ADAPTERS]?.label ?? a}</Pill>) : <span className="text-xs text-muted-foreground">—</span>}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">
                      {d.platform ?? "—"} {d.agent_version && `· agent ${d.agent_version}`}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">{timeAgo(d.last_seen_at)}</td>
                    <td className="px-4 py-2.5 text-right">
                      {d.status !== "revoked" && (
                        <Button size="xs" variant="ghost" onClick={() => revoke(d)}>
                          <Trash2 /> Revoke
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section className="xl:col-span-2" title={<span className="flex items-center gap-2"><Wrench className="size-4" /> Editor integrations (adapters)</span>}>
        <ul className="divide-y">
          {Object.values(ADAPTERS).map((a) => (
            <li key={a.id} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-medium">{a.label}</span>
                {a.implemented ? <Pill tone="success">Implemented</Pill> : <Pill>Not implemented</Pill>}
                {a.implemented && (a.automated ? <Pill tone="info">Automated</Pill> : <Pill>Human-performed</Pill>)}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{a.summary}</p>
              {a.implemented && a.supportedOps.length > 0 && (
                <p className="mt-1 text-xs text-muted-foreground">Operations: {a.supportedOps.join(", ")}</p>
              )}
            </li>
          ))}
        </ul>
      </Section>

      <RegisterDialog
        open={registerOpen}
        onOpenChange={(o) => {
          setRegisterOpen(o);
          if (!o) router.refresh();
        }}
        appUrl={status.security.appUrl}
      />
    </div>
  );
}

function RegisterDialog({ open, onOpenChange, appUrl }: { open: boolean; onOpenChange: (o: boolean) => void; appUrl: string }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const command = code ? `npm run agent -- register --server ${appUrl} --code ${code} --name "${name.replace(/"/g, "")}"` : "";

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) {
          setCode(null);
          setName("");
        }
      }}
    >
      <DialogContent className="sm:max-w-lg">
        {code ? (
          <div className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Registration code</DialogTitle>
              <DialogDescription>Valid for 15 minutes and usable once. It is shown only now.</DialogDescription>
            </DialogHeader>
            <div className="rounded-lg border bg-subtle px-4 py-3 text-center font-mono text-xl tracking-widest">{code}</div>
            <div className="grid gap-2">
              <Label>On the editing computer, in the ReelReview folder:</Label>
              <div className="flex items-center gap-2">
                <Input readOnly value={command} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
                <CopyButton value={command} label="Copy" />
              </div>
              <p className="text-xs text-muted-foreground">Then start it with <code>npm run agent -- start</code>. See agent/README.md.</p>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            className="grid gap-4"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                const res = await api<{ code: string }>("/api/editor/devices", { body: { name } });
                setCode(res.code);
              } catch (err) {
                toast.error(errorText(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            <DialogHeader>
              <DialogTitle>Register an editing device</DialogTitle>
              <DialogDescription>The local agent connects outbound to this server and only ever receives approved jobs.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor="dname">Device name</Label>
              <Input id="dname" autoFocus maxLength={100} value={name} onChange={(e) => setName(e.target.value)} placeholder="Edit bay 1 (Mac Studio)" />
            </div>
            <DialogFooter>
              <Button type="submit" disabled={busy || !name.trim()}>
                {busy && <Loader2 className="animate-spin" />} Create registration code
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
