#!/usr/bin/env node
/**
 * Rebuild vendored bloub + morphicons ESM bundles.
 * Run from apps/openlive-gateway/web: `npm run vendor`
 */
import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["vendor/bloub/entry.js"],
  bundle: true,
  format: "esm",
  outfile: "vendor/bloub/engine.js",
  target: ["es2022"],
  legalComments: "inline",
});

await esbuild.build({
  entryPoints: ["vendor/morphicons-entry.js"],
  bundle: true,
  format: "esm",
  outfile: "vendor/morphicons.js",
  target: ["es2022"],
  legalComments: "inline",
});

console.log("vendored bloub + morphicons");
