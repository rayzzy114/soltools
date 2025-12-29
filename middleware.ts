import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ""
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

  const origin = request.headers.get("origin") || ""
  const originRestricted = ALLOWED_ORIGINS.length > 0

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

  if (ADMIN_TOKEN) {
    const headerToken = request.headers.get("x-admin-token") || ""
    const authHeader = request.headers.get("authorization") || ""
    const cookieToken = request.cookies.get("admin_token")?.value || ""
    const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader

    if (headerToken !== ADMIN_TOKEN && bearer !== ADMIN_TOKEN && cookieToken !== ADMIN_TOKEN) {
      return new NextResponse(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })
    }
  }

  const response = NextResponse.next()
  if (origin && originRestricted) {
    const corsHeaders = buildCorsHeaders(origin)
    Object.entries(corsHeaders).forEach(([key, value]) => {
      if (value) response.headers.set(key, value)
    })
  }
  return response
}

export const config = {
  matcher: ["/api/:path*"],
}
