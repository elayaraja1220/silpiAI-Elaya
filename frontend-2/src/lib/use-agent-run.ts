"use client";

import { useCallback, useRef, useState } from "react";

import type { AgentAttachment, AgentEvent } from "@/types";

export type RunStatus = "idle" | "running" | "success" | "failed";

export type RunTotals = { inputTokens: number; outputTokens: number; cacheReadTokens: number; turns: number };

/** Starts a SILPI agent run and collects its streamed NDJSON events. */
export function useAgentRun() {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [status, setStatus] = useState<RunStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Extract<AgentEvent, { type: "done" }> | null>(null);
  const [totals, setTotals] = useState<RunTotals>({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, turns: 0 });
  const running = useRef(false);

  const reset = useCallback(() => {
    setEvents([]);
    setStatus("idle");
    setError(null);
    setResult(null);
    setTotals({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, turns: 0 });
  }, []);

  const start = useCallback(
    async (url: string, body: unknown): Promise<boolean> => {
      if (running.current) return false;
      running.current = true;
      reset();
      setStatus("running");

      let finalOk = false;
      let sawError: string | null = null;

      const handle = (event: AgentEvent) => {
        setEvents((list) => [...list, event]);
        if (event.type === "usage") {
          setTotals((t) => ({
            inputTokens: t.inputTokens + event.inputTokens + event.cacheWriteTokens,
            outputTokens: t.outputTokens + event.outputTokens,
            cacheReadTokens: t.cacheReadTokens + event.cacheReadTokens,
            turns: event.turn,
          }));
        } else if (event.type === "done") {
          setResult(event);
          finalOk = event.success;
        } else if (event.type === "error") {
          sawError = event.message;
          setError(event.message);
        }
      };

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (!response.ok || !response.body) {
          const data = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error || `Request failed (${response.status}).`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index: number;
          while ((index = buffer.indexOf("\n")) >= 0) {
            const raw = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            if (raw) {
              try {
                handle(JSON.parse(raw) as AgentEvent);
              } catch {
                /* ignore malformed line */
              }
            }
          }
        }
        if (buffer.trim()) {
          try {
            handle(JSON.parse(buffer) as AgentEvent);
          } catch {
            /* ignore */
          }
        }
      } catch (err) {
        sawError = err instanceof Error ? err.message : "Could not reach the SILPI agent.";
        setError(sawError);
      } finally {
        running.current = false;
        setStatus(finalOk && !sawError ? "success" : "failed");
      }
      return finalOk;
    },
    [reset],
  );

  return { events, status, error, result, totals, start, reset };
}

const TEXT_TYPES: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
};
const BINARY_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

export const ACCEPTED_ATTACHMENTS = Object.keys({ ...BINARY_TYPES, ...TEXT_TYPES })
  .map((ext) => `.${ext}`)
  .join(",");

export function attachmentType(fileName: string): string | null {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  return BINARY_TYPES[ext] ?? TEXT_TYPES[ext] ?? null;
}

/** Read browser File objects into base64 attachments for the agent. */
export async function toAttachments(files: File[]): Promise<AgentAttachment[]> {
  return Promise.all(
    files.map(async (file) => {
      const mediaType = attachmentType(file.name);
      if (!mediaType) throw new Error(`"${file.name}" is not a supported file type.`);
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      return { name: file.name, mediaType, data: btoa(binary) };
    }),
  );
}
