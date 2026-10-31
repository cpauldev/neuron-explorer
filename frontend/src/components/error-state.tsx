"use client";

import type { ComponentProps } from "react";
import { CircleAlertIcon, RefreshCwIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { ShimmerLabel } from "./surfaces";
import { Button } from "./ui/button";

export interface ErrorStateProps extends Omit<
  ComponentProps<"div">,
  "children" | "role"
> {
  title: string;
  detail: string;
  retrying: boolean;
  onRetry?: () => void;
}

export function ErrorState({
  title,
  detail,
  retrying,
  onRetry,
  className,
  ...props
}: ErrorStateProps) {
  if (retrying) {
    return (
      <div
        data-slot="error-state"
        key="retrying"
        role="status"
        className={cn(
          "fade-in animate-in flex w-full max-w-sm items-center gap-2.5 text-sm duration-300 motion-reduce:animate-none",
          className,
        )}

        {...props}
      >
        <RefreshCwIcon className="text-muted-foreground size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
        <ShimmerLabel className="text-muted-foreground relative inline-block">
          Retrying
        </ShimmerLabel>
      </div>
    );
  }

  return (
    <div
      data-slot="error-state"
      key="error"
      role="alert"
      className={cn(
        "fade-in animate-in grid w-full min-w-0 max-w-sm grid-cols-[1rem_minmax(0,1fr)] items-start gap-2.5 rounded-2xl bg-red-500/[0.06] px-4 py-3 text-sm duration-300 motion-reduce:animate-none dark:bg-red-500/10",
        className,
      )}

      {...props}
    >
      <CircleAlertIcon
        aria-hidden="true"
        className="mt-1 size-4 text-red-500/80"
      />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <p className="min-w-0 flex-1 font-medium text-red-600 [overflow-wrap:anywhere] dark:text-red-400">
            {title}
          </p>
          {onRetry ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={onRetry}
              className="text-red-600 hover:bg-red-500/10 hover:text-red-600 dark:text-red-400 dark:hover:bg-red-500/10 dark:hover:text-red-400"
            >
              <RefreshCwIcon aria-hidden="true" />
              Retry
            </Button>
          ) : null}
        </div>
        <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-red-600/80 [overflow-wrap:anywhere] dark:text-red-400/80">
          {detail}
        </p>
      </div>
    </div>
  );
}
