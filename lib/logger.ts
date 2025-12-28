import pino from "pino"
import { ENV } from "./env"

export const logger = pino({
  level: ENV.logLevel,
  base: undefined,
})

export function getCorrelationId(request?: Request): string {
  const headerId = request?.headers.get("x-correlation-id")
  return headerId || crypto.randomUUID()
}

