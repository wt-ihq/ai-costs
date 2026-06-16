import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root: a stray lockfile in $HOME otherwise confuses
  // Next's root inference. `import.meta.dirname` is ESM-safe (the config is
  // evaluated as ESM at build AND in the serverless runtime — `__dirname`
  // throws there).
  turbopack: {
    root: import.meta.dirname,
  },
};

export default nextConfig;
