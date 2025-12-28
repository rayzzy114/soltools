#!/usr/bin/env tsx
/**
 * создание production архива для заказчика
 * 
 * запуск: pnpm tsx scripts/create-archive.ts
 */

import * as fs from "fs"
import * as path from "path"
import archiver from "archiver"

interface ArchiveConfig {
  excludeDirs: string[]
  excludeFiles: string[]
  excludePatterns: RegExp[]
}

const config: ArchiveConfig = {
  excludeDirs: [
    "node_modules",
    ".git",
    ".cursor",
    ".next",
    "dist",
    "coverage",
    ".vscode",
    ".idea",
    "__pycache__",
  ],
  excludeFiles: [
    ".env",
    ".env.local",
    ".env.production.local",
    ".env.development.local",
    "test-env.txt",
    ".DS_Store",
    "Thumbs.db",
  ],
  excludePatterns: [
    /\.log$/,
    /\.tmp$/,
    /\.swp$/,
    /\.swo$/,
    /~$/,
  ],
}

function shouldExclude(filePath: string, stats: fs.Stats): boolean {
  const relativePath = path.relative(process.cwd(), filePath)
  const parts = relativePath.split(path.sep)

  // проверка директорий
  for (const part of parts) {
    if (config.excludeDirs.includes(part)) {
      return true
    }
  }

  // проверка файлов
  const fileName = path.basename(filePath)
  if (config.excludeFiles.includes(fileName)) {
    return true
  }

  // проверка паттернов
  for (const pattern of config.excludePatterns) {
    if (pattern.test(fileName)) {
      return true
    }
  }

  return false
}

function addDirectoryToArchive(
  archive: archiver.Archiver,
  dirPath: string,
  basePath: string = process.cwd()
): void {
  const files = fs.readdirSync(dirPath)

  for (const file of files) {
    const filePath = path.join(dirPath, file)
    const relativePath = path.relative(basePath, filePath)
    const stats = fs.statSync(filePath)

    if (shouldExclude(filePath, stats)) {
      continue
    }

    if (stats.isDirectory()) {
      addDirectoryToArchive(archive, filePath, basePath)
    } else {
      archive.file(filePath, { name: relativePath })
    }
  }
}

async function createArchive(): Promise<void> {
  const date = new Date().toISOString().split("T")[0]
  const archiveName = `pumpfun-panel-production-${date}.zip`
  const outputPath = path.join(process.cwd(), archiveName)

  // удаляем старый архив если есть
  if (fs.existsSync(outputPath)) {
    fs.unlinkSync(outputPath)
    console.log(`🗑️  удален старый архив: ${archiveName}`)
  }

  const output = fs.createWriteStream(outputPath)
  const archive = archiver("zip", {
    zlib: { level: 9 }, // максимальное сжатие
  })

  return new Promise((resolve, reject) => {
    output.on("close", () => {
      const sizeMB = (archive.pointer() / (1024 * 1024)).toFixed(2)
      console.log(`\n✅ АРХИВ СОЗДАН УСПЕШНО\n`)
      console.log(`📦 Имя: ${archiveName}`)
      console.log(`📊 Размер: ${sizeMB} MB`)
      console.log(`📁 Путь: ${outputPath}\n`)
      resolve()
    })

    archive.on("error", (err) => {
      console.error("❌ ошибка создания архива:", err)
      reject(err)
    })

    archive.pipe(output)

    console.log("📦 добавление файлов в архив...\n")

    // добавляем директории
    const dirsToAdd = [
      "app",
      "components",
      "lib",
      "prisma",
      "public",
      "scripts",
      "tests",
      "hooks",
      "styles",
      "assets",
    ]

    for (const dir of dirsToAdd) {
      const dirPath = path.join(process.cwd(), dir)
      if (fs.existsSync(dirPath)) {
        const stats = fs.statSync(dirPath)
        if (stats.isDirectory() && !shouldExclude(dirPath, stats)) {
          console.log(`   ✅ ${dir}/`)
          archive.directory(dirPath, dir)
        }
      }
    }

    // добавляем конфигурационные файлы
    const configFiles = [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "tsconfig.json",
      "next.config.mjs",
      "tailwind.config.ts",
      "postcss.config.mjs",
      "vitest.config.ts",
      "prisma.config.ts",
      "components.json",
      "next-env.d.ts",
    ]

    for (const file of configFiles) {
      const filePath = path.join(process.cwd(), file)
      if (fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath)
        if (!shouldExclude(filePath, stats)) {
          console.log(`   ✅ ${file}`)
          archive.file(filePath, { name: file })
        }
      }
    }

    // добавляем документацию
    try {
      const docFiles = fs.readdirSync(process.cwd()).filter((file) => {
        const filePath = path.join(process.cwd(), file)
        if (!fs.existsSync(filePath)) return false
        const stats = fs.statSync(filePath)
        if (stats.isDirectory()) return false
        return (file.endsWith(".md") || file.endsWith(".txt")) && !shouldExclude(filePath, stats)
      })

      for (const file of docFiles) {
        const filePath = path.join(process.cwd(), file)
        console.log(`   ✅ ${file}`)
        archive.file(filePath, { name: file })
      }
    } catch (error) {
      console.warn("⚠️  ошибка при добавлении документации:", error)
    }

    console.log("\n🔨 создание архива...")
    archive.finalize()
  })
}

// запуск
createArchive().catch((error) => {
  console.error("❌ ошибка:", error)
  process.exit(1)
})
