import type { NextConfig } from "next";

// REAL, NECESSARY CONFIG — not a default scaffold. Every existing matching-engine/src/*.ts
// file (built well before this Next.js app existed) uses Node ESM-correct ".js"-suffixed
// relative imports pointing at .ts source (e.g. `from "./db.js"`) — required for the
// tsx-run CLI scripts (npm test, apply-schema.ts, etc.) to work under real Node ESM
// resolution. Turbopack (Next 16's default bundler) does NOT resolve ".js" specifiers to
// .ts files the way webpack does — confirmed via a real build failure across the entire
// src/ import graph once app/ started importing it, and via Turbopack's own tracked,
// still-open issue (vercel/next.js#82945, "support importing .ts/.tsx via .js extension
// (parity with webpack resolve.extensionAlias)"). Rewriting 20+ existing, already-tested
// src/ files' import style was the more invasive fix; webpack's resolve.extensionAlias
// solves it with zero changes to existing files instead. This is why matching-engine's real
// build/dev scripts explicitly pass --webpack (package.json) rather than relying on Next
// 16's Turbopack default.
const nextConfig: NextConfig = {
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
  // Real, deliberate override, found necessary the first time `next dev` ran in this repo:
  // Next 16 auto-generates matching-engine/AGENTS.md + a one-line matching-engine/CLAUDE.md
  // (`@AGENTS.md`) on first run. This repo already has its own authoritative, carefully
  // maintained CLAUDE.md (repo root) that Claude Code loads
  // hierarchically — a second, auto-generated CLAUDE.md sitting in this subdirectory risks
  // being read as additional/conflicting project instructions in a future session run from
  // inside matching-engine/. Both files were deleted immediately after being found; this
  // setting stops them from regenerating on the next `next dev`/`next build`.
  agentRules: false,
};

export default nextConfig;
