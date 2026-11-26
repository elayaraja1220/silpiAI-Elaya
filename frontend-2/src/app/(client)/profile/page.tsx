import type { Metadata } from "next";

import { ProfileForm } from "@/components/client/profile-form";
import { requireClient } from "@/server/client-page";

export const metadata: Metadata = { title: "Profile · SILPI AI", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** The client's own account: details, password, connected sign-in methods. */
export default async function Page() {
  await requireClient("/profile");
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div><p className="text-xs font-medium uppercase tracking-[.18em] text-violet-300">Profile</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">Your account</h1></div>
      <ProfileForm />
    </div>
  );
}
