import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const key    = process.env.GOPLUS_APP_KEY;
  const secret = process.env.GOPLUS_APP_SECRET;

  if (!key || !secret) {
    return NextResponse.json(
      { ok: false, error: "GoPlus credentials not configured." },
      { status: 500 }
    );
  }

  const address = req.nextUrl.searchParams.get("address")?.trim();
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return NextResponse.json(
      { ok: false, error: "Invalid or missing address parameter." },
      { status: 400 }
    );
  }

  try {
    // Obtain a short-lived access token from GoPlus
    const time = Math.floor(Date.now() / 1000);
    const sign = createHash("md5")
      .update(key + time + secret)
      .digest("hex")
      .toUpperCase();

    const tokenRes = await fetch("https://api.gopluslabs.io/api/v1/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_key: key, time, sign }),
      cache: "no-store",
    });

    if (!tokenRes.ok) {
      return NextResponse.json(
        { ok: false, error: "Failed to authenticate with GoPlus." },
        { status: 502 }
      );
    }

    const tokenJson = await tokenRes.json();
    const accessToken: string | undefined = tokenJson?.result?.access_token;

    if (!accessToken) {
      return NextResponse.json(
        { ok: false, error: "GoPlus did not return an access token." },
        { status: 502 }
      );
    }

    // Fetch token security data for Base (chain 8453)
    const securityRes = await fetch(
      `https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${address.toLowerCase()}`,
      {
        headers: {
          accept: "application/json",
          Authorization: accessToken,
        },
        cache: "no-store",
      }
    );

    if (!securityRes.ok) {
      return NextResponse.json(
        { ok: false, error: `GoPlus security API returned ${securityRes.status}.` },
        { status: 502 }
      );
    }

    const securityJson = await securityRes.json();

    return NextResponse.json({ ok: true, data: securityJson?.result ?? {} });
  } catch {
    return NextResponse.json(
      { ok: false, error: "GoPlus request failed." },
      { status: 500 }
    );
  }
}
