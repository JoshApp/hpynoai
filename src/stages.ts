/**
 * Stage system — manages progression through a session's stages.
 * Now driven by SessionStage[] from session configs instead of hardcoded data.
 */

import type { SessionStage, Interaction } from './session';
import { log } from './logger';

export class StageManager {
  private _stages: SessionStage[];
  private _currentIndex = 0;
  private stageStartTime = 0;
  private textIndex = 0;
  private lastTextTime = 0;
  private onText: (text: string) => void;
  private onStageChange: (stage: SessionStage, index: number) => void;
  private onInteraction: ((interaction: Interaction) => void) | null = null;
  private started = false;
  private speedMultiplier = 1;
  private virtualTimeOffset = 0;
  private lastRealTime = 0;

  // Fractionation state
  private fractionating = false;
  private fractionationStart = 0;
  private fractionationDipDuration = 4; // seconds to hold the dip
  private fractionationRampDuration = 3; // seconds to ramp back up

  // Interaction tracking
  private triggeredInteractions = new Set<string>();
  private paused = false; // paused during gate interactions
  private interactionActive = false; // true while an interaction is running
  private pauseStartReal = 0; // real time when pause began

  constructor(
    stages: SessionStage[],
    onText: (text: string) => void,
    onStageChange: (stage: SessionStage, index: number) => void,
  ) {
    this._stages = stages;
    this.onText = onText;
    this.onStageChange = onStageChange;
  }

  setInteractionHandler(handler: (interaction: Interaction) => void): void {
    this.onInteraction = handler;
  }

  private get virtualNow(): number {
    const realNow = performance.now() / 1000;
    return this.virtualTimeOffset + realNow;
  }

  start(): void {
    this.started = true;
    this.lastRealTime = performance.now() / 1000;
    this.virtualTimeOffset = 0;
    this.stageStartTime = this.virtualNow;
    this.lastTextTime = this.stageStartTime;
    this.triggeredInteractions.clear();
    this.onStageChange(this.currentStage, 0);
  }

  get stages(): SessionStage[] {
    return this._stages;
  }

  get currentStage(): SessionStage {
    return this._stages[this._currentIndex];
  }

  get currentIndex(): number {
    return this._currentIndex;
  }

  get stageCount(): number {
    return this._stages.length;
  }

  /** Current breath cycle duration in seconds */
  get breathCycle(): number {
    return this.currentStage.breathCycle;
  }

  /** Current spiral speed multiplier */
  get spiralSpeed(): number {
    return this.currentStage.spiralSpeed;
  }

  /** Elapsed time within current stage */
  get stageElapsed(): number {
    return this.virtualNow - this.stageStartTime;
  }

  get intensity(): number {
    if (!this.started) return 0;

    const stage = this.currentStage;
    const nextStage = this._stages[this._currentIndex + 1];
    const elapsed = this.stageElapsed;
    const progress = Math.min(elapsed / stage.duration, 1);

    let baseIntensity = stage.intensity;

    // Fractionation: brief intensity dip at start of stage
    if (this.fractionating) {
      const fracElapsed = this.virtualNow - this.fractionationStart;
      const dip = stage.fractionationDip!;

      if (fracElapsed < this.fractionationDipDuration) {
        // In the dip
        const dipProgress = fracElapsed / this.fractionationDipDuration;
        baseIntensity = dip + (stage.intensity - dip) * dipProgress * 0.2;
      } else if (fracElapsed < this.fractionationDipDuration + this.fractionationRampDuration) {
        // Ramping back up
        const rampProgress = (fracElapsed - this.fractionationDipDuration) / this.fractionationRampDuration;
        const smoothRamp = rampProgress * rampProgress * (3 - 2 * rampProgress); // smoothstep
        baseIntensity = dip + (stage.intensity - dip) * (0.2 + 0.8 * smoothRamp);
      } else {
        this.fractionating = false;
        baseIntensity = stage.intensity;
      }
    }

    // Smooth interpolation to next stage
    if (!this.fractionating && nextStage && progress > 0.85) {
      const blend = (progress - 0.85) / 0.15;
      baseIntensity = stage.intensity + (nextStage.intensity - stage.intensity) * blend;
    }

    return baseIntensity;
  }

  /** Pause stage progression (for interactions) */
  pause(): void {
    this.paused = true;
    this.interactionActive = true;
    this.pauseStartReal = performance.now() / 1000;
  }

  /** Resume stage progression */
  resume(): void {
    if (!this.paused) return; // Guard: resume without pause would corrupt virtual time
    // Subtract pause duration so the stage doesn't fast-forward
    const pauseDuration = performance.now() / 1000 - this.pauseStartReal;
    this.virtualTimeOffset -= pauseDuration;

    this.paused = false;
    this.interactionActive = false;
    this.lastRealTime = performance.now() / 1000;
    // Reset text timer so text doesn't fire immediately after interaction ends
    this.lastTextTime = this.virtualNow;
  }

  /** Compensate for time spent tabbed away — prevents fast-forwarding through stages */
  compensateForPause(seconds: number): void {
    this.virtualTimeOffset -= seconds;
    this.lastRealTime = performance.now() / 1000;
    log.info('stages', `Compensated virtual time by -${seconds.toFixed(1)}s`);
  }

