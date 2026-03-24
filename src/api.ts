/**
 * window.__HYPNO__ — programmatic API for AI agents via Chrome DevTools.
 *
 * All return values are plain JSON-serializable objects (no class instances,
 * no circular refs) so `evaluate_script` can pass them back over CDP.
 */

import type { Timeline, TimelineBlock } from './timeline';
import type { StateMachine } from './state-machine';
import type { InteractionManager } from './interactions';
import type { BreathController } from './breath';
import type { NarrationEngine } from './narration';
import type { EventBus } from './events';

export interface HypnoAPIDeps {
  timeline: Timeline;
  machine: StateMachine;
  interactions: InteractionManager;
  breath: BreathController;
  narration: NarrationEngine;
  bus: EventBus;
}

export interface TimelineSnapshot {
  position: number;
  blockIndex: number;
  block: { kind: string; stageName: string; start: number; end: number; duration: number };
  blockElapsed: number;
  blockProgress: number;
  intensity: number;
  breath: { value: number; stage: string; cycleDuration: number } | null;
  currentText: string | null;
  speed: number;
  paused: boolean;
  complete: boolean;
  atBoundary: boolean;
}

export interface BlockInfo {
  index: number;
  kind: string;
  stageName: string;
  start: number;
  end: number;
  duration: number;
}

function blockToInfo(b: TimelineBlock, index: number): BlockInfo {
  return {
    index,
    kind: b.kind,
    stageName: b.stage.name,
    start: b.start,
    end: b.end,
    duration: b.duration,
  };
}

export interface HypnoAPI {
  seek(seconds: number): void;
  seekBlock(index: number): void;
  seekBlockByType(type: string, direction?: 'next' | 'prev'): void;
  seekStage(name: string): void;
  play(): void;
  pause(): void;
  step(direction?: 1 | -1): void;
  setSpeed(multiplier: number): void;
  getState(): TimelineSnapshot | null;
  getBlocks(): BlockInfo[];
  getStages(): string[];
  isPlaying(): boolean;
  getSessionId(): string | null;
  getPhase(): string;
  skipInteraction(): void;
}

export function createHypnoAPI(deps: HypnoAPIDeps): HypnoAPI {
  const { timeline, machine, interactions } = deps;

  return {
    seek(seconds: number): void {
      if (!timeline.started) return;
      timeline.seek(seconds);
    },

    seekBlock(index: number): void {
      const blocks = timeline.allBlocks;
      if (index < 0 || index >= blocks.length) return;
      timeline.seek(blocks[index].start);
    },

    seekBlockByType(type: string, direction: 'next' | 'prev' = 'next'): void {
      const blocks = timeline.allBlocks;
      if (blocks.length === 0) return;
      const current = timeline.currentIndex;

      if (direction === 'next') {
        for (let i = current + 1; i < blocks.length; i++) {
          if (blocks[i].kind === type) { timeline.seek(blocks[i].start); return; }
        }
      } else {
        for (let i = current - 1; i >= 0; i--) {
          if (blocks[i].kind === type) { timeline.seek(blocks[i].start); return; }
        }
      }
    },

    seekStage(name: string): void {
      const blocks = timeline.allBlocks;
      for (let i = 0; i < blocks.length; i++) {
        if (blocks[i].stage.name === name) { timeline.seek(blocks[i].start); return; }
      }
    },

    play(): void {
      if (timeline.started && timeline.paused) timeline.resume();
    },

    pause(): void {
      if (timeline.started && !timeline.paused) timeline.pause();
    },

    step(direction: 1 | -1 = 1): void {
      const blocks = timeline.allBlocks;
      const target = timeline.currentIndex + direction;
      if (target >= 0 && target < blocks.length) {
        timeline.seek(blocks[target].start);
      }
    },

    setSpeed(multiplier: number): void {
      timeline.setSpeed(multiplier);
    },

    getState(): TimelineSnapshot | null {
      const s = timeline.lastState;
      if (!s) {
        if (timeline.started) return null;
        // Not in a session — return minimal state
        return null;
      }

      const breathData = s.breathValue !== null && s.breathStage
        ? {
            value: s.breathValue,
            stage: s.breathStage,
            cycleDuration: s.breathPattern
              ? s.breathPattern.inhale + (s.breathPattern.holdIn ?? 0) + s.breathPattern.exhale + (s.breathPattern.holdOut ?? 0)
              : 0,
          }
        : null;

      return {
        position: s.position,
        blockIndex: s.blockIndex,
        block: {
          kind: s.block.kind,
          stageName: s.block.stage.name,
          start: s.block.start,
          end: s.block.end,
          duration: s.block.duration,
        },
        blockElapsed: s.blockElapsed,
        blockProgress: s.blockProgress,
        intensity: s.intensity,
        breath: breathData,
        currentText: s.currentText,
        speed: timeline.speed,
        paused: timeline.paused,
        complete: s.complete,
        atBoundary: s.atBoundary,
      };
    },

    getBlocks(): BlockInfo[] {
      return timeline.allBlocks.map((b, i) => blockToInfo(b, i));
    },

    getStages(): string[] {
      const seen = new Set<string>();
      const result: string[] = [];
      for (const b of timeline.allBlocks) {
        if (!seen.has(b.stage.name)) {
          seen.add(b.stage.name);
          result.push(b.stage.name);
        }
      }
      return result;
    },

    isPlaying(): boolean {
      return timeline.started && !timeline.paused;
    },

    getSessionId(): string | null {
      return machine.sessionId;
    },

    getPhase(): string {
      return machine.phase;
    },

    skipInteraction(): void {
      interactions.skip();
    },
  };
}

declare global {
  interface Window {
    __HYPNO__?: HypnoAPI;
  }
}
