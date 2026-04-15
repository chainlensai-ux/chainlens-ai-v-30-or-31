"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ReactNode } from "react";

interface SidebarProps {
  title?: string;
  planLabel?: string;
  className?: string;
  children?: ReactNode;
}

export default function Sidebar({
  title = "Clark",
  planLabel = "PRO PLAN",
  className = "",
  children,
}: SidebarProps) {
  const pathname = usePathname();

  const item = (href: string, label: string) => (
    <Link
      href={href}
      className={`block px-4 py-2 rounded-lg mb-2 transition ${
        pathname === href
          ? "bg-white/10 text-white font-semibold"
          : "text-white/60 hover:text-white hover:bg-white/5"
      }`}
    >
      {label}
    </Link>
  );

  return (
    <aside className={`h-full bg-[#080c14] border-r border-[rgba(255,255,255,0.08)] p-4 flex flex-col ${className}`}>
      <h1 className="text-base font-semibold tracking-wide mb-4">{title}</h1>

      <div className="flex-1 overflow-y-auto">
        {children ? (
          children
        ) : (
          <>
            {item("/dashboard/wallets", "Wallet Scanner")}
            {item("/dashboard/tokens", "Token Scanner")}
            {item("/dashboard/live", "Live Feed")}
            {item("/dashboard/agents", "Agents")}
            {item("/dashboard/settings", "Settings")}
          </>
        )}
      </div>

      <div
        className="mt-4 rounded-lg border border-[rgba(45,212,191,0.45)] bg-[rgba(45,212,191,0.12)] px-3 py-2 text-center text-[10px] tracking-[0.12em] text-[#7ef3de] uppercase"
        style={{ fontFamily: "var(--font-mono), IBM Plex Mono, monospace" }}
      >
        {planLabel}
      </div>
    </aside>
  );
}
