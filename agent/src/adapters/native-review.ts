import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AdapterId } from "../../../src/shared/operations";
import { FfmpegAdapter } from "./ffmpeg";
import type { AdapterCapabilities, EditorAdapter, ExecutionResult, JobContext, OperationOutcome, ProjectInspection } from "./types";

type NativeEditor = {
  id: Extract<AdapterId, "premiere_pro" | "after_effects" | "davinci_resolve">;
  label: string;
  macPrefix: string;
  windowsDirectory: string;
  windowsExecutable: string;
};

const EDITORS: NativeEditor[] = [
  {
    id: "premiere_pro",
    label: "Adobe Premiere Pro",
    macPrefix: "Adobe Premiere Pro",
    windowsDirectory: "Adobe Premiere Pro",
    windowsExecutable: "Adobe Premiere Pro.exe",
  },
  {
    id: "after_effects",
    label: "Adobe After Effects",
    macPrefix: "Adobe After Effects",
    windowsDirectory: "Adobe After Effects",
    windowsExecutable: "AfterFX.exe",
  },
  {
    id: "davinci_resolve",
    label: "DaVinci Resolve",
    macPrefix: "DaVinci Resolve",
    windowsDirectory: path.join("Blackmagic Design", "DaVinci Resolve"),
    windowsExecutable: "Resolve.exe",
  },
];

function findApplication(editor: NativeEditor): string | null {
  if (process.platform === "darwin") {
    for (const root of ["/Applications", path.join(os.homedir(), "Applications")]) {
      try {
        const match = fs
          .readdirSync(root)
          .filter((entry) => entry.startsWith(editor.macPrefix) && entry.endsWith(".app"))
          .sort()
          .at(-1);
        if (match) return path.join(root, match);
      } catch {
        continue;
      }
    }
  }

  if (process.platform === "win32") {
    const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter((root): root is string => Boolean(root));
    for (const root of roots) {
      const directory = path.join(root, "Adobe");
      if (editor.id === "davinci_resolve") {
        const executable = path.join(root, editor.windowsDirectory, editor.windowsExecutable);
        if (fs.existsSync(executable)) return executable;
        continue;
      }
      try {
        const match = fs
          .readdirSync(directory)
          .filter((entry) => entry.startsWith(editor.windowsDirectory))
          .sort()
          .at(-1);
        if (match) {
          const executable = path.join(directory, match, editor.windowsExecutable);
          if (fs.existsSync(executable)) return executable;
        }
      } catch {
        continue;
      }
    }
  }

  return null;
}

function openInEditor(application: string, file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child =
      process.platform === "darwin"
        ? spawn("open", ["-a", application, "--", file], { detached: true, stdio: "ignore" })
        : spawn(application, [file], { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/** Applies flattened-video operations with FFmpeg, then opens the render for editor review. */
class NativeReviewAdapter implements EditorAdapter {
  private readonly renderer = new FfmpegAdapter();

  constructor(private readonly editor: NativeEditor) {}

  get id() {
    return this.editor.id;
  }

  get needsSource() {
    return this.renderer.needsSource;
  }

  async getCapabilities(): Promise<AdapterCapabilities> {
    const ffmpeg = await this.renderer.getCapabilities();
    const application = findApplication(this.editor);
    const available = ffmpeg.implemented && application !== null;
    return {
      id: this.editor.id,
      label: `${this.editor.label} (FFmpeg render + review)`,
      implemented: available,
      automated: true,
      supportedOps: available ? ffmpeg.supportedOps : [],
      details: {
        renderer: "ffmpeg",
        application: application ? path.basename(application) : null,
        status: available ? "ready" : !ffmpeg.implemented ? "ffmpeg-unavailable" : "editor-not-found",
      },
    };
  }

  inspectProject(ctx: JobContext): Promise<ProjectInspection> {
    return this.renderer.inspectProject(ctx);
  }

  validateOperation(op: Parameters<EditorAdapter["validateOperation"]>[0], inspection: ProjectInspection) {
    return this.renderer.validateOperation(op, inspection);
  }

  executeApprovedOperation(op: Parameters<EditorAdapter["executeApprovedOperation"]>[0], ctx: JobContext, inspection: ProjectInspection): Promise<OperationOutcome> {
    return this.renderer.executeApprovedOperation(op, ctx, inspection);
  }

  async finalizeJob(ctx: JobContext, inspection: ProjectInspection): Promise<ExecutionResult> {
    const result = await this.renderer.finalizeJob(ctx, inspection);
    if (!result.render) return result;
    const application = findApplication(this.editor);
    if (!application) throw new Error(`${this.editor.label} was not found after rendering. Install it and restart the agent.`);
    const reviewDir = path.join(path.dirname(ctx.workDir), "Reviewed Renders");
    fs.mkdirSync(reviewDir, { recursive: true });
    const reviewPath = path.join(reviewDir, result.render.filename);
    fs.copyFileSync(result.render.path, reviewPath);
    await openInEditor(application, reviewPath);
    await ctx.log("info", `Opened the FFmpeg render in ${this.editor.label} for human review: ${reviewPath}`);
    return { ...result, summary: `${result.summary} Opened in ${this.editor.label} for human review.` };
  }

  getJobStatus(jobId: string) {
    return this.renderer.getJobStatus(jobId);
  }

  cancelJob(jobId: string): Promise<void> {
    return this.renderer.cancelJob(jobId);
  }
}

export class PremiereProAdapter extends NativeReviewAdapter {
  constructor() {
    super(EDITORS[0]!);
  }
}

export class AfterEffectsAdapter extends NativeReviewAdapter {
  constructor() {
    super(EDITORS[1]!);
  }
}

export class DavinciResolveAdapter extends NativeReviewAdapter {
  constructor() {
    super(EDITORS[2]!);
  }
}
