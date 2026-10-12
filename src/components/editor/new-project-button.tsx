"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, errorText } from "@/lib/client/api";

export function NewProjectButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const { id } = await api<{ id: string }>("/api/editor/projects", { body: { name, description: description || null } });
      setOpen(false);
      router.push(`/projects/${id}`);
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus /> New project
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <form onSubmit={create} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>New project</DialogTitle>
              <DialogDescription>Group the videos you deliver for one client or campaign.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor="pname">Name</Label>
              <Input id="pname" autoFocus maxLength={200} value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme spring campaign" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="pdesc">Notes (optional)</Label>
              <Textarea id="pdesc" maxLength={2000} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Brand guidelines, deliverables, deadlines…" />
            </div>
            <DialogFooter>
              <Button type="submit" disabled={busy || !name.trim()}>
                {busy && <Loader2 className="animate-spin" />} Create project
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
