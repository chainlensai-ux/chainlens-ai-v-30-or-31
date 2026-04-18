"use client";

import { motion } from "framer-motion";

export default function Waitlist() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 30 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 1, ease: "easeOut" }}
      className="mx-auto mt-20 max-w-xl w-full bg-white/5 backdrop-blur-xl border border-white/10 rounded-2xl p-8 shadow-2xl"
    >
      <h2 className="text-2xl md:text-3xl font-semibold text-white text-center">
        Join the Waitlist
      </h2>

      <p className="text-white/70 text-center mt-2">
        Be the first to access Clark’s AI trading terminal.
      </p>

      <div className="mt-6 flex gap-3">
        <input
          type="email"
          placeholder="Enter your email"
          className="flex-1 px-4 py-3 rounded-xl bg-white/10 border border-white/20 text-white placeholder-white/40 focus:outline-none"
        />
        <button className="px-6 py-3 bg-blue-600 hover:bg-blue-700 transition rounded-xl text-white font-semibold">
          Join
        </button>
      </div>
    </motion.div>
  );
}
