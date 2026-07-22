import { runWalletScanWorker } from '@/src/modules/walletScanWorker'

export async function POST(req: Request) {
  return await runWalletScanWorker(req);
}
