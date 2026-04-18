"use client";

import { motion } from "framer-motion";

export default function GhostTrade() {
  return (
    <section className="relative flex justify-center mt-32 px-6">
      <motion.div
        initial={{ opacity: 0, y: 40 }}
        whileInView={{ opacity: 1, y: 0 }}
        transition={{ duration: 1, ease: "easeOut" }}
        viewport={{ once: true }}
        className="w-full max-w-3xl bg-white/5 backdrop-blur-xl border border-white/10 rounded-2xl p-8 shadow-2xl relative overflow-hidden"
      >
        {/* Background glow */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 0.3 }}
          transition={{ duration: 1.5 }}
          className="absolute inset-0 bg-gradient-to-br from-green-500/20 via-blue-500/20 to-purple-500/20 blur-2xl"
        />

        {/* Floating orb */}
        <motion.div
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 0.5 }}
          transition={{ duration: 1.5, ease: "easeOut" }}
          className="absolute w-40 h-40 bg-green-500/40 rounded-full blur-3xl -top-10 -left-10"
        />

        {/* Title */}
        <h2 className="text-3xl font-semibold text-white relative z-10">
          Ghost Trade Feed
        </h2>

        <p className="text-white/70 mt-2 relative z-10">
          Real‑time simulated trade activity showing how Clark interprets market
          movement.
        </p>

        {/* Animated trade rows */}
        <div className="mt-8 space-y-3 relative z-10">
          {[
            { wallet: "0xA3…91", action: "Bought", amount: "3.2 ETH", color: "text-green-300" },
            { wallet: "0xF9…12", action: "Sold", amount: "1.1 ETH", color: "text-red-300" },
            { wallet: "0x44…EE", action: "Bought", amount: "0.8 ETH", color: "text-green-300" },
          ].map((trade, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, x: -20 }}
              whileInView={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.6, delay: i * 0.2 }}
              viewport={{ once: true }}
              className="flex justify-between bg-black/40 border border-white/10 rounded-xl p-4"
            >
              <span className="text-white/80">{trade.wallet}</span>
              <span className={trade.color}>{trade.action}</span>
              <span className="text-white/80">{trade.amount}</span>
            </motion.div>
          ))}
        </div>
      </motion.div>
    </section>
  );
}
