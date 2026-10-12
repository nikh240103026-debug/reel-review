import { redirect } from "next/navigation";
import { isEditor } from "@/lib/auth/editor";
import { UnlockForm } from "./unlock-form";

export const metadata = { title: "Editor access" };

export default async function UnlockPage({ searchParams }: PageProps<"/unlock">) {
  const sp = await searchParams;
  const next = typeof sp.next === "string" && sp.next.startsWith("/") && !sp.next.startsWith("//") ? sp.next : "/dashboard";
  if (await isEditor()) redirect(next);
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <UnlockForm next={next} />
    </div>
  );
}
