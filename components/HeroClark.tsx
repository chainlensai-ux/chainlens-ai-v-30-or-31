"use client";

import { motion } from "framer-motion";

export default function HeroClark() {
  return (
    <section className="relative flex flex-col items-center justify-center text-center py-32 px-6 overflow-hidden">
      {/* Animated gradient background */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 2 }}
        className="absolute inset-0 bg-gradient-to-br from-blue-500/30 via-purple-500/20 to-cyan-500/30 blur-3xl"
      />

      {/* Floating glow orb */}
      <motion.div
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 0.6 }}
        transition={{ duration: 1.5, ease: "easeOut" }}
        className="absolute w-72 h-72 bg-blue-500/40 rounded-full blur-3xl -top-20"
      />

      {/* Main heading */}
      <motion.h1
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 1 }}
        className="text-5xl md:text-7xl font-bold text-white drop-shadow-lg"
      >
        Meet <span className="text-blue-300">Clark</span>
      </motion.h1>

      {/* Subheading */}
      <motion.p
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 1.2 }}
        className="mt-6 text-lg md:text-2xl text-white/80 max-w-2xl"
      >
        Your AI‑powered Base terminal. Faster insights, smarter decisions, and a
        personality that hits different.
      </motion.p>

      {/* CTA button */}
      <motion.button
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 1.4 }}
        className="mt-10 px-8 py-4 bg-blue-600 hover:bg-blue-700 transition rounded-xl text-white font-semibold shadow-xl"
      >
        Enter Terminal
      </motion.button>
    </section>
  );
}
