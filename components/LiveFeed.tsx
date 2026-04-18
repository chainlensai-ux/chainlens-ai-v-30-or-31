"use client";

import { motion } from "framer-motion";

export default function LiveFeed() {
  const feed = [
    "New deployer detected on Base: 0x91…aa",
    "Clark flagged unusual volume on AGENT token",
    "Wallet 0x44…ee bridged 12.4 ETH into Base",
    "Smart money cluster #12 opened a new position",
    "Fresh contract interaction spike detected",
  ];

  return (
    <section className="relative flex justify-center mt-32 px-6 mb-32">
      <motion.div
        initial={{ opacity: 0, y: 40 }}
        whileInView={{ opacity: 1, y: 0 }}
        transition={{ duration: 1, ease: "easeOut" }}
        viewport={{ once: true }}
        className="w-full max-w-3xl bg-white/5 backdrop-blur-xl border border-white/10 rounded-2xl p-8 shadow-2xl relative overflow-hidden"
      >
        {/* Glow background */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 0.3 }}
          transition={{ duration: 1.5 }}
          className="absolute inset-0 bg-gradient-to-br from-cyan-500/20 via-blue-500/20 to-purple-500/20 blur-2xl"
        />

        {/* Title */}
        <h2 className="text-3xl font-semibold text-white relative z-10">
          Live Feed
        </h2>

        <p className="text-white/70 mt-2 relative z-10">
          A simulated stream of what Clark monitors in the Base ecosystem.
        </p>

        {/* Feed list */}
        <div className="mt-8 space-y-3 relative z-10">
          {feed.map((item, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, x: 20 }}
              whileInView={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.6, delay: i * 0.15 }}
              viewport={{ once: true }}
              className="bg-black/40 border border-white/10 rounded-xl p-4 text-white/80"
            >
              {item}
            </motion.div>
          ))}
        </div>
      </motion.div>
    </section>
  );
}
