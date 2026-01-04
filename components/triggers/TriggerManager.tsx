"use client"

import { useState, useEffect, useCallback } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { 
  Target, 
  TrendingUp, 
  TrendingDown, 
  Clock, 
  DollarSign,
  Play,
  Pause,
  Trash2,
  Plus,
  AlertTriangle,
  Zap,
  ChevronDown,
  ChevronUp,
} from "lucide-react"
import { toast } from "sonner"
import type { Trigger, TriggerType } from "@/lib/triggers/types"

interface TriggerManagerProps {
  mintAddress: string
  tokenSymbol: string
  walletAddress: string
  walletSecretKey?: string
  currentPrice?: number
  entryPrice?: number
}

const TRIGGER_TYPE_INFO: Record<TriggerType, { 
  label: string
  icon: React.ReactNode
  color: string
  description: string
}> = {
  take_profit: {
    label: "Take Profit",
    icon: <TrendingUp className="w-4 h-4" />,
    color: "text-green-400",
    description: "sell when price rises by %",
  },
  stop_loss: {
    label: "Stop Loss",
    icon: <TrendingDown className="w-4 h-4" />,
    color: "text-red-400",
    description: "sell when price drops by %",
  },
  trailing_stop: {
    label: "Trailing Stop",
    icon: <Target className="w-4 h-4" />,
    color: "text-yellow-400",
    description: "follows price up, sells on drop",
  },
  price_target: {
    label: "Price Target",
    icon: <DollarSign className="w-4 h-4" />,
    color: "text-cyan-400",
    description: "sell when price reaches target",
  },
  time_based: {
    label: "Time Based",
    icon: <Clock className="w-4 h-4" />,
    color: "text-purple-400",
    description: "sell after time elapses",
  },
}

