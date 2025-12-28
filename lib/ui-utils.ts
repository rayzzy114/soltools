export const clampPercent = (value: number, min = 0, max = 99): number => {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.floor(value)))
}

export const clampNumber = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

export const parseSafe = (value: string): number => {
  const num = Number(value)
  return Number.isFinite(num) ? num : 0
}

export const notifySuccess = (toastFn: (msg: string) => void, msg: string) => {
  toastFn(msg)
}

export const notifyError = (toastFn: (msg: string) => void, msg: string) => {
  toastFn(msg)
}

