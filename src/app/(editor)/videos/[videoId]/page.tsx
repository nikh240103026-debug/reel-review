import { Suspense } from "react";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { listDevices } from "@/lib/services/devices";
import { EditorVideoWorkspace } from "./editor-video-workspace";

export const metadata = { title: "Review" };

export default async function EditorVideoPage({ params }: PageProps<"/videos/[videoId]">) {
  const { videoId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(videoId)) notFound();
  const db = await getDb();
  const [video] = await db.query<{ id: string; title: string; project_id: string; project_name: string }>(
    "select v.id, v.title, v.project_id, p.name as project_name from videos v join projects p on p.id = v.project_id where v.id = $1",
    [videoId],
  );
  if (!video) notFound();
  const devices = await listDevices();
  return (
    <Suspense>
      <EditorVideoWorkspace
        videoId={videoId}
        projectId={video.project_id}
        projectName={video.project_name}
        aiConfigured={env.aiConfigured}
        aiModel={env.aiModel}
        aiProvider={env.aiProvider}
        activeAdapters={[...new Set(devices.filter((d) => d.status === "active").flatMap((d) => d.adapters))]}
      />
    </Suspense>
  );
}
