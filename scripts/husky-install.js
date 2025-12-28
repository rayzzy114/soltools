const { execSync } = require("child_process")

try {
  execSync("pnpm exec husky install", { stdio: "inherit", timeout: 5000 })
} catch (error) {
  console.warn("[prepare] husky install skipped (non-fatal):", error?.message || error)
}
process.exit(0)

