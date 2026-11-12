"use client";

import { useCallback, useEffect, useState } from "react";

import type { AgentInfo, Project, ProjectsResponse } from "@/types";

/** Loads the projects the SILPI agent has generated on this machine. */
export function useProjects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [agent, setAgent] = useState<AgentInfo | null>(null);
  const [outputRoot, setOutputRoot] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/projects", { cache: "no-store" });
      const data = (await response.json()) as ProjectsResponse;
      setProjects(data.projects ?? []);
      setAgent(data.agent ?? null);
      setOutputRoot(data.outputRoot);
      if (!data.success) setError(data.error ?? "Could not load projects.");
    } catch {
      setError("Could not reach the projects API.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // While any project is still generating, refresh quietly every 10 seconds.
  const generating = projects.some((p) => p.status === "Generating");
  useEffect(() => {
    if (!generating) return;
    const timer = setInterval(async () => {
      try {
        const response = await fetch("/api/projects", { cache: "no-store" });
        const data = (await response.json()) as ProjectsResponse;
        if (data.success) setProjects(data.projects);
      } catch {
        /* keep the current list */
      }
    }, 10_000);
    return () => clearInterval(timer);
  }, [generating]);

  return { projects, agent, outputRoot, error, loading, reload };
}
