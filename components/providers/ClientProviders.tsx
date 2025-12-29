"use client"

import { ReactNode, useEffect, useState } from "react"
import { WalletProvider } from "./WalletProvider"
import { Toaster } from "sonner"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

interface ClientProvidersProps {
  children: ReactNode
}

export function ClientProviders({ children }: ClientProvidersProps) {
  const [queryClient] = useState(() => new QueryClient())

  useEffect(() => {
    const tokenFromEnv = process.env.NEXT_PUBLIC_ADMIN_TOKEN || ""
    const tokenFromStorage = typeof window !== "undefined" ? localStorage.getItem("admin_token") || "" : ""
    const adminToken = tokenFromStorage || tokenFromEnv
    if (!adminToken) return

    const originalFetch = window.fetch
    // Attach admin token to API calls when configured.
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString()
      if (!url.startsWith("/api/")) {
        return originalFetch(input, init)
      }
      const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined))
      if (!headers.has("x-admin-token") && !headers.has("authorization")) {
        headers.set("x-admin-token", adminToken)
      }
      if (input instanceof Request) {
        const nextRequest = new Request(input, { ...init, headers })
        return originalFetch(nextRequest)
      }
      return originalFetch(input, { ...init, headers })
    }

    return () => {
      window.fetch = originalFetch
    }
  }, [])

  return (
    <QueryClientProvider client={queryClient}>
      <WalletProvider>
        {children}
        <Toaster theme="dark" position="top-right" />
      </WalletProvider>
    </QueryClientProvider>
  )
}
