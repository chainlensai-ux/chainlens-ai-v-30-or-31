import { NextRequest, NextResponse } from 'next/server';
import {
  createAuthedSupabaseClient,
  createAnonSupabaseClient,
  getOrCreateUserSettings,
  sanitizeSettingsUpdate,
  upsertUserSettings,
} from '@/lib/supabase/userSettings';

async function getAuthenticatedUser(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.toLowerCase().startsWith('bearer ')) {
    return { error: 'Missing bearer token.', userId: null };
  }

  const token = authHeader.slice(7).trim();
  if (!token) return { error: 'Missing bearer token.', userId: null };

  const authSupabase = createAnonSupabaseClient();
  if (!authSupabase) {
    return { error: 'Settings service unavailable.', userId: null };
  }
  const { data, error } = await authSupabase.auth.getUser(token);
  if (error || !data.user) {
    return { error: 'Unauthorized.', userId: null };
  }

  const supabase = createAuthedSupabaseClient(token);
  if (!supabase) {
    return { error: 'Settings service unavailable.', userId: null };
  }

  return { error: null, userId: data.user.id, supabase };
}

export async function GET(request: NextRequest) {
  const auth = await getAuthenticatedUser(request);
  if (auth.error || !auth.userId || !auth.supabase) {
    return NextResponse.json({ error: auth.error ?? 'Unauthorized.' }, { status: 401 });
  }

  const result = await getOrCreateUserSettings(auth.supabase, auth.userId);
  const betaAllElite = process.env.BETA_ALL_ELITE === 'true';
  const rawPlan = result.settings.plan === 'elite' || result.settings.plan === 'pro' ? result.settings.plan : 'free';
  const betaEliteActive = betaAllElite;
  const effectivePlan = betaEliteActive ? 'elite' : rawPlan;
  const plan = effectivePlan;
  const verifiedPlan = effectivePlan;
  const debugMode = request.nextUrl.searchParams.get('debug') === 'true';

  const diagnostics = (process.env.NODE_ENV !== 'production' || debugMode)
    ? {
        authenticated: true,
        userIdPresent: Boolean(auth.userId),
        hasSettingsRow: !result.error,
        plan,
        fallback: Boolean(result.error),
        ...(debugMode && { rawPlan, betaAllElite, settingsRowFound: !result.error }),
      }
    : undefined;

  const betaFields = betaEliteActive ? { betaEliteActive: true } : {};

  if (result.error) {
    return NextResponse.json(
      {
        settings: result.settings,
        plan,
        effectivePlan,
        verifiedPlan,
        subscription_status: result.settings.subscription_status ?? null,
        error: result.error,
        fallback: true,
        ...betaFields,
        diagnostics,
      },
      { status: 200 }
    );
  }

  return NextResponse.json(
    {
      settings: result.settings,
      plan,
      effectivePlan,
      verifiedPlan,
      subscription_status: result.settings.subscription_status ?? null,
      fallback: false,
      ...betaFields,
      diagnostics,
    },
    { status: 200 }
  );
}

export async function PATCH(request: NextRequest) {
  const auth = await getAuthenticatedUser(request);
  if (auth.error || !auth.userId || !auth.supabase) {
    return NextResponse.json({ error: auth.error ?? 'Unauthorized.' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (body && typeof body === 'object') {
    const blocked = ['id', 'user_id', 'created_at'];
    for (const key of blocked) {
      if (Object.prototype.hasOwnProperty.call(body, key)) {
        return NextResponse.json({ error: `Field "${key}" is not writable.` }, { status: 400 });
      }
    }
  }

  const { valid, invalidKeys } = sanitizeSettingsUpdate(body);
  if (invalidKeys.length > 0) {
    return NextResponse.json(
      { error: `Unknown or invalid fields: ${invalidKeys.join(', ')}` },
      { status: 400 }
    );
  }

  if (Object.keys(valid).length === 0) {
    return NextResponse.json({ error: 'No valid fields provided.' }, { status: 400 });
  }

  const result = await upsertUserSettings(auth.supabase, auth.userId, valid);
  if (result.error) {
    return NextResponse.json(
      { settings: result.settings, error: result.error, fallback: true },
      { status: 200 }
    );
  }

  return NextResponse.json({ settings: result.settings }, { status: 200 });
}
