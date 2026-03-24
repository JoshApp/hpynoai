/**
 * Upgrade prompt overlay — shown when users try to access locked content.
 * DOM overlay on top of the 3D scene. Does not navigate away.
 */

import type { Entitlements, Tier } from './entitlements';

export interface UpgradeContext {
  type: 'session' | 'feature';
  id: string;
  name: string;
}

type UpgradeHandler = (tier: string) => void;

const DISMISS_STORAGE_KEY = 'hpyno-upgrade-dismissals';
const DISMISS_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── Tier descriptions ────────────────────────────────────────────────

const TIER_INFO: Record<Exclude<Tier, 'free'>, { label: string; desc: string }> = {
  premium: {
    label: 'Premium',
    desc: 'All sessions, all experience levels, microphone enabled',
  },
  pro: {
    label: 'Pro',
    desc: 'Everything in Premium + custom breath patterns',
  },
};

function tierForContent(context: UpgradeContext): Exclude<Tier, 'free'> {
  // custom-breath is the only pro-exclusive feature
  if (context.type === 'feature' && context.id === 'custom-breath') return 'pro';
  return 'premium';
}

// ── Upgrade Prompt class ─────────────────────────────────────────────

export class UpgradePrompt {
  private entitlements: Entitlements;
  private overlay: HTMLDivElement | null = null;
  private upgradeHandlers: Set<UpgradeHandler> = new Set();
  private currentContext: UpgradeContext | null = null;

  constructor(entitlements: Entitlements) {
    this.entitlements = entitlements;
  }

  show(context: UpgradeContext, explicit = true): void {
    // Check cooldown for auto-prompts (non-explicit)
    if (!explicit && this.isDismissedRecently(context)) return;

    this.currentContext = context;
    this.hide(); // remove any existing overlay

    const tier = tierForContent(context);
    const info = TIER_INFO[tier];

    // Create overlay
    const overlay = document.createElement('div');
    overlay.id = 'upgrade-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Upgrade to unlock content');

    // Backdrop
    const backdrop = document.createElement('div');
    backdrop.className = 'upgrade-backdrop';
    backdrop.addEventListener('click', () => this.dismiss());
    overlay.appendChild(backdrop);

    // Card
    const card = document.createElement('div');
    card.className = 'upgrade-card';

    // Close button
    const closeBtn = document.createElement('button');
    closeBtn.className = 'upgrade-close';
    closeBtn.textContent = '\u2715';
    closeBtn.title = 'Maybe later';
    closeBtn.addEventListener('click', () => this.dismiss());
    card.appendChild(closeBtn);

    // Content label
    const label = document.createElement('div');
    label.className = 'upgrade-content-label';
    const icon = context.type === 'session' ? '\uD83C\uDFB5' : '\u2728'; // 🎵 or ✨
    label.textContent = `${icon} ${context.name}`;
    card.appendChild(label);

    // Tier message
    const msg = document.createElement('div');
    msg.className = 'upgrade-tier-msg';
    msg.textContent = `${info.label} unlocks this`;
    card.appendChild(msg);

    // Description
    const desc = document.createElement('div');
    desc.className = 'upgrade-desc';
    desc.textContent = info.desc;
    card.appendChild(desc);

    // CTA buttons
    const ctas = document.createElement('div');
    ctas.className = 'upgrade-ctas';

    const subBtn = document.createElement('button');
    subBtn.className = 'upgrade-btn upgrade-btn-primary';
    subBtn.textContent = `Subscribe to ${info.label}`;
    subBtn.addEventListener('click', () => this.handleSubscribe(tier));
    ctas.appendChild(subBtn);

    // One-time purchase option for sessions only
    if (context.type === 'session') {
      const buyBtn = document.createElement('button');
      buyBtn.className = 'upgrade-btn upgrade-btn-secondary';
      buyBtn.textContent = `Buy this session`;
      buyBtn.addEventListener('click', () => this.handleBuySession(context.id));
      ctas.appendChild(buyBtn);
    }

    card.appendChild(ctas);

    // Dismiss text
    const dismissText = document.createElement('div');
    dismissText.className = 'upgrade-dismiss-text';
    dismissText.textContent = 'Maybe later';
    dismissText.addEventListener('click', () => this.dismiss());
    card.appendChild(dismissText);

    overlay.appendChild(card);
    document.body.appendChild(overlay);
    this.overlay = overlay;

    // Focus trap: focus the close button
    closeBtn.focus();

    // Escape key handler
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.dismiss();
      }
      // Focus trap: Tab cycles within the card
      if (e.key === 'Tab') {
        const focusable = card.querySelectorAll<HTMLElement>('button, [tabindex]');
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeydown);
    overlay.dataset.keydownCleanup = 'true';
    (overlay as unknown as { _keydownCleanup: () => void })._keydownCleanup = () => {
      document.removeEventListener('keydown', onKeydown);
    };
  }

  hide(): void {
    if (this.overlay) {
      (this.overlay as unknown as { _keydownCleanup?: () => void })._keydownCleanup?.();
      this.overlay.remove();
      this.overlay = null;
    }
  }

  onUpgrade(handler: UpgradeHandler): () => void {
    this.upgradeHandlers.add(handler);
    return () => { this.upgradeHandlers.delete(handler); };
  }

  // ── Private handlers ───────────────────────────────────────────────

  private handleSubscribe(tier: string): void {
    // Notify handlers — the actual Stripe redirect will be handled by
    // the payments module once #3234 (create-checkout-session) is wired in.
    for (const handler of this.upgradeHandlers) {
      handler(tier);
    }
    this.hide();
  }

  private handleBuySession(sessionId: string): void {
    // One-time purchase flow — will be wired to Stripe once payments module exists
    for (const handler of this.upgradeHandlers) {
      handler(`session:${sessionId}`);
    }
    this.hide();
  }

  private dismiss(): void {
    if (this.currentContext) {
      this.recordDismissal(this.currentContext);
    }
    this.hide();
    this.currentContext = null;
  }

  // ── Cooldown tracking ──────────────────────────────────────────────

  private isDismissedRecently(context: UpgradeContext): boolean {
    const dismissals = this.loadDismissals();
    const key = `${context.type}:${context.id}`;
    const timestamp = dismissals[key];
    if (!timestamp) return false;
    return Date.now() - timestamp < DISMISS_COOLDOWN_MS;
  }

  private recordDismissal(context: UpgradeContext): void {
    const dismissals = this.loadDismissals();
    const key = `${context.type}:${context.id}`;
    dismissals[key] = Date.now();

    // Clean up old entries
    const now = Date.now();
    for (const k in dismissals) {
      if (now - dismissals[k] > DISMISS_COOLDOWN_MS) {
        delete dismissals[k];
      }
    }

    try {
      localStorage.setItem(DISMISS_STORAGE_KEY, JSON.stringify(dismissals));
    } catch {
      // localStorage full or unavailable
    }
  }

  private loadDismissals(): Record<string, number> {
    try {
      const raw = localStorage.getItem(DISMISS_STORAGE_KEY);
      if (!raw) return {};
      return JSON.parse(raw) as Record<string, number>;
    } catch {
      return {};
    }
  }
}
