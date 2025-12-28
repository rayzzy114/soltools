import { executeGather } from "./gather"

export async function runGather(): Promise<{ signatures: string[] }> {
  return executeGather()
}