export function TriggerManager({
  mintAddress,
  tokenSymbol,
  walletAddress,
  walletSecretKey,
  currentPrice = 0,
  entryPrice = 0,
}: TriggerManagerProps) {
  const [triggers, setTriggers] = useState<Trigger[]>([])
  const [engineRunning, setEngineRunning] = useState(false)
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState(false)
  
  // form state
  const [triggerType, setTriggerType] = useState<TriggerType>("take_profit")
  const [profitPercent, setProfitPercent] = useState("50")
  const [lossPercent, setLossPercent] = useState("20")
  const [trailPercent, setTrailPercent] = useState("15")
  const [targetPrice, setTargetPrice] = useState("")
  const [priceDirection, setPriceDirection] = useState<"above" | "below">("above")
  const [triggerMinutes, setTriggerMinutes] = useState("30")
  const [sellPercent, setSellPercent] = useState("100")
  const [slippage, setSlippage] = useState("10")

  const fetchTriggers = useCallback(async () => {
    try {
      const res = await fetch(`/api/triggers?mint=${mintAddress}`)
      const data = await res.json()
      setTriggers(data.triggers || [])
      setEngineRunning(data.engineRunning || false)
    } catch (error) {
      // silent fail
    }
  }, [mintAddress])

  useEffect(() => {
    fetchTriggers()
    const interval = setInterval(fetchTriggers, 5000)
    return () => clearInterval(interval)
  }, [fetchTriggers])

  const createTrigger = async () => {
    setLoading(true)
    try {
      const condition: Record<string, any> = {}
      
      switch (triggerType) {
        case "take_profit":
          condition.profitPercent = parseFloat(profitPercent)
          break
        case "stop_loss":
          condition.lossPercent = parseFloat(lossPercent)
          break
        case "trailing_stop":
          condition.trailPercent = parseFloat(trailPercent)
          break
        case "price_target":
          condition.targetPrice = parseFloat(targetPrice)
          condition.priceDirection = priceDirection
          break
        case "time_based":
          condition.triggerAfterMinutes = parseInt(triggerMinutes)
          break
      }

      const res = await fetch("/api/triggers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          mintAddress,
          walletAddress,
          walletSecretKey,
          type: triggerType,
          condition,
          sellPercent: parseFloat(sellPercent),
          slippage: parseFloat(slippage),
          entryPrice: entryPrice || currentPrice,
        }),
      })

      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.error || "failed to create trigger")
      }

      toast.success(`${TRIGGER_TYPE_INFO[triggerType].label} trigger created!`)
      fetchTriggers()
    } catch (error: any) {
      toast.error(error.message)
    } finally {
      setLoading(false)
    }
  }

  const deleteTrigger = async (id: string) => {
    try {
      const res = await fetch(`/api/triggers?id=${id}`, { method: "DELETE" })
      if (res.ok) {
        toast.success("trigger removed")
        fetchTriggers()
      }
    } catch (error) {
      toast.error("failed to delete trigger")
    }
  }

  const executeTrigger = async (id: string) => {
    setLoading(true)
    try {
      const res = await fetch("/api/triggers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "execute", id }),
      })
      
      const data = await res.json()
      if (data.success) {
        toast.success(`executed! received ~${data.receivedSol?.toFixed(4)} SOL`)
        fetchTriggers()
      } else {
        toast.error(data.error || "execution failed")
      }
    } catch (error: any) {
      toast.error(error.message)
    } finally {
      setLoading(false)
    }
  }

  const toggleEngine = async () => {
    try {
      const action = engineRunning ? "stop_engine" : "start_engine"
      const res = await fetch("/api/triggers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      })
      
      const data = await res.json()
      setEngineRunning(data.running)
      toast.success(engineRunning ? "engine stopped" : "engine started")
    } catch (error) {
      toast.error("failed to toggle engine")
    }
  }

  const activeTriggers = triggers.filter(t => t.status === "active")

  return (
    <Card className="bg-neutral-900 border-neutral-700">
      <CardHeader className="pb-3 cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-yellow-500" />
            <CardTitle className="text-sm font-medium text-neutral-300 tracking-wider">
              AUTO-TRIGGERS
            </CardTitle>
            <Badge className={activeTriggers.length > 0 
              ? "bg-green-500/20 text-green-400" 
              : "bg-neutral-700 text-neutral-400"
            }>
              {activeTriggers.length} active
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant={engineRunning ? "destructive" : "default"}
              className={engineRunning 
                ? "bg-green-500/20 text-green-400 hover:bg-green-500/30" 
                : "bg-neutral-700 text-neutral-300 hover:bg-neutral-600"
              }
              onClick={(e) => { e.stopPropagation(); toggleEngine(); }}
            >
              {engineRunning ? <Pause className="w-3 h-3 mr-1" /> : <Play className="w-3 h-3 mr-1" />}
              {engineRunning ? "running" : "stopped"}
            </Button>
            {expanded ? <ChevronUp className="w-4 h-4 text-neutral-400" /> : <ChevronDown className="w-4 h-4 text-neutral-400" />}
          </div>
        </div>
      </CardHeader>
      
      {expanded && (
        <CardContent className="space-y-4">
          {/* active triggers */}
          {triggers.length > 0 && (
            <div className="space-y-2">
              <Label className="text-neutral-400 text-xs">active triggers</Label>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {triggers.map((trigger) => {
                  const info = TRIGGER_TYPE_INFO[trigger.type]
                  return (
                    <div 
                      key={trigger.id} 
                      className={`p-3 rounded-lg border ${
                        trigger.status === "active" 
                          ? "bg-neutral-800 border-neutral-700" 
                          : trigger.status === "triggered"
                          ? "bg-green-500/10 border-green-500/30"
                          : "bg-neutral-800/50 border-neutral-700/50 opacity-60"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className={info.color}>{info.icon}</span>
                          <span className="text-white text-sm font-medium">{info.label}</span>
                          <Badge className={
                            trigger.status === "active" ? "bg-blue-500/20 text-blue-400" :
                            trigger.status === "triggered" ? "bg-green-500/20 text-green-400" :
                            "bg-neutral-700 text-neutral-400"
                          }>
                            {trigger.status}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-1">
                          {trigger.status === "active" && walletSecretKey && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-yellow-400 hover:text-yellow-300 h-7 px-2"
                              onClick={() => executeTrigger(trigger.id)}
                              disabled={loading}
                            >
                              <Zap className="w-3 h-3" />
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-red-400 hover:text-red-300 h-7 px-2"
                            onClick={() => deleteTrigger(trigger.id)}
                          >
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        </div>
                      </div>
                      <div className="mt-2 text-xs text-neutral-400 space-y-1">
                        <div className="flex justify-between">
                          <span>sell:</span>
                          <span className="text-white">{trigger.sellPercent}%</span>
                        </div>
                        {trigger.type === "take_profit" && (
                          <div className="flex justify-between">
                            <span>target profit:</span>
                            <span className="text-green-400">+{trigger.condition.profitPercent}%</span>
                          </div>
                        )}
                        {trigger.type === "stop_loss" && (
                          <div className="flex justify-between">
                            <span>max loss:</span>
                            <span className="text-red-400">-{trigger.condition.lossPercent}%</span>
                          </div>
                        )}
                        {trigger.type === "trailing_stop" && (
                          <div className="flex justify-between">
                            <span>trail:</span>
                            <span className="text-yellow-400">{trigger.condition.trailPercent}%</span>
                          </div>
                        )}
                        {trigger.type === "price_target" && (
                          <div className="flex justify-between">
                            <span>target:</span>
                            <span className="text-cyan-400">
                              {trigger.condition.priceDirection === "above" ? "≥" : "≤"} ${trigger.condition.targetPrice}
                            </span>
                          </div>
                        )}
                        {trigger.type === "time_based" && (
                          <div className="flex justify-between">
                            <span>after:</span>
                            <span className="text-purple-400">{trigger.condition.triggerAfterMinutes} min</span>
                          </div>
                        )}
                        {trigger.currentPrice && (
                          <div className="flex justify-between">
                            <span>current:</span>
                            <span className="text-white">${trigger.currentPrice.toFixed(8)}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* create trigger */}
          <div className="space-y-3 pt-2 border-t border-neutral-700">
            <Label className="text-neutral-400 text-xs">create new trigger</Label>
            
            {/* type selector */}
            <div className="grid grid-cols-5 gap-1">
              {(Object.keys(TRIGGER_TYPE_INFO) as TriggerType[]).map((type) => {
                const info = TRIGGER_TYPE_INFO[type]
                return (
                  <button
                    key={type}
                    onClick={() => setTriggerType(type)}
                    className={`p-2 rounded text-center transition-colors ${
                      triggerType === type
                        ? `bg-neutral-700 ${info.color}`
                        : "bg-neutral-800 text-neutral-400 hover:bg-neutral-700"
                    }`}
                  >
                    <div className="flex justify-center mb-1">{info.icon}</div>
                    <div className="text-[10px] leading-tight">{info.label.split(" ")[0]}</div>
                  </button>
                )
              })}
            </div>

            {/* condition inputs */}
            <div className="grid grid-cols-2 gap-3">
              {triggerType === "take_profit" && (
                <div className="space-y-1">
                  <Label className="text-neutral-500 text-xs">profit %</Label>
                  <Input
                    type="number"
                    value={profitPercent}
                    onChange={(e) => setProfitPercent(e.target.value)}
                    className="bg-neutral-800 border-neutral-700 text-white h-9"
                    placeholder="50"
                  />
                </div>
              )}
              {triggerType === "stop_loss" && (
                <div className="space-y-1">
                  <Label className="text-neutral-500 text-xs">loss %</Label>
                  <Input
                    type="number"
                    value={lossPercent}
                    onChange={(e) => setLossPercent(e.target.value)}
                    className="bg-neutral-800 border-neutral-700 text-white h-9"
                    placeholder="20"
                  />
                </div>
              )}
              {triggerType === "trailing_stop" && (
                <div className="space-y-1">
                  <Label className="text-neutral-500 text-xs">trail %</Label>
                  <Input
                    type="number"
                    value={trailPercent}
                    onChange={(e) => setTrailPercent(e.target.value)}
                    className="bg-neutral-800 border-neutral-700 text-white h-9"
                    placeholder="15"
                  />
                </div>
              )}
              {triggerType === "price_target" && (
                <>
                  <div className="space-y-1">
                    <Label className="text-neutral-500 text-xs">target price $</Label>
                    <Input
                      type="number"
                      value={targetPrice}
                      onChange={(e) => setTargetPrice(e.target.value)}
                      className="bg-neutral-800 border-neutral-700 text-white h-9"
                      placeholder="0.00001"
                      step="0.00000001"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-neutral-500 text-xs">direction</Label>
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        variant={priceDirection === "above" ? "default" : "outline"}
                        className={priceDirection === "above" 
                          ? "flex-1 bg-green-500/20 text-green-400 h-9" 
                          : "flex-1 border-neutral-700 text-neutral-400 h-9"
                        }
                        onClick={() => setPriceDirection("above")}
                      >
                        ≥
                      </Button>
                      <Button
                        size="sm"
                        variant={priceDirection === "below" ? "default" : "outline"}
                        className={priceDirection === "below" 
                          ? "flex-1 bg-red-500/20 text-red-400 h-9" 
                          : "flex-1 border-neutral-700 text-neutral-400 h-9"
                        }
                        onClick={() => setPriceDirection("below")}
                      >
                        ≤
                      </Button>
                    </div>
                  </div>
                </>
              )}
              {triggerType === "time_based" && (
                <div className="space-y-1">
                  <Label className="text-neutral-500 text-xs">minutes</Label>
                  <Input
                    type="number"
                    value={triggerMinutes}
                    onChange={(e) => setTriggerMinutes(e.target.value)}
                    className="bg-neutral-800 border-neutral-700 text-white h-9"
                    placeholder="30"
                  />
                </div>
              )}
              
              <div className="space-y-1">
                <Label className="text-neutral-500 text-xs">sell %</Label>
                <Input
                  type="number"
                  value={sellPercent}
                  onChange={(e) => setSellPercent(e.target.value)}
                  className="bg-neutral-800 border-neutral-700 text-white h-9"
                  placeholder="100"
                  min="1"
                  max="100"
                />
              </div>
              
              <div className="space-y-1">
                <Label className="text-neutral-500 text-xs">slippage %</Label>
                <Input
                  type="number"
                  value={slippage}
                  onChange={(e) => setSlippage(e.target.value)}
                  className="bg-neutral-800 border-neutral-700 text-white h-9"
                  placeholder="10"
                />
              </div>
            </div>

            {/* warnings */}
            {!walletSecretKey && (
              <div className="p-2 bg-yellow-500/10 border border-yellow-500/30 rounded text-xs text-yellow-400 flex items-center gap-2">
                <AlertTriangle className="w-3 h-3" />
                auto-execute requires wallet secret key
              </div>
            )}

            <Button
              onClick={createTrigger}
              disabled={loading || !mintAddress}
              className="w-full bg-cyan-500 hover:bg-cyan-600 text-black font-semibold"
            >
              <Plus className="w-4 h-4 mr-2" />
              {loading ? "creating..." : `create ${TRIGGER_TYPE_INFO[triggerType].label}`}
            </Button>
          </div>
        </CardContent>
      )}
    </Card>
  )
}
