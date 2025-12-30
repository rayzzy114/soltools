import type React from "react"
import type { Metadata } from "next"
import "./globals.css"
import { ClientProviders } from "@/components/providers/ClientProviders"

import "@fontsource/geist-mono/index.css"

export const metadata: Metadata = {
  title: "Solana Tools Dashboard",
  description: "Volume Bot, Bundler & Token Launcher",
    generator: 'v0.app'
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className="min-h-screen w-full bg-background text-foreground antialiased">
        <ClientProviders>
          {children}
        </ClientProviders>
      </body>
    </html>
  )
}
