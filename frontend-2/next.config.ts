import type { NextConfig } from "next";
// NEXT_DIST_DIR lets a second dev/test server run without touching the main .next folder.
const nextConfig: NextConfig = {
  reactStrictMode: true,
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // The Create project page was removed: old bookmarks go to the quotation page.
  async redirects() {
    return [{ source: "/create", destination: "/clients/new", permanent: false }];
  },
};
export default nextConfig;
