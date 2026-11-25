/**
 * When may the business APIs be used WITHOUT an admin sign-in? (pure: no I/O)
 *
 * SILPI began as a tool on the owner's own computer, so its business APIs were open. They must not stay open once the
 * server can be reached by anyone else. The rule, in order:
 *   1. SILPI_API_AUTH=required         -> always sign in.
 *   2. a production build              -> sign in, unless SILPI_API_AUTH=local says the owner runs it privately.
 *   3. the request names a host other than localhost, or the connection did not come from this computer -> sign in.
 *   4. otherwise (dev server, opened as localhost)  -> open, as before.
 *
 * "Came from this computer" uses x-forwarded-for. Next.js fills it with the connecting address when the client sends
 * none, and a real reverse proxy puts the visitor's address in it, so every address listed must be a loopback address.
 *
 * KNOWN LIMIT (tested against a running dev server): Next.js keeps an x-forwarded-for the CLIENT sent. Someone on the
 * same network who reaches the dev server by its LAN address and sends "Host: localhost" plus
 * "X-Forwarded-For: 127.0.0.1" is treated as local. Middleware cannot see the real socket address. So this rule keeps
 * honest traffic out (other hosts, proxies, production) but is NOT a defence against a deliberate attacker on the same
 * network. For that, either bind the dev server to this computer only (next dev -H 127.0.0.1) or set
 * SILPI_API_AUTH=required.
 */

type Env = { NODE_ENV?: string; SILPI_API_AUTH?: string };

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const LOOPBACK_ADDRESSES = new Set(["::1", "127.0.0.1", "::ffff:127.0.0.1", "localhost"]);

/** "localhost:3000" -> "localhost", "[::1]:3000" -> "[::1]". */
export function hostnameOf(host: string | null | undefined): string {
  if (!host) return "";
  const h = host.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  return h.split(":")[0];
}

/** True when the header is absent, or every address in it is a loopback address. A malformed entry counts as not local. */
export function forwardedFromThisComputer(forwardedFor: string | null | undefined): boolean {
  if (forwardedFor === null || forwardedFor === undefined || forwardedFor.trim() === "") return true;
  return forwardedFor.split(",").every((a) => LOOPBACK_ADDRESSES.has(a.trim().toLowerCase()));
}

export function localAccessAllowed(input: {
  host: string | null | undefined;
  /** The x-forwarded-for header, if present. */
  forwardedFor?: string | null;
  /** A header only a real proxy adds (x-real-ip, forwarded). */
  proxyHeader?: boolean;
  env: Env;
}): boolean {
  const mode = input.env.SILPI_API_AUTH?.trim().toLowerCase();
  if (mode === "required") return false;
  if (input.env.NODE_ENV === "production" && mode !== "local") return false;
  if (input.proxyHeader) return false;
  if (!forwardedFromThisComputer(input.forwardedFor)) return false;
  return LOCAL_HOSTS.has(hostnameOf(input.host));
}

/** Headers that only a real reverse proxy adds. (Next.js adds the x-forwarded-* family itself, so they say nothing.) */
export const PROXY_ONLY_HEADERS = ["x-real-ip", "forwarded"] as const;
