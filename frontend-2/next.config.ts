import type { NextConfig } from "next";
// NEXT_DIST_DIR lets a second dev/test server run without touching the main .next folder.
const nextConfig: NextConfig = {
  reactStrictMode: true,
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // The Create project page was removed: old bookmarks go to the quotation page.
  // Headers every page and answer carries. No Content-Security-Policy yet: Next.js needs nonces for its own inline scripts, which is a larger change (see docs/DEPLOYMENT.md).
  async headers() {
    const production = process.env.NODE_ENV === "production";
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          ...(production ? [{ key: "Strict-Transport-Security", value: "max-age=15552000" }] : []),
        ],
      },
    ];
  },
  async redirects() {
    return [{ source: "/create", destination: "/clients/new", permanent: false }];
  },
};
export default nextConfig;
