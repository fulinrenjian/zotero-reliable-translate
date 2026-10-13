import { defineConfig } from "zotero-plugin-scaffold";
import pkg from "./package.json";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export default defineConfig({
  source: ["src", "addon"],
  dist: "build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  // Zotero requires a secure update URL even for manual local distributions.
  // A loopback placeholder keeps this fork independent of remote releases.

  server: {
    asProxy: false,
  },

  test: {
    hooks: {
      // test/gptApiFormat.test.ts sends its requests to this mock server. It
      // runs in the tester's process, so it stops when the tests exit.
      "test:init": async () => {
        const { startMockLLMServer } =
          await import("./test/mock-llm-server.mjs");
        await startMockLLMServer();
      },
    },
  },

  build: {
    assets: ["addon/**/*.*"],
    // Avoid the scaffold's asynchronous manifest write and upstream update URL.
    makeManifest: { enable: false },
    hooks: {
      // Both Zotero's required-field and HTTPS checks must pass. This fork has
      // no updater server; startup disables background updates for its own ID.
      "build:makeManifest": (ctx) => {
        const path = join(ctx.dist, "addon", "manifest.json");
        const manifest = JSON.parse(readFileSync(path, "utf8"));
        manifest.applications.zotero.update_url =
          "https://127.0.0.1:65535/reliabletranslate/updates.json";
        writeFileSync(path, JSON.stringify(manifest, null, 2));
      },
    },
    define: {
      ...pkg.config,
      author: pkg.author,
      description: pkg.description,
      homepage: pkg.homepage,
      buildVersion: pkg.version,
      buildTime: "{{buildTime}}",
    },
    esbuildOptions: [
      {
        entryPoints: [
          { in: "src/index.ts", out: pkg.config.addonRef },
          { in: "src/extras/*.*", out: "" },
        ],
        define: {
          __env__: `"${process.env.NODE_ENV}"`,
        },
        bundle: true,
        target: "firefox115",
        outdir: "build/addon/chrome/content/scripts",
      },
    ],
    // If you want to checkout update.json into the repository, uncomment the following lines:
    // makeUpdateJson: {
    //   hash: false,
    // },
    // hooks: {
    //   "build:makeUpdateJSON": (ctx) => {
    //     copyFileSync("build/update.json", "update.json");
    //     copyFileSync("build/update-beta.json", "update-beta.json");
    //   },
    // },
  },
  // release: {
  //   bumpp: {
  //     execute: "npm run build",
  //   },
  // },

  // If you need to see a more detailed build log, uncomment the following line:
  // logLevel: "trace",
});
