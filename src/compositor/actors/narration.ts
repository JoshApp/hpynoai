/**
 * NarrationActor — manages narration audio playback and TTS.
 *
 * Receives directives like { action: 'play-stage', stageName, offset }
 * and handles the NarrationEngine lifecycle. Exposes displayLine for
 * the TextActor to read (pull model).
 */

import type { Actor, ActorDirective, NarrationDirective, WorldInputs } from '../types';
import type { NarrationEngine } from '../../narration';
import type { Timeline } from '../../timeline';

export class NarrationActor implements Actor {
  name = 'narration';
  active = true;
  renderOrder = 0;    // no rendering, just audio management

  private narration: NarrationEngine;
  private timeline: Timeline;
  private _bound = false;
  private _wasPlaying = false;
  private lastDirectiveKey = '';

  constructor(narration: NarrationEngine, timeline: Timeline) {
    this.narration = narration;
    this.timeline = timeline;
  }

  get engine(): NarrationEngine { return this.narration; }

  setDirective(directive: ActorDirective): void {
    if (directive.type !== 'narration') return;
    const d = directive.directive as NarrationDirective;

    switch (d.action) {
      case 'play-stage': {
        // Only restart if stage changed OR this is a seek (offset differs significantly)
        const isNewStage = this.lastDirectiveKey !== `play:${d.stageName}`;
        const isSeek = !isNewStage && this.narration.isPlayingStage &&
          this.narration.stageAudioElement &&
          Math.abs(this.narration.stageAudioElement.currentTime - d.offset) > 0.5;

        if (isNewStage || isSeek) {
          this.lastDirectiveKey = `play:${d.stageName}`;
          this.narration.enterStage(d.stageName, d.offset);
          this._bound = false;
        }
        break;
      }
      case 'speak-tts': {
        const key = `tts:${d.text}`;
        if (key === this.lastDirectiveKey) return;
        this.lastDirectiveKey = key;
        this.narration.speakText(d.text);
        break;
      }
      case 'stop':
        if (this.lastDirectiveKey === 'stop') return;
        this.lastDirectiveKey = 'stop';
        this.narration.stopStagePlayback();
        this._bound = false;
        break;
    }
  }

  activate(directive?: ActorDirective): void {
    this.active = true;
    if (directive) this.setDirective(directive);
  }

  deactivate(): void {
    this.active = false;
    this.narration.stop();
    this.narration.stopStagePlayback();
    this._bound = false;
    this._wasPlaying = false;
    this.lastDirectiveKey = '';
  }

  update(inputs: WorldInputs, _dt: number): void {
    // Narration line tracking
    this.narration.update();

    // Audio clock binding — when narration starts playing, bind to timeline
    if (!this._bound && this.narration.isPlayingStage && this.narration.stageAudioElement) {
      const block = inputs.timeline?.block;
      if (block) {
        this.timeline.bindAudio(this.narration.stageAudioElement, block.start);
        this._bound = true;
      }
    }

    // Audio ended — unbind
    if (this._wasPlaying && !this.narration.isPlayingStage) {
      this.timeline.audioEnded();
      this._bound = false;
    }
    this._wasPlaying = this.narration.isPlayingStage;
  }
}
