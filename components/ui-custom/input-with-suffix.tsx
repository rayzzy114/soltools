import * as React from "react"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

interface InputWithSuffixProps extends React.ComponentProps<typeof Input> {
  suffix: string
}

const InputWithSuffix = React.forwardRef<HTMLInputElement, InputWithSuffixProps>(
  ({ className, suffix, ...props }, ref) => {
    return (
      <div className="relative">
        <Input
          className={cn("pr-12", className)}
          ref={ref}
          {...props}
        />
        <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none text-xs text-neutral-500 font-mono">
          {suffix}
        </div>
      </div>
    )
  }
)
InputWithSuffix.displayName = "InputWithSuffix"

export { InputWithSuffix }
