# Solana Launch & Volume Bundler

A high-performance, full-stack application for orchestrating Solana token launches, managing volume bots, and handling complex wallet operations using Jito bundles for guaranteed execution. Built with Next.js 15, React 19, and Prisma.

## 🚀 Features

### 🛠️ Bundler Engine
- **Token Launch**: Create and buy tokens in a single atomic Jito bundle.
- **Genesis Buy**: "Clean Distribution" strategy where the Dev wallet buys first, followed by a configurable number of buyers in the same block.
- **Complex Operations**: Supports Buy, Sell, and "Rugpull" (Exit Strategy) bundles.
- **Jito Integration**: Native support for Jito Block Engine to bypass standard RPC congestion and ensure atomic execution.

### 🤖 Volume Bot
- **Automated Trading**: Generate organic-looking volume for your tokens.
- **Modes**:
  - **Stealth Mode**: Randomized delays and amounts.
  - **Warmup Mode**: Simulates activity before a launch.
- **Strategies**: Configurable intervals (Speed Mode) and trade amounts.

### 💼 Wallet Management
- **Mass Generation**: Generate hundreds of wallets instantly.
- **Stealth Funding**: Fund wallets via a proxy tree system to prevent "BubbleMaps" linking.
- **Collection**: Aggregate funds (Collect SOL) from multiple wallets back to a main wallet.
- **Auto-ATA**: Automatically create Associated Token Accounts.

### ⚡ Advanced Architecture
- **Dual-Lane RPC System**:
  - **Safe Lane**: Rate-limited connection for UI/Read operations (handles 429s gracefully with a global pause).
  - **Exec Lane**: Dedicated, unthrottled lane for critical execution transactions.
- **Real-time Dashboard**: Interactive UI for monitoring bots, balances, and launch status.

## 🛠️ Tech Stack

- **Frontend**: Next.js 15 (App Router), React 19, Tailwind CSS, shadcn/ui.
- **Backend**: Next.js API Routes, Prisma ORM, PostgreSQL.
- **Blockchain**: `@solana/web3.js`, `@coral-xyz/anchor`, `jito-ts`.
- **Testing**: Vitest (Unit), Playwright (E2E).

## 📋 Prerequisites

- **Node.js**: Version 23.0.0 or higher.
- **Package Manager**: `pnpm` (strictly required; `npm` and `yarn` are prohibited).
- **Database**: PostgreSQL.
- **Solana RPC**: A valid Solana RPC URL (supporting Jito UUIDs).

## 📦 Installation

1. **Clone the repository:**
   ```bash
   git clone <repository-url>
   cd <project-directory>
   ```

2. **Install dependencies:**
   ```bash
   pnpm install
   ```
   > **Note:** Do not use `npm install` or `yarn install`.

3. **Configure Environment:**
   Copy `.env.example` to `.env` and fill in the required variables:
   ```bash
   cp .env.example .env
   ```
   *   `DATABASE_URL`: Connection string for your PostgreSQL database.
   *   `RPC`: Your Solana RPC URL.
   *   `JITO_AUTH_KEYPAIR`: (Optional) Auth keypair for Jito.

4. **Initialize Database:**
   ```bash
   pnpm db:generate
   pnpm db:push
   ```

## 🚀 Usage

### Development
Start the development server:
```bash
pnpm dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

### Production
Build and start the production server:
```bash
pnpm build
pnpm start
```

### Testing
- **Unit Tests**: `pnpm test`
- **E2E Tests**: `pnpm test:e2e`

## ⚠️ Important Notes

- **Windows Users**: The `build` and `dev` scripts in `package.json` use `cmd /c` syntax. If you are on Linux or macOS, `pnpm` generally handles this, but if you encounter issues, you may need to run the underlying commands manually (e.g., `next dev --turbopack`).
- **RPC Limits**: The application respects rate limits via the "Safe Lane". If you see "Pausing all traffic", it is a protective measure against 429 errors.
- **Jito Tips**: Ensure your "Dev" wallet has enough SOL to cover Jito tip floors (p75) for bundle processing.

## 🤝 Contributing

1. Ensure all code passes linting: `pnpm lint`
2. Run tests before submitting: `pnpm test`
