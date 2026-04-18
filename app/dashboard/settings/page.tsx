"use client";

import { useState } from "react";

export default function SettingsPage() {
  const [username, setUsername] = useState("User");
  const [email, setEmail] = useState("user@example.com");
  const [notifications, setNotifications] = useState(true);

  return (
    <div>
      <h2 className="text-2xl font-semibold mb-6">Settings</h2>

      <p className="text-white/60 mb-8">
        Manage your profile, preferences, and notification settings.
      </p>

      <div className="space-y-8">

        {/* Profile */}
        <div className="p-6 bg-white/5 border border-white/10 rounded-xl">
          <h3 className="text-lg font-semibold mb-4">Profile</h3>

          <div className="space-y-4">
            <div>
              <label className="text-white/60 text-sm">Username</label>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full p-3 mt-1 rounded-xl bg-white/5 border border-white/10 text-white"
              />
            </div>

            <div>
              <label className="text-white/60 text-sm">Email</label>
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full p-3 mt-1 rounded-xl bg-white/5 border border-white/10 text-white"
              />
            </div>
          </div>
        </div>

        {/* Notifications */}
        <div className="p-6 bg-white/5 border border-white/10 rounded-xl">
          <h3 className="text-lg font-semibold mb-4">Notifications</h3>

          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={notifications}
              onChange={() => setNotifications(!notifications)}
              className="w-5 h-5"
            />
            <span className="text-white/80">Enable alerts</span>
          </label>
        </div>

        {/* Danger Zone */}
        <div className="p-6 bg-red-500/10 border border-red-500/20 rounded-xl">
          <h3 className="text-lg font-semibold mb-4 text-red-400">Danger Zone</h3>

          <button className="px-6 py-3 bg-red-600 rounded-xl font-semibold hover:bg-red-500">
            Delete Account
          </button>
        </div>

      </div>
    </div>
  );
}
