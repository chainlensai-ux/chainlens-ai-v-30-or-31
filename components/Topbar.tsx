"use client";

import { motion } from "framer-motion";
import { ReactNode } from "react";

interface TopbarProps {
  title?: string;
  rightSlot?: ReactNode;
  className?: string;
}

export default function Topbar({ title = "Dashboard", rightSlot, className = "" }: TopbarProps) {
  return (
    <motion.header
      initial={{ y: -20, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.6 }}
      className={`w-full bg-white/5 backdrop-blur-xl border-b border-white/10 p-4 flex justify-between items-center ${className}`}
    >
      <h1 className="text-lg font-semibold">{title}</h1>

      {rightSlot ?? <div className="w-10 h-10 rounded-full bg-white/20" />}
    </motion.header>
  );
}
