import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.js";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      setupFiles: ["./src/test/setup.js"],
      include: ["src/**/*.test.{js,jsx}"],
      env: {
        VITE_API_URL: "http://api.test/api",
      },
      clearMocks: true,
      restoreMocks: true,
    },
  }),
);
