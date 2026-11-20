"use client";

import { useRouter } from "next/navigation";

import { Dashboard } from "@/components/pages/dashboard";
import { ROUTES } from "@/lib/routes";

export default function OverviewPage() {
  const router = useRouter();
  return <Dashboard onNavigate={(view) => router.push(ROUTES[view])} />;
}
