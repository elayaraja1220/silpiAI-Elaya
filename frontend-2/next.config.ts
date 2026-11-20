import type { NextConfig } from "next";
// NEXT_DIST_DIR lets a second dev/test server run without touching the main .next folder.
const nextConfig: NextConfig = { reactStrictMode: true, distDir: process.env.NEXT_DIST_DIR || ".next" };
export default nextConfig;
