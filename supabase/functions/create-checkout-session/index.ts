import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14?target=deno";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    // Verify JWT and get user
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");

    if (!stripeSecretKey) {
      return new Response(
        JSON.stringify({ error: "Stripe not configured" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Parse request body
    const { priceKey, sessionId } = await req.json();

    if (!priceKey || typeof priceKey !== "string") {
      return new Response(
        JSON.stringify({ error: "priceKey is required" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Resolve priceKey to Stripe price ID from env
    // Expected env vars: STRIPE_PRICE_{KEY} e.g. STRIPE_PRICE_MONTHLY, STRIPE_PRICE_YEARLY
    const priceId = Deno.env.get(`STRIPE_PRICE_${priceKey.toUpperCase()}`);
    if (!priceId) {
      return new Response(
        JSON.stringify({ error: `Unknown price key: ${priceKey}` }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const stripe = new Stripe(stripeSecretKey, {
      apiVersion: "2024-06-20",
      httpClient: Stripe.createFetchHttpClient(),
    });

    // Look up or create Stripe customer for this user
    const customerId = await getOrCreateCustomer(stripe, supabase, user);

    // Determine payment mode from price
    const price = await stripe.prices.retrieve(priceId);
    const mode = price.type === "recurring" ? "subscription" : "payment";

    // Build checkout session params
    const siteUrl = Deno.env.get("SITE_URL") || "http://localhost:5173";
    const params: Stripe.Checkout.SessionCreateParams = {
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      mode,
      success_url: `${siteUrl}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/?checkout=cancelled`,
      metadata: {
        supabase_user_id: user.id,
        ...(sessionId ? { hypno_session_id: sessionId } : {}),
      },
    };

    // For subscriptions, allow promotion codes and set billing anchor
    if (mode === "subscription") {
      params.allow_promotion_codes = true;
      params.subscription_data = {
        metadata: { supabase_user_id: user.id },
      };
    }

    const checkoutSession = await stripe.checkout.sessions.create(params);

    return new Response(JSON.stringify({ url: checkoutSession.url }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

/**
 * Finds an existing Stripe customer for the Supabase user, or creates one.
 * Stores the mapping in the `profiles` table (stripe_customer_id column).
 */
async function getOrCreateCustomer(
  stripe: Stripe,
  supabase: ReturnType<typeof createClient>,
  user: { id: string; email?: string }
): Promise<string> {
  // Check profiles table for existing stripe_customer_id
  const { data: profile } = await supabase
    .from("profiles")
    .select("stripe_customer_id")
    .eq("id", user.id)
    .single();

  if (profile?.stripe_customer_id) {
    return profile.stripe_customer_id;
  }

  // Search Stripe by email in case customer exists but isn't linked
  if (user.email) {
    const existing = await stripe.customers.list({
      email: user.email,
      limit: 1,
    });
    if (existing.data.length > 0) {
      const customerId = existing.data[0].id;
      await supabase
        .from("profiles")
        .upsert({ id: user.id, stripe_customer_id: customerId });
      return customerId;
    }
  }

  // Create new Stripe customer
  const customer = await stripe.customers.create({
    email: user.email,
    metadata: { supabase_user_id: user.id },
  });

  await supabase
    .from("profiles")
    .upsert({ id: user.id, stripe_customer_id: customer.id });

  return customer.id;
}
