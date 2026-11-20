import { buildUIPage, buildHostPage } from "./ui-page-nosentry.mjs";

await buildUIPage({
  name: "ui/mcp-app", entry: "packages/mcp-app/src/main.tsx", template: "packages/mcp-app/src/index.html",
  sources: ["packages/ui/src", "packages/mcp-app/src"], output: "dist/app.html",
  environment: "release", sourceURL: "app:///mobile-dev-ui.js",
});
await buildHostPage({ entry: "packages/mcp-app/src/browser-panel.ts", template: "packages/mcp-app/src/browser-panel.html", output: "dist/browser-panel.html" });
console.log("panel built");
