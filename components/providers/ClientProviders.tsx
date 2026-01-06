"use client"

import { ReactNode, useEffect, useState } from "react"
import { WalletProvider } from "./WalletProvider"
import { Toaster } from "sonner"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { patchFetchWithNgrokHeader } from "@/lib/api-client"

interface ClientProvidersProps {
  children: ReactNode
}

export function ClientProviders({ children }: ClientProvidersProps) {
  const [queryClient] = useState(() => new QueryClient())

  useEffect(() => {
    patchFetchWithNgrokHeader()
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
