import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages serves project pages from /<repo>/, so the build needs that
// base path; local dev keeps serving from /.
export default defineConfig({
  base: process.env.GITHUB_PAGES ? "/swipe-app/" : "/",
  plugins: [react()],
});
