import { LeadDetailPage } from "@/components/studio/clients";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <LeadDetailPage id={id} />;
}
