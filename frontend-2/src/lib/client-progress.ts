// How a project's stage is shown to a client (pure: no I/O), shared by the server and the screens.
import { STAGE_LABELS, type Stage } from "./business/types";

/** The steps a client sees, in order. "Lost" is not a step: it is shown as closed. */
export const PROGRESS_STEPS: { stage: Stage; label: string }[] = [
  { stage: "requirement", label: "Request received" },
  { stage: "quoted", label: "Quotation ready" },
  { stage: "approved", label: "Approved" },
  { stage: "advance_paid", label: "Advance paid" },
  { stage: "in_development", label: "In development" },
  { stage: "testing", label: "Testing" },
  { stage: "demo_ready", label: "Demo ready" },
  { stage: "final_paid", label: "Fully paid" },
  { stage: "delivered", label: "Delivered" },
];

export const stepLabel = (stage: Stage): string => (stage === "lost" ? "Closed" : (PROGRESS_STEPS.find((s) => s.stage === stage)?.label ?? STAGE_LABELS[stage]));

/** Where a stage sits in the steps (0 to 8), or -1 for a closed request. */
export const progressIndex = (stage: Stage): number => PROGRESS_STEPS.findIndex((s) => s.stage === stage);

/** What the client should do or expect next, in a sentence. */
export function nextStepFor(stage: Stage): { text: string; action: "review" | "pay" | "demo" | null } {
  switch (stage) {
    case "requirement": return { text: "We are preparing your quotation.", action: null };
    case "quoted": return { text: "Your quotation is ready. Review it and approve it to go ahead.", action: "review" };
    case "approved": return { text: "Pay the advance so development can start.", action: "pay" };
    case "advance_paid": return { text: "Your advance is received. Development starts soon.", action: null };
    case "in_development": return { text: "Your project is being built.", action: null };
    case "testing": return { text: "Your project is being tested.", action: null };
    case "demo_ready": return { text: "Your private demo is ready to look at.", action: "demo" };
    case "final_paid": return { text: "Everything is paid. Final delivery is next.", action: null };
    case "delivered": return { text: "Your project has been delivered.", action: null };
    case "lost": return { text: "This request is closed.", action: null };
  }
}

