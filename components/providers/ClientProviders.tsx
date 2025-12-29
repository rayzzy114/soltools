"use client"

import { ReactNode, useState } from "react"
import { WalletProvider } from "./WalletProvider"
import { Toaster } from "sonner"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

interface ClientProvidersProps {
  children: ReactNode
}

export function ClientProviders({ children }: ClientProvidersProps) {
  const [queryClient] = useState(() => new QueryClient())

  return (
    <QueryClientProvider client={queryClient}>
      <WalletProvider>
        {children}
        <Toaster theme="dark" position="top-right" />
      </WalletProvider>
    </QueryClientProvider>
  )
}
