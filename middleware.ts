import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"

const ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)

function buildCorsHeaders(origin: string): HeadersInit {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Token",
    "Access-Control-Allow-Credentials": "true",
    "Vary": "Origin",
  }
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  if (pathname === "/api/health") {
    return NextResponse.next()
  }

  const authUser = process.env.BASIC_AUTH_USER || ""
  const authPass = process.env.BASIC_AUTH_PASS || ""
  const authEnabled = authUser && authPass

  const isApiRoute = pathname.startsWith("/api/")
  const origin = request.headers.get("origin") || ""
  const originRestricted = ALLOWED_ORIGINS.length > 0

  if (isApiRoute) {
    if (originRestricted && origin && !ALLOWED_ORIGINS.includes(origin)) {
      return new NextResponse(JSON.stringify({ error: "origin not allowed" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      })
    }

    if (request.method === "OPTIONS") {
      const headers = origin && originRestricted ? buildCorsHeaders(origin) : undefined
      return new NextResponse(null, { status: 204, headers })
    }
  }

  if (authEnabled) {
    const authorization = request.headers.get("authorization") || ""
    const expected = `Basic ${btoa(`${authUser}:${authPass}`)}`
    if (authorization !== expected) {
      return new NextResponse("Authentication required", {
        status: 401,
        headers: { "WWW-Authenticate": "Basic realm=\"Secure Area\"" },
      })
    }
  }

  const response = NextResponse.next()
  if (isApiRoute && origin && originRestricted) {
    const corsHeaders = buildCorsHeaders(origin)
    Object.entries(corsHeaders).forEach(([key, value]) => {
      if (value) response.headers.set(key, value)
    })
  }
  return response
}

export const config = {
  matcher: ["/:path*"],
}
