import { PageHeader } from "@/components/app-shell";
import { getSystemStatus } from "@/lib/services/system";
import { listDevices } from "@/lib/services/devices";
import { SettingsView } from "./settings-view";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const [status, devices] = await Promise.all([getSystemStatus({ probeStorage: true }), listDevices()]);
  return (
    <>
      <PageHeader title="Settings" description="Storage, integrations, editor access and registered editing devices." />
      <SettingsView status={status} devices={devices} />
    </>
  );
}
