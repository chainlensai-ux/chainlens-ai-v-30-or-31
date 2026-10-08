import { NextResponse } from "next/server";
import { getRuntimeIdentity } from "@/lib/server/runtimeIdentity";

// Liveness + deployed-commit identity (runtimeCommitSha / vercelEnv / deploymentEnvironment only — see
// lib/server/runtimeIdentity.ts). Never cached, so the production domain always reports the deployment serving it.
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ status: "ok", ...getRuntimeIdentity() }, { headers: { "Cache-Control": "no-store" } });
}
