"use client";

import React from "react";
import { cn } from "@/lib/utils";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "outline";
}

export function Button({ variant = "default", className, ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        "px-4 py-2 rounded-md font-medium transition",
        variant === "default" && "bg-black text-white hover:bg-neutral-800",
        variant === "outline" && "border border-neutral-300 hover:bg-neutral-100",
        className
      )}
      {...props}
    />
  );
}
