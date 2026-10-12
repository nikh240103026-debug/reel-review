import { FfmpegAdapter } from "./ffmpeg";
import { ManualAdapter } from "./manual";
import { AfterEffectsAdapter, DavinciResolveAdapter, PremiereProAdapter } from "./native-review";
import type { AdapterCapabilities, EditorAdapter } from "./types";

export function createAdapters(): EditorAdapter[] {
  return [new ManualAdapter(), new FfmpegAdapter(), new PremiereProAdapter(), new AfterEffectsAdapter(), new DavinciResolveAdapter()];
}

/** Capabilities of every adapter, plus the list this device can actually run. */
export async function detectCapabilities(adapters: EditorAdapter[]) {
  const caps: AdapterCapabilities[] = [];
  for (const a of adapters) caps.push(await a.getCapabilities());
  const available = caps.filter((c) => c.implemented && c.supportedOps.length > 0).map((c) => c.id);
  return { caps, available };
}
