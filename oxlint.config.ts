import { defineConfig } from "oxlint";

export default defineConfig({
  options: {
    denyWarnings: true,
    typeAware: true,
    typeCheck: true,
    reportUnusedDisableDirectives: "warn",
  },
});
