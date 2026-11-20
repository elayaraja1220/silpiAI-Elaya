"use client";

import { useRouter } from "next/navigation";

import { ProjectsPage } from "@/components/pages/projects";
import { ROUTES } from "@/lib/routes";

export default function Page() {
  const router = useRouter();
  return <ProjectsPage onNavigate={() => router.push(ROUTES.create)} />;
}
