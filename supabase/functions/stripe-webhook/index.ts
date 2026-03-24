import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14?target=deno";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, stripe-signature",
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");

  if (!stripeSecretKey || !webhookSecret) {
    return new Response(
      JSON.stringify({ error: "Stripe not configured" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  const stripe = new Stripe(stripeSecretKey, {
    apiVersion: "2024-06-20",
    httpClient: Stripe.createFetchHttpClient(),
  });

  // Verify webhook signature
  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return new Response(JSON.stringify({ error: "Missing signature" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const body = await req.text();
  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid signature";
    return new Response(JSON.stringify({ error: message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Supabase client with service_role key for DB writes
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  // Idempotency check — skip already-processed events
  const { data: existing } = await supabase
    .from("stripe_events")
    .select("id")
    .eq("event_id", event.id)
    .single();

  if (existing) {
    return new Response(JSON.stringify({ received: true, deduplicated: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Record event before processing (at-least-once delivery)
  await supabase.from("stripe_events").insert({
    event_id: event.id,
    event_type: event.type,
    processed_at: new Date().toISOString(),
  });

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(supabase, event.data.object);
        break;

      case "customer.subscription.updated":
        await handleSubscriptionUpdated(supabase, event.data.object);
        break;

      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(supabase, event.data.object);
        break;

      case "invoice.payment_failed":
        await handlePaymentFailed(supabase, event.data.object);
        break;

      default:
        // Unhandled event type — acknowledge without processing
        break;
    }
  } catch (err) {
    // Log processing error but still return 200 to prevent Stripe retries
    // The event is already recorded for manual investigation
    console.error(`Error processing ${event.type} (${event.id}):`, err);
    await supabase.from("stripe_events").update({
      error: err instanceof Error ? err.message : "Unknown error",
    }).eq("event_id", event.id);
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});

// ─── Event Handlers ──────────────────────────────────────────────────

type SupabaseClient = ReturnType<typeof createClient>;

async function handleCheckoutCompleted(
  supabase: SupabaseClient,
  session: Stripe.Checkout.Session
) {
  const userId = session.metadata?.supabase_user_id;
  if (!userId) return;

  if (session.mode === "subscription" && session.subscription) {
    const subscriptionId =
      typeof session.subscription === "string"
        ? session.subscription
        : session.subscription.id;

    await supabase.from("subscriptions").upsert({
      user_id: userId,
      stripe_subscription_id: subscriptionId,
      stripe_customer_id: session.customer as string,
      status: "active",
      current_period_start: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }

  if (session.mode === "payment") {
    // One-time purchase — record in purchases table
    await supabase.from("purchases").insert({
      user_id: userId,
      stripe_session_id: session.id,
      stripe_customer_id: session.customer as string,
      amount_total: session.amount_total,
      currency: session.currency,
      status: "completed",
      metadata: session.metadata,
      created_at: new Date().toISOString(),
    });
  }
}

async function handleSubscriptionUpdated(
  supabase: SupabaseClient,
  subscription: Stripe.Subscription
) {
  const userId = subscription.metadata?.supabase_user_id;
  if (!userId) return;

  const update: Record<string, unknown> = {
    status: subscription.status,
    updated_at: new Date().toISOString(),
  };

  if (subscription.current_period_start) {
    update.current_period_start = new Date(
      subscription.current_period_start * 1000
    ).toISOString();
  }
  if (subscription.current_period_end) {
    update.current_period_end = new Date(
      subscription.current_period_end * 1000
    ).toISOString();
  }
  if (subscription.cancel_at_period_end !== undefined) {
    update.cancel_at_period_end = subscription.cancel_at_period_end;
  }

  await supabase
    .from("subscriptions")
    .update(update)
    .eq("user_id", userId)
    .eq("stripe_subscription_id", subscription.id);
}

async function handleSubscriptionDeleted(
  supabase: SupabaseClient,
  subscription: Stripe.Subscription
) {
  const userId = subscription.metadata?.supabase_user_id;
  if (!userId) return;

  await supabase
    .from("subscriptions")
    .update({
      status: "canceled",
      canceled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .eq("stripe_subscription_id", subscription.id);
}

async function handlePaymentFailed(
  supabase: SupabaseClient,
  invoice: Stripe.Invoice
) {
  const subscriptionId =
    typeof invoice.subscription === "string"
      ? invoice.subscription
      : invoice.subscription?.id;

  if (!subscriptionId) return;

  await supabase
    .from("subscriptions")
    .update({
      status: "past_due",
      updated_at: new Date().toISOString(),
    })
    .eq("stripe_subscription_id", subscriptionId);
}
