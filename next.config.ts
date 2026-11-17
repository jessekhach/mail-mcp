import type { NextConfig } from "next";

// The Docker build sets NEXT_OUTPUT=standalone for a small image; Vercel builds normally.
const config: NextConfig = {
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
};

export default config;
