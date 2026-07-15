import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Old dashboard routes were replaced by the Explore drill-down.
  async redirects() {
    return [
      ...["/overview", "/departments", "/people"].map((source) => ({
        source,
        destination: "/explore",
        permanent: false,
      })),
      // Renamed 2026-07-15 — keep old bookmarks working.
      { source: "/cursor-models", destination: "/cursor", permanent: false },
    ];
  },
};

export default nextConfig;
