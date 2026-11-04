"use client";

import type { ComponentProps } from "react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { ShimmerLabel } from "./surfaces";
import { Loader2Icon } from "lucide-react";

/** Standalone clock for the assistant-ui loader; runs only while mounted. */
export function GenerationLoadingState({
  label,
  className,
  ...props
}: Omit<GenerationLoaderProps, "tick">) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    let timer: ReturnType<typeof setInterval> | undefined;
    const update = () => {
      clearInterval(timer);
      if (!motion.matches)
        timer = setInterval(() => setTick((value) => value + 1), 120);
    };
    update();
    motion.addEventListener("change", update);
    return () => {
      clearInterval(timer);
      motion.removeEventListener("change", update);
    };
  }, []);
  return (
    <GenerationLoader
      label={label}
      tick={tick}
      role="status"
      aria-live="polite"
      className={cn("min-h-0 flex-1 justify-center py-8", className)}
      {...props}
    />
  );
}

/** Compact feedback for small inline waits. */
export function LoadingState({
  label,
  className,
}: {
  label: string;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={cn("space-y-4 p-4", className)}
    >
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2Icon
          aria-hidden="true"
          className="size-4 shrink-0 animate-spin motion-reduce:animate-none"
        />
        <span>{label}</span>
      </div>
    </div>
  );
}

export type GenerationLoaderVariant = "dots" | "squares" | "rounded";

export interface GenerationLoaderProps extends Omit<
  ComponentProps<"div">,
  "children"
> {
  label: string;
  tick: number;
  variant?: GenerationLoaderVariant;
}

const CELL_SHAPES: Record<GenerationLoaderVariant, string> = {
  dots: "rounded-full",
  squares: "rounded-[1px]",
  rounded: "rounded-[3px]",
};

export function GenerationLoader({
  label,
  tick,
  variant = "dots",
  className,
  ...props
}: GenerationLoaderProps) {
  const pixelOffset = Math.floor(tick / 3);

  return (
    <div
      data-slot="generation-loader"
      className={cn("flex flex-col items-center gap-4", className)}
      {...props}
    >
      <div aria-hidden className="grid grid-cols-3 gap-1">
        {Array.from({ length: 9 }, (_, index) => {
          const active = (index * 2 + pixelOffset) % 9 < 3;

          return (
            <span
              key={index}
              className={cn(
                "bg-foreground size-2 transition-opacity duration-300 motion-reduce:transition-none",
                CELL_SHAPES[variant],
                active ? "opacity-90" : "opacity-15",
              )}
            />
          );
        })}
      </div>
      <ShimmerLabel className="text-muted-foreground relative inline-block text-sm">
        {label}
      </ShimmerLabel>
    </div>
  );
}
