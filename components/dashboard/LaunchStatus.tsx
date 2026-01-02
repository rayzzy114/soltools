"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

export type FsmStatus = "idle" | "preparing" | "building" | "sending" | "confirming" | "landed" | "failed"

export interface FsmStep {
  state: FsmStatus
  note: string
  at: number
  bundleId?: string
}

interface LaunchStatusProps {
  fsmCurrent: FsmStatus
  fsmSteps: FsmStep[]
  activeBundleId?: string
}

export function LaunchStatus({ fsmCurrent, fsmSteps, activeBundleId }: LaunchStatusProps) {
  const fsmFlow: FsmStatus[] = ["preparing", "building", "sending", "confirming", "landed"]
  const visitedStates = new Set(fsmSteps.map((step) => step.state))
  const activeIdx = Math.max(0, fsmFlow.findIndex((s) => s === fsmCurrent))
  const recentFsmSteps = [...fsmSteps].slice(-6).reverse()

  return (
    <Card className="bg-gradient-to-r from-[#1a0b14] via-[#2a0d1c] to-[#0d0711] border border-[#ff0054]/30 shadow-[0_0_32px_rgba(255,0,84,0.15)]">
      <CardHeader className="pb-2 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <CardTitle className="text-sm text-[#EFDBE0]">bundle state machine</CardTitle>
          <p className="text-xs text-neutral-200/70">tracks launch / buy / sell across jito bundler</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge className={`border ${fsmCurrent === "failed" ? "bg-red-500/20 text-red-200 border-red-500/40" : "bg-[#ff0054]/20 text-[#ff93b8] border-[#ff0054]/40"}`}>
            state: {fsmCurrent}
          </Badge>
          {activeBundleId && (
            <Badge className="bg-[#E05174]/20 text-[#ffb2c9] border border-[#E05174]/40">
              bundle {activeBundleId.slice(0, 6)}...{activeBundleId.slice(-4)}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
          {fsmFlow.map((state, idx) => {
            const step = [...fsmSteps].reverse().find((s) => s.state === state)
            const isCurrent = state === fsmCurrent
            const isDone = visitedStates.has(state) && idx < activeIdx
            const baseClasses = isCurrent
              ? "border-[#ff0054] bg-[#ff0054]/15 shadow-[0_0_18px_rgba(255,0,84,0.3)]"
              : isDone
              ? "border-[#E05174]/40 bg-[#E05174]/10"
              : "border-neutral-700 bg-neutral-900/80"
            return (
              <div key={state} className={`p-3 rounded-lg border transition ${baseClasses}`}>
                <div className="flex items-center justify-between text-[11px] uppercase tracking-wide text-[#EFDBE0]">
                  <span>{state}</span>
                  <span className="text-[10px] text-neutral-400">
                    {step ? new Date(step.at).toLocaleTimeString([], { hour12: false }) : "--:--:--"}
                  </span>
                </div>
                <div className="text-[11px] text-neutral-200 mt-1 line-clamp-2 min-h-[30px]">
                  {step?.note || "waiting"}
                </div>
              </div>
            )
          })}
        </div>

        <div className="bg-muted border border-border rounded-lg p-3 space-y-2">
          <div className="flex items-center justify-between text-xs text-[#EFDBE0]">
            <span>timeline</span>
            <span className="text-muted-foreground">last {recentFsmSteps.length} steps</span>
          </div>
          <div className="space-y-1 max-h-28 overflow-y-auto pr-1">
            {recentFsmSteps.map((step) => (
              <div
                key={`${step.state}-${step.at}`}
                className="flex items-center justify-between text-[11px] text-neutral-200"
              >
                <span className="font-mono text-neutral-400 w-16">
                  {new Date(step.at).toLocaleTimeString([], { hour12: false })}
                </span>
                <span className="w-20 text-[#ff93b8] uppercase">{step.state}</span>
                <span className="flex-1 text-right text-neutral-300 truncate ml-2">{step.note}</span>
              </div>
            ))}
            {recentFsmSteps.length === 0 && (
              <div className="text-neutral-400 text-xs">no events yet</div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
