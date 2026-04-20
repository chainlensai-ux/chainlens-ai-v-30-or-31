export async function scanTokenCommand(address: string) {
  if (!address) {
    return { ok: false, message: "No token address provided." };
  }

  const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL}/api/scan-token`, {
    method: "POST",
    body: JSON.stringify({ address }),
  });

  const data = await res.json();

  return {
    ok: true,
    message: "Token scan complete.",
    data,
  };
}