  /** Advance to the next stage immediately */
  advanceStage(): void {
    if (this._currentIndex >= this._stages.length - 1) return;
    this._currentIndex++;
    const now = this.virtualNow;
    this.stageStartTime = now;
    this.textIndex = 0;
    this.lastTextTime = now;
    this.triggeredInteractions.clear();

    const newStage = this.currentStage;
    if (newStage.fractionationDip != null) {
      this.fractionating = true;
      this.fractionationStart = now;
    }
    this.onStageChange(newStage, this._currentIndex);
  }

  /** Force-trigger the next pending interaction for the current stage */
  triggerPendingInteraction(): void {
    if (!this.started || !this.onInteraction) return;
    const stage = this.currentStage;
    if (!stage.interactions) return;

    for (const interaction of stage.interactions) {
      const key = `${this._currentIndex}:${interaction.type}:${interaction.triggerAt}`;
      if (!this.triggeredInteractions.has(key)) {
        this.triggeredInteractions.add(key);
        this.onInteraction(interaction);
        return;
      }
    }
  }

  triggerNextText(): void {
    if (!this.started) return;
    const stage = this.currentStage;
    if (stage.texts.length === 0) return;
    const text = stage.texts[this.textIndex % stage.texts.length];
    this.onText(text);
    this.textIndex++;
    this.lastTextTime = this.virtualNow;
  }

  update(): void {
    if (!this.started) return;

    // Accumulate virtual time
    const realNow = performance.now() / 1000;
    const realDelta = realNow - this.lastRealTime;
    this.lastRealTime = realNow;
    if (!this.paused) {
      this.virtualTimeOffset += realDelta * (this.speedMultiplier - 1);
    }

    if (this.paused) return;

    const now = this.virtualNow;
    const elapsed = now - this.stageStartTime;
    const stage = this.currentStage;

    // Check for interaction triggers (before text — interactions take priority)
    if (stage.interactions && this.onInteraction) {
      for (const interaction of stage.interactions) {
        const key = `${this._currentIndex}:${interaction.type}:${interaction.triggerAt}`;
        if (!this.triggeredInteractions.has(key) && elapsed >= interaction.triggerAt) {
          this.triggeredInteractions.add(key);
          this.onInteraction(interaction);
          // Interaction fired — skip text this frame and until interaction completes
          return;
        }
      }
    }

    // Show text suggestions at interval — but NEVER while an interaction is active
    if (!this.interactionActive && stage.texts.length > 0 && now - this.lastTextTime >= stage.textInterval) {
      const text = stage.texts[this.textIndex % stage.texts.length];
      this.onText(text);
      this.textIndex++;
      this.lastTextTime = now;
    }

    // Advance to next stage
    if (elapsed >= stage.duration && this._currentIndex < this._stages.length - 1) {
      this._currentIndex++;
      this.stageStartTime = now;
      this.textIndex = 0;
      this.lastTextTime = now;
      this.triggeredInteractions.clear();

      // Start fractionation if the new stage has a dip
      const newStage = this.currentStage;
      if (newStage.fractionationDip != null) {
        this.fractionating = true;
        this.fractionationStart = now;
      }

      this.onStageChange(newStage, this._currentIndex);
    }
  }

  get isComplete(): boolean {
    if (!this.started) return false;
    const elapsed = this.stageElapsed;
    return this._currentIndex === this._stages.length - 1 && elapsed >= this.currentStage.duration;
  }

  // ── Dev mode helpers ──

  setSpeedMultiplier(m: number): void {
    this.speedMultiplier = m;
  }

  /** Resume at a specific stage — used by HMR to restart the current section cleanly.
   *  Unlike start() + jumpToStage(), this fires onStageChange exactly once. */
  resumeAt(index: number): void {
    this.started = true;
    this.lastRealTime = performance.now() / 1000;
    this.virtualTimeOffset = 0;
    this.jumpToStage(index);
  }

  jumpToStage(index: number): void {
    if (index < 0 || index >= this._stages.length) return;
    this._currentIndex = index;
    this.fractionating = false;
    this.paused = false;
    this.interactionActive = false;
    const now = this.virtualNow;
    this.stageStartTime = now;
    this.textIndex = 0;
    this.lastTextTime = now;
    this.triggeredInteractions.clear();
    this.onStageChange(this.currentStage, index);
  }

  reset(): void {
    this._currentIndex = 0;
    this.speedMultiplier = 1;
    this.virtualTimeOffset = 0;
    this.lastRealTime = performance.now() / 1000;
    this.stageStartTime = this.virtualNow;
    this.textIndex = 0;
    this.lastTextTime = this.stageStartTime;
    this.fractionating = false;
    this.paused = false;
    this.interactionActive = false;
    this.triggeredInteractions.clear();
    this.started = true;
    this.onStageChange(this.currentStage, 0);
  }

  /** Replace stages (for session switching) */
  setStages(stages: SessionStage[]): void {
    this._stages = stages;
    this.reset();
  }
}
