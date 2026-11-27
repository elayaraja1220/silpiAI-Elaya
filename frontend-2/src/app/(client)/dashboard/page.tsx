import { permanentRedirect } from "next/navigation";

/** The old address of the Fixed Price dashboard. Each application has its own dashboard now (/client/dashboard here, /ai/dashboard for the AI workspace); this keeps old links and bookmarks working. */
export default function Page() {
  permanentRedirect("/client/dashboard");
}
