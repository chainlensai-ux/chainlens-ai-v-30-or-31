import "./globals.css";
import { Inter, IBM_Plex_Mono } from "next/font/google";
import type { Metadata } from "next";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-plex-mono",
});

export const metadata: Metadata = {
  title: "ChainLens AI",
  description: "Multi-chain crypto AI platform",
  themeColor: "#06060a",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${inter.variable} ${plexMono.variable} bg-[#06060a] text-white`}>
        {children}
      </body>
    </html>
  );
}
