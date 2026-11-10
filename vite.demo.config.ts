import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const demoRoot = fileURLToPath(new URL("./demo/", import.meta.url));

export default defineConfig({
  root: demoRoot,
  // Demo builds do not load the private deployment's environment files.
  envDir: demoRoot,
  envPrefix: "YUVO_DEMO_",
  publicDir: fileURLToPath(new URL("./public/", import.meta.url)),
  plugins: [react()],
  define: {
    "process.env.NEXT_PUBLIC_DEMO_MODE": JSON.stringify("true"),
  },
  build: {
    outDir: fileURLToPath(new URL("./dist-demo/", import.meta.url)),
    emptyOutDir: true,
  },
});
