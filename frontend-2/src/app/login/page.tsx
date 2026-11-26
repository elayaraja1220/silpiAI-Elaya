import { redirect } from "next/navigation";

import { safeNext } from "@/lib/safe-next";

/** The old member sign-in page. One sign-in page now serves everyone: /sign-in. */
export default async function Page({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const to = typeof next === "string" ? safeNext(next, "") : "";
  redirect(to ? `/sign-in?next=${encodeURIComponent(to)}` : "/sign-in");
}
