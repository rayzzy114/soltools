const { execSync } = require("child_process")

if (process.env.PRISMA_GENERATE_SKIP_POSTINSTALL === "1") {
  console.log("prisma generate skipped (PRISMA_GENERATE_SKIP_POSTINSTALL=1)")
  process.exit(0)
}

let success = false
try {
  execSync("pnpm exec prisma generate --schema prisma/schema.prisma", {
    stdio: "inherit",
    timeout: 12000,
  })
  success = true
} catch (error) {
  console.warn("[postinstall] prisma generate failed/timeout, skipping.")
  console.warn(error?.message || error)
}
process.exit(0)

