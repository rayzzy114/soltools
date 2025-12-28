/**
 * Lightweight smoke tests for API handlers
 */
import { describe, it, expect } from "vitest"
import { GET as networkGet } from "@/app/api/network/route"

describe("API smoke", () => {
  it("network endpoint returns status and rpc info", async () => {
    const res = await networkGet()
    const data = await res.json()
    expect(data.network).toBeDefined()
    expect(data.rpc).toBeDefined()
    expect(typeof data.rpcHealthy).toBe("boolean")
  })
})

