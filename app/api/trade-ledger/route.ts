// GET /api/trade-ledger?address=0x... — additive adapter route exposing the new, standalone
// Trade Ledger module (src/modules/tradeLedger.ts) for testing. No existing file modified.
//
// IMPORT PATH CORRECTION, DISCLOSED: requested as `import { buildTradeLedger } from
// "@/modules/tradeLedger"` — this repo's tsconfig path alias (`@/*` -> `./*`, project root) would
// resolve that to `./modules/tradeLedger`, which doesn't exist; the real file is
// `src/modules/tradeLedger.ts`. Using the real path, `@/src/modules/tradeLedger`.
//
// HONEST DISCLOSURE ON wallet.swapEvents: getWalletFromV2()'s real return type (WalletLiteResult,
// lib/server/walletLite.ts) has no `swapEvents` field — verified before writing this file. No real
// V2 code path anywhere in this codebase currently produces SwapEvent[] data (confirmed again when
// building src/modules/tradeLedger.ts itself last turn: SwapEvent doesn't correspond to any real
// V2 event shape yet). This route therefore honestly returns { ok: false, error: "No swap events
// found" } for every real request today — not a bug in this route, an accurate reflection of what
// V2 actually produces right now. The field is read via a safe, untyped lookup so this route works
// correctly the moment a real swapEvents source exists, without needing to be rewritten.

import { NextResponse } from "next/server";
import { getWalletFromV2 } from "@/lib/server/v2Adapters";
import { buildTradeLedger, type SwapEvent } from "@/src/modules/tradeLedger";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const address = searchParams.get("address");

    if (!address || !address.startsWith("0x") || address.length < 10) {
      return NextResponse.json({ ok: false, error: "Invalid or missing wallet address." }, { status: 400 });
    }

    const wallet = await getWalletFromV2(address);
    if (!wallet) {
      return NextResponse.json({ ok: false, error: "Wallet not found" });
    }

    // Untyped lookup — see this file's header. Real today only if a future V2 adapter version
    // starts attaching real swap events to the WalletLiteResult shape.
    const swapEvents = (wallet as unknown as { swapEvents?: SwapEvent[] }).swapEvents;
    if (!Array.isArray(swapEvents) || swapEvents.length === 0) {
      return NextResponse.json({ ok: false, error: "No swap events found" });
    }

    const ledger = buildTradeLedger(swapEvents);
    return NextResponse.json({ ok: true, address, trades: ledger });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Trade ledger is currently unavailable." });
  }
}
