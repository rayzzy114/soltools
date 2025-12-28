import { NextRequest, NextResponse } from "next/server"
import { exec } from "child_process"
import { promisify } from "util"

const execAsync = promisify(exec)

// GET - получить результаты тестов
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const action = searchParams.get("action")

    if (action === "run") {
      const startedAt = Date.now()
      const suite = searchParams.get("suite") || "smoke"
      const commandMap: Record<string, string> = {
        smoke: "pnpm vitest run tests/api/health.test.ts --silent --watch=false --pool=threads --maxWorkers=1 --minWorkers=1 --testTimeout=30000",
        api: "pnpm test:api",
        unit: "pnpm test:unit",
        integration: "pnpm test:integration",
      }
      const command = commandMap[suite] || commandMap.smoke
      const timeoutMs = suite === "unit" || suite === "integration" ? 180_000 : 90_000

      // запуск тестов
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: process.cwd(),
          timeout: timeoutMs,
        })

        // парсим результаты
        const lines = stdout.split("\n")
        const passedMatch = stdout.match(/(\d+)\s+passed/)
        const failedMatch = stdout.match(/(\d+)\s+failed/)

        return NextResponse.json({
          success: true,
          durationMs: Date.now() - startedAt,
          passed: passedMatch ? parseInt(passedMatch[1]) : 0,
          failed: failedMatch ? parseInt(failedMatch[1]) : 0,
          output: stdout,
          error: stderr || null,
        })
      } catch (error: any) {
        return NextResponse.json({
          success: false,
          durationMs: Date.now() - startedAt,
          error: error.message,
          output: error.stdout || "",
        }, { status: 500 })
      }
    }

    // возвращаем демо данные (реальные данные будут из vitest)
    return NextResponse.json({
      totalTests: 300,
      passedTests: 300,
      failedTests: 0,
      totalSuites: 11,
      passedSuites: 11,
      coverage: 87,
      modules: [
        { name: "pump.fun SDK", tests: 50, passed: 50, failed: 0, coverage: 92 },
        { name: "Volume Bot Engine", tests: 45, passed: 45, failed: 0, coverage: 89 },
        { name: "Bundler", tests: 25, passed: 25, failed: 0, coverage: 85 },
        { name: "MEV Protection", tests: 20, passed: 20, failed: 0, coverage: 88 },
        { name: "Anti-Detection", tests: 35, passed: 35, failed: 0, coverage: 90 },
        { name: "Triggers Engine", tests: 30, passed: 30, failed: 0, coverage: 86 },
        { name: "Graduation Sniper", tests: 18, passed: 18, failed: 0, coverage: 84 },
        { name: "Jito Integration", tests: 15, passed: 15, failed: 0, coverage: 87 },
        { name: "LUT Optimization", tests: 22, passed: 22, failed: 0, coverage: 83 },
        { name: "API Routes", tests: 20, passed: 20, failed: 0, coverage: 91 },
        { name: "Integration Tests", tests: 20, passed: 20, failed: 0, coverage: 85 },
      ],
    })
  } catch (error: any) {
    console.error("tests API error:", error)
    return NextResponse.json({ error: error.message || "internal server error" }, { status: 500 })
  }
}
