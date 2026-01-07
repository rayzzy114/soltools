# SolTools Project Context

## Project Overview

**SolTools** is a comprehensive Solana development and automation dashboard designed for token launches, volume generation, and liquidity management on the **pump.fun** platform. It utilizes **Next.js 15** for the full-stack application and **Prisma** with PostgreSQL for state management.

Key capabilities include:
*   **Token Launch Bundler:** Atomic token creation and initial buying using **Jito** bundles to prevent sniping.
*   **Volume Bot:** Automated buy/sell operations to generate organic-looking activity.
*   **Wallet Management:** Generation, funding (CEX integration), and management of multiple "sniper" or "volume" wallets.
*   **Atomic Rugpull:** Mechanism to sell all tokens across multiple wallets in a single bundle.
*   **Real-time Analytics:** Dashboard for monitoring token price, market cap, and wallet PnL.

## Technology Stack

*   **Framework:** [Next.js 15](https://nextjs.org/) (App Router)
*   **Language:** TypeScript
*   **Database:** PostgreSQL (via [Prisma ORM](https://www.prisma.io/))
*   **Styling:** Tailwind CSS + Shadcn UI
*   **Blockchain:** `@solana/web3.js`, `@solana/spl-token`
*   **MEV/Bundles:** `jito-ts` (Jito Block Engine integration)
*   **Testing:** Vitest (Unit/Integration), Playwright (E2E)

## Architecture & Key Directories

*   **`app/`**: Next.js App Router structure.
    *   `app/api/`: Backend API endpoints (`bundler`, `volume-bot`, `stats`, etc.).
    *   `app/dashboard/`: Main dashboard UI page.
    *   `app/wallet-tools/`: Wallet management UI.
*   **`lib/`**: Core business logic.
    *   `lib/solana/`: Solana-specific modules.
        *   `bundler-engine.ts`: Core logic for constructing and sending Jito bundles.
        *   `pumpfun-sdk.ts`: Interaction with pump.fun bonding curves and migration logic.
        *   `jito.ts`: Jito block engine client and tip calculation.
        *   `volume-bot-engine.ts`: Logic for the automated trading bot.
    *   `lib/cex/`: Centralized Exchange integration (e.g., OKX funding).
    *   `lib/prisma.ts`: Database client instance.
*   **`prisma/`**: Database schema (`schema.prisma`) and migrations.
*   **`scripts/`**: Standalone TypeScript scripts for maintenance, simulation, and devnet setup.
*   **`tests/`**: Comprehensive test suites (Unit, Integration, E2E).

## Getting Started

### 1. Prerequisites
*   Node.js >= 23.0.0
*   PostgreSQL Database (local or remote)
*   Solana RPC URL (Helius, QuickNode, etc.)

### 2. Installation
```bash
pnpm install
```

### 3. Configuration
Copy `.env.example` to `.env` and configure:
*   `DATABASE_URL`: PostgreSQL connection string.
*   `RPC_URL`: Solana RPC endpoint.
*   `JITO_AUTH_KEYPAIR`: Auth key for Jito Block Engine (optional but recommended).
*   `OKX_API_KEY` etc.: For CEX funding (optional).

### 4. Database Setup
Sync the database schema with your local database:
```bash
npx prisma db push
npx prisma generate
```

### 5. Running the App
Start the development server:
```bash
npm run dev
```
The app will be available at `http://localhost:3000`.

## Development Commands

| Command | Description |
| :--- | :--- |
| `npm run dev` | Start development server with Turbopack |
| `npm run build` | Build the application for production |
| `npm run test` | Run Vitest unit and integration tests |
| `npm run test:e2e` | Run Playwright end-to-end tests |
| `npx prisma studio` | Open Prisma Studio GUI to manage DB data |

## Core Concepts

### Jito Bundling
The project heavily relies on Jito bundles to ensure transaction atomicity and complex sequences (e.g., "Launch + Buy" in the same block). The `bundler-engine.ts` handles splitting transactions into sequential bundles if the number of wallets exceeds the Jito limit (5 transactions per bundle).

### Volume Bot Logic
The volume bot (`volume-bot-engine.ts`) runs as a background process (or via cron/API trigger). It manages a set of "sub-wallets" to buy and sell tokens at random intervals, mimicking human behavior. State is persisted in Postgres to recover from restarts.

### Anti-BubbleMaps
The launch logic includes specific measures to avoid linking wallets on-chain, such as using different payers for split bundles and randomized funding patterns.

## Contribution Guidelines
*   **Testing:** All core logic changes (especially in `lib/solana`) must be accompanied by unit tests in `tests/`. Run `npm run test` to verify.
*   **Linting:** Use `npm run lint` to check for code style issues.
*   **Conventions:** Follow the existing "Service/Controller" pattern where API routes delegate logic to `lib/` modules.

# Modern Rust-based CLI Tools 🦀

Инструкция по замене стандартных Unix-инструментов на быстрые аналоги, написанные на Rust.

## Сравнение инструментов

| Старая утилита | Rust-альтернатива | Описание |
| :--- | :--- | :--- |
| `grep` | **rg** (ripgrep) | Самый быстрый поиск по тексту, уважает .gitignore |
| `cat` | **bat** | Просмотр файлов с подсветкой синтаксиса и интеграцией с Git |
| `ls` | **eza** | Современный `ls` с иконками, цветами и деревом (преемник `exa`)  |
| `find` | **fd** | Простой и быстрый поиск файлов по имени |
| `cd` | **zoxide** | Умный переход по папкам, запоминающий историю  |
| `top` / `htop` | **btm** (bottom) | Графический мониторинг системы в терминале  |
| `ps` | **procs** | Современный список процессов с поиском и цветами  |
| `du` | **dust** | Анализ занимаемого места на диске с визуализацией  |
| `sed` | **sd** | Интуитивный поиск и замена в файлах  |
| `curl` / `wget` | **xh** | Удобный инструмент для HTTP-запросов  |
| `man` | **tealdeer** | Очень быстрый `tldr` (краткие справки с примерами)  |

## Установка (через Cargo)

Так как вы разработчик, проще всего установить всё через Rust пакетный менеджер:

```bash
cargo install ripgrep bat eza fd-find zoxide bottom procs du-dust sd xh tealdeer
