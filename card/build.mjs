import { build } from "esbuild";

await build({
  entryPoints: ["src/card.js"],
  bundle: true,
  format: "iife",
  outfile: "../custom_components/dreame_cloud/www/dreame-vacuum-map-card.js",
  minify: false,
  keepNames: true,
  legalComments: "inline",
});
