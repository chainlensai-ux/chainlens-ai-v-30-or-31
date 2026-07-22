import { kv } from "@/lib/server/kv";
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const key = searchParams.get("key");
  const value = await kv.get(key);
  return Response.json({ key, value });
}
