/**
 * Test Runner with Visual Output
 * 
 * Run: npx tsx scripts/run-tests.ts
 */

import { spawn } from "child_process"
import path from "path"

const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
}

function c(color: keyof typeof colors, text: string): string {
  return `${colors[color]}${text}${colors.reset}`
}

async function runCommand(command: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      stdio: "inherit",
      shell: true,
      cwd: path.join(__dirname, ".."),
    })
    
    proc.on("close", (code) => {
      resolve(code || 0)
    })
  })
}

async function main(): Promise<void> {
  console.log()
  console.log(c("cyan", "═".repeat(60)))
  console.log(c("bright", "  🧪 PUMP.FUN PANEL TEST SUITE"))
  console.log(c("cyan", "═".repeat(60)))
  console.log()
  
  const testSuites = [
    { name: "Unit Tests", command: "pnpm", args: ["exec", "vitest", "run", "tests/unit", "--reporter=verbose"] },
    { name: "Integration Tests", command: "pnpm", args: ["exec", "vitest", "run", "tests/integration", "--reporter=verbose"] },
    { name: "API Tests", command: "pnpm", args: ["exec", "vitest", "run", "tests/api", "--reporter=verbose"] },
  ]
  
  let passed = 0
  let failed = 0
  
  for (const suite of testSuites) {
    console.log(c("yellow", `\n▶ Running ${suite.name}...\n`))
    
    const code = await runCommand(suite.command, suite.args)
    
    if (code === 0) {
      console.log(c("green", `\n✓ ${suite.name} passed`))
      passed++
    } else {
      console.log(c("red", `\n✗ ${suite.name} failed`))
      failed++
    }
  }
  
  console.log()
  console.log(c("cyan", "═".repeat(60)))
  console.log(c("bright", "  TEST SUMMARY"))
  console.log(c("cyan", "═".repeat(60)))
  console.log(`  ${c("green", `✓ ${passed} passed`)}`)
  console.log(`  ${c("red", `✗ ${failed} failed`)}`)
  console.log(c("cyan", "═".repeat(60)))
  console.log()
  
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(console.error)
