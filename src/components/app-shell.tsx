"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { Clapperboard, LayoutGrid, ListChecks, LogOut, Menu, Settings, Sparkles, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/lib/client/api";

const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutGrid },
  { href: "/proposals", label: "Approvals", icon: Sparkles },
  { href: "/jobs", label: "Jobs", icon: ListChecks },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function AppShell({ children, editorName }: { children: React.ReactNode; editorName: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  async function signOut() {
    await api("/api/editor-session", { method: "DELETE" }).catch(() => undefined);
    router.replace("/unlock");
  }

  const nav = (
    <nav className="flex flex-col gap-0.5">
      {NAV.map((item) => {
        const active = pathname === item.href || pathname.startsWith(item.href + "/") || (item.href === "/dashboard" && pathname.startsWith("/projects"));
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={() => setOpen(false)}
            className={cn(
              "flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
              active && "bg-accent text-foreground",
            )}
          >
            <item.icon className="size-4" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r bg-panel px-3 py-4 md:flex">
        <Link href="/dashboard" className="mb-6 flex items-center gap-2 px-2.5">
          <span className="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Clapperboard className="size-3.5" />
          </span>
          <span className="text-sm font-semibold tracking-tight">ReelReview</span>
        </Link>
        {nav}
        <div className="mt-auto border-t pt-3">
          <div className="px-2.5 pb-2 text-xs text-muted-foreground">
            Signed in as <span className="text-foreground">{editorName}</span>
          </div>
          <button
            onClick={signOut}
            className="flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <LogOut className="size-4" /> Lock editor
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-12 items-center gap-3 border-b bg-panel/95 px-4 backdrop-blur md:hidden">
          <button aria-label="Open menu" onClick={() => setOpen(true)} className="-ml-1 rounded-md p-1.5 hover:bg-accent">
            <Menu className="size-5" />
          </button>
          <span className="text-sm font-semibold">ReelReview</span>
        </header>
        {open && (
          <div className="fixed inset-0 z-50 md:hidden">
            <div className="absolute inset-0 bg-black/60" onClick={() => setOpen(false)} />
            <div className="absolute inset-y-0 left-0 flex w-64 flex-col border-r bg-panel p-4">
              <div className="mb-5 flex items-center justify-between">
                <span className="text-sm font-semibold">ReelReview</span>
                <button aria-label="Close menu" onClick={() => setOpen(false)} className="rounded-md p-1 hover:bg-accent">
                  <X className="size-4" />
                </button>
              </div>
              {nav}
              <button onClick={signOut} className="mt-auto flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] text-muted-foreground hover:bg-accent">
                <LogOut className="size-4" /> Lock editor
              </button>
            </div>
          </div>
        )}
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  breadcrumb,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  breadcrumb?: React.ReactNode;
}) {
  return (
    <div className="border-b px-4 py-5 sm:px-6">
      {breadcrumb && <div className="mb-1.5 text-xs text-muted-foreground">{breadcrumb}</div>}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold tracking-tight">{title}</h1>
          {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}
