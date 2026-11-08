import path from "node:path";
import type { NextConfig } from "next";

// Pin the workspace root to this repo. Without it Next walks up looking for the
// "closest" lockfile and, if a parent directory (e.g. a home dir) has its own
// package.json/lockfile/node_modules, resolves a second copy of React from
// there -> "Cannot read properties of null (reading 'useInsertionEffect')".
const root = path.resolve(__dirname);

const nextConfig: NextConfig = {
  transpilePackages: ["@kings-cup/shared"],
  turbopack: { root },
  outputFileTracingRoot: root,
};

export default nextConfig;
