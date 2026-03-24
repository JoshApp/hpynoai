/**
 * Client-side payments module — talks to Supabase Edge Functions
 * for Stripe checkout and customer portal flows.
 *
 * Requires VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY env vars.
 */

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

function getFunctionsUrl(): string {
  if (!SUPABASE_URL) throw new Error('VITE_SUPABASE_URL not configured');
  return `${SUPABASE_URL}/functions/v1`;
}

function getHeaders(accessToken: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${accessToken}`,
    'apikey': SUPABASE_ANON_KEY || '',
  };
}

/**
 * Start a Stripe Checkout session and redirect the user.
 * @param accessToken - Supabase JWT from the authenticated user
 * @param priceKey - Price key (e.g. "monthly", "yearly")
 * @param sessionId - Optional hypno session ID for metadata
 */
export async function startCheckout(
  accessToken: string,
  priceKey: string,
  sessionId?: string,
): Promise<void> {
  const res = await fetch(`${getFunctionsUrl()}/create-checkout-session`, {
    method: 'POST',
    headers: getHeaders(accessToken),
    body: JSON.stringify({ priceKey, sessionId }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Checkout failed (${res.status})`);
  }

  const { url } = await res.json();
  if (url) window.location.href = url;
}

/**
 * Open the Stripe Customer Portal for subscription management.
 * @param accessToken - Supabase JWT from the authenticated user
 */
export async function openPortal(accessToken: string): Promise<void> {
  const res = await fetch(`${getFunctionsUrl()}/create-portal-session`, {
    method: 'POST',
    headers: getHeaders(accessToken),
    body: JSON.stringify({}),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Portal failed (${res.status})`);
  }

  const { url } = await res.json();
  if (url) window.location.href = url;
}

/**
 * Check URL params for payment return status.
 * Call this on app init to show feedback after checkout redirect.
 */
export function checkPaymentReturn(): 'success' | 'cancelled' | 'return' | null {
  const params = new URLSearchParams(window.location.search);
  const checkout = params.get('checkout');
  const payment = params.get('payment');

  let result: 'success' | 'cancelled' | 'return' | null = null;

  if (checkout === 'success' || checkout === 'cancelled') {
    result = checkout;
  } else if (payment === 'return') {
    result = 'return';
  }

  if (result) {
    // Clean up all payment-related URL params without reload
    const url = new URL(window.location.href);
    url.searchParams.delete('checkout');
    url.searchParams.delete('session_id');
    url.searchParams.delete('payment');
    window.history.replaceState({}, '', url.toString());
  }

  return result;
}
