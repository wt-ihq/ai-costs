import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Old dashboard routes were replaced by the Explore drill-down.
  async redirects() {
    return ["/overview", "/departments", "/people"].map((source) => ({
      source,
      destination: "/explore",
      permanent: false,
    }));
  },
};

export default nextConfig;
