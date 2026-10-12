import { notFound } from "next/navigation";
import { HttpError } from "@/lib/http";
import { getProposal } from "@/lib/services/proposals";
import { listDevices } from "@/lib/services/devices";
import { ProposalEditor } from "./proposal-editor";

export const metadata = { title: "Proposal" };

export default async function ProposalPage({ params }: PageProps<"/proposals/[proposalId]">) {
  const { proposalId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(proposalId)) notFound();
  try {
    const [data, devices] = await Promise.all([getProposal(proposalId), listDevices()]);
    return <ProposalEditor initial={data} devices={devices.filter((d) => d.status === "active")} />;
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) notFound();
    throw err;
  }
}
