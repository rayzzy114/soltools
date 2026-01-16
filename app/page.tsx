"use client"
import dynamic from "next/dynamic"
import { useState } from "react"
import { ChevronRight, LayoutDashboard, RefreshCw, Wallet } from "lucide-react"
import { Button } from "@/components/ui/button"
import DashboardPage from "./dashboard/page"
import WalletToolsPage from "./wallet-tools/page"

const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((mod) => mod.WalletMultiButton),
  { ssr: false }
)

export default function CryptoDashboard() {
  const [activeSection, setActiveSection] = useState("dashboard")
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

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
              aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
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
            ].map((item) => (
              <button
                key={item.id}
                onClick={() => setActiveSection(item.id)}
                className={`w-full flex items-center gap-3 p-3 rounded transition-colors ${
                  activeSection === item.id
                    ? "bg-cyan-500 text-black font-semibold"
                    : "text-neutral-400 hover:text-white hover:bg-neutral-800"
                }`}
                aria-label={item.label}
                title={item.label}
              >
                <item.icon className="w-5 h-5 md:w-5 md:h-5 sm:w-6 sm:h-6" />
                {!sidebarCollapsed && <span className="text-sm font-medium">{item.label}</span>}
              </button>
            ))}
          </nav>

          {!sidebarCollapsed && (
            <div className="mt-8 space-y-2">
              <div className="p-4">
                <div className="relative">
                  <WalletMultiButton className="!bg-cyan-500 hover:!bg-cyan-600 !text-black !rounded !w-full !justify-center !pl-12" />
                  <Wallet className="absolute left-3 top-1/2 -translate-y-1/2 text-black/70 pointer-events-none" />
                </div>
                <div className="mt-2 text-[10px] text-neutral-500">
                  Connect only to top up the funding wallet.
                </div>
              </div>
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
            <Button
              variant="ghost"
              size="icon"
              onClick={() => window.location.reload()}
              className="text-neutral-400 hover:text-cyan-400"
              title="Reload App"
              aria-label="Reload App"
            >
              <RefreshCw className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {/* Dashboard Content */}
        <div className="flex-1 overflow-auto">
          {activeSection === "dashboard" && <DashboardPage />}
          {activeSection === "wallet-tools" && <WalletToolsPage />}
        </div>
      </div>
    </div>
  )
}
