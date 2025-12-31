"use client"
import dynamic from "next/dynamic"
import { useState, useEffect } from "react"
import { ChevronRight, LayoutDashboard, Bot, Package, Rocket, Bell, RefreshCw, Wallet, PlayCircle, BarChart3, TestTube, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useWallet } from "@solana/wallet-adapter-react"
import DashboardPage from "./dashboard/page"
import VolumeBotPage from "./volume-bot/page"
import SolanaBundlerPage from "./bundler/page"
import TokenLauncherPage from "./token-launcher/page"
import WalletToolsPage from "./wallet-tools/page"
import DevnetTestPage from "./devnet-test/page"
import DemoPage from "./demo/page"
import TestsPage from "./tests/page"
const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((mod) => mod.WalletMultiButton),
  { ssr: false }
)

export default function CryptoDashboard() {
  const [activeSection, setActiveSection] = useState("dashboard")
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const { publicKey, connected, disconnect, wallet } = useWallet()
  const [balance, setBalance] = useState<number>(0)
  const handleDisconnect = async () => {
    try {
      await disconnect()
    } catch {
      try {
        await wallet?.adapter.disconnect()
      } catch {
        // ignore
      }
    } finally {
      setBalance(0)
    }
  }

  useEffect(() => {
    if (!connected || !publicKey) {
      setBalance(0)
      return
    }
    fetch(`/api/solana/balance?publicKey=${publicKey.toBase58()}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && Number.isFinite(data.sol)) {
          setBalance(data.sol)
        }
      })
      .catch(() => {
        setBalance(0)
      })
  }, [connected, publicKey])

  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <div
        className={`${sidebarCollapsed ? "w-16" : "w-70"} bg-neutral-900 border-r border-neutral-700 transition-all duration-300 fixed md:relative z-50 md:z-auto h-full md:h-auto`}
      >
        <div className="p-4">
          <div className="flex items-center justify-between mb-8">
            <div className={`${sidebarCollapsed ? "hidden" : "block"}`}>
              <h1 className="text-cyan-400 font-bold text-lg tracking-wider">SOLANA TOOLS</h1>
              <p className="text-neutral-500 text-xs">v1.0.0 MAINNET</p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              className="text-neutral-400 hover:text-cyan-400"
            >
              <ChevronRight
                className={`w-4 h-4 sm:w-5 sm:h-5 transition-transform ${sidebarCollapsed ? "" : "rotate-180"}`}
              />
            </Button>
          </div>

          <nav className="space-y-2">
            {[
              { id: "dashboard", icon: LayoutDashboard, label: "DASHBOARD" },
              { id: "wallet-tools", icon: Wallet, label: "WALLET TOOLS" },
              { id: "volume-bot", icon: Bot, label: "VOLUME BOT" },
              { id: "bundler", icon: Package, label: "SOLANA BUNDLER" },
              { id: "token-launcher", icon: Rocket, label: "TOKEN LAUNCHER" },
              { id: "tests", icon: TestTube, label: "ТЕСТЫ" },
              { id: "devnet-test", icon: PlayCircle, label: "DEVNET TEST" },
              { id: "demo", icon: BarChart3, label: "DEMO" },
            ].map((item) => (
              <button
                key={item.id}
                onClick={() => setActiveSection(item.id)}
                className={`w-full flex items-center gap-3 p-3 rounded transition-colors ${
                  activeSection === item.id
                    ? "bg-cyan-500 text-black font-semibold"
                    : "text-neutral-400 hover:text-white hover:bg-neutral-800"
                }`}
              >
                <item.icon className="w-5 h-5 md:w-5 md:h-5 sm:w-6 sm:h-6" />
                {!sidebarCollapsed && <span className="text-sm font-medium">{item.label}</span>}
              </button>
            ))}
          </nav>

          {!sidebarCollapsed && (
            <div className="mt-8 space-y-2">
              {connected && publicKey ? (
                <div className="p-4 bg-neutral-800 border border-cyan-500/30 rounded">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Wallet className="w-4 h-4 text-cyan-400" />
                  <span className="text-xs text-cyan-400">WALLET CONNECTED</span>
                </div>
                <button
                  type="button"
                  onClick={() => void handleDisconnect()}
                  className="text-neutral-400 hover:text-cyan-300"
                  aria-label="Disconnect wallet"
                  title="Disconnect"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
              <div className="text-xs text-neutral-500 font-mono">
                    <div>SOL: {balance.toFixed(3)}</div>
                    <div className="truncate">{publicKey.toBase58().slice(0, 6)}...{publicKey.toBase58().slice(-6)}</div>
                  </div>
                </div>
              ) : (
                <div className="p-4">
                  <div className="relative">
                    <WalletMultiButton className="!bg-cyan-500 hover:!bg-cyan-600 !text-black !rounded !w-full !justify-center !pl-12" />
                    <Wallet className="absolute left-3 top-1/2 -translate-y-1/2 text-black/70 pointer-events-none" />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Mobile Overlay */}
      {!sidebarCollapsed && (
        <div className="fixed inset-0 bg-black/50 z-40 md:hidden" onClick={() => setSidebarCollapsed(true)} />
      )}

      {/* Main Content */}
      <div className={`flex-1 flex flex-col ${!sidebarCollapsed ? "md:ml-0" : ""}`}>
        {/* Top Toolbar */}
        <div className="h-16 bg-neutral-800 border-b border-neutral-700 flex items-center justify-between px-6">
          <div className="flex items-center gap-4">
            <div className="text-sm text-neutral-400">
              SOLANA TOOLS / <span className="text-cyan-400">{activeSection.toUpperCase().replace("-", " ")}</span>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
              <span className="text-xs text-green-500">MAINNET</span>
            </div>
            <Button variant="ghost" size="icon" className="text-neutral-400 hover:text-cyan-400">
              <Bell className="w-4 h-4" />
            </Button>
            <Button variant="ghost" size="icon" className="text-neutral-400 hover:text-cyan-400">
              <RefreshCw className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {/* Dashboard Content */}
        <div className="flex-1 overflow-auto">
          {activeSection === "dashboard" && <DashboardPage />}
          {activeSection === "wallet-tools" && <WalletToolsPage />}
          {activeSection === "volume-bot" && <VolumeBotPage />}
          {activeSection === "bundler" && <SolanaBundlerPage />}
          {activeSection === "token-launcher" && <TokenLauncherPage />}
          {activeSection === "tests" && <TestsPage />}
          {activeSection === "devnet-test" && <DevnetTestPage />}
          {activeSection === "demo" && <DemoPage />}
        </div>
      </div>
    </div>
  )
}
