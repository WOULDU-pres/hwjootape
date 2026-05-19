import { NextResponse } from 'next/server';
import { readInstallStatus, isAutoInstallSupported } from '@/lib/magic-layer/runner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  if (!isAutoInstallSupported()) {
    return NextResponse.json(
      { installed: false, installing: false, failed: false, autoInstallSupported: false, canFallback: true, message: 'Auto-install not supported on this platform.' },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const status = await readInstallStatus();
  return NextResponse.json(
    { ...status, autoInstallSupported: true },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
