import { requireEditorPage } from "@/lib/auth/editor";
import { AppShell } from "@/components/app-shell";

/** Every page in this group is editor-only (checked here and in proxy.ts). */
export default async function EditorLayout({ children }: { children: React.ReactNode }) {
  const editor = await requireEditorPage();
  return <AppShell editorName={editor.name}>{children}</AppShell>;
}
