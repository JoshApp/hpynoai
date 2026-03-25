import type { SessionConfig } from '../session';
import { relax } from './relax';
import { relaxV3 } from './relax-v3';
import { sleep } from './sleep';
import { erotic } from './erotic';
import { focus } from './focus';

export const sessions: SessionConfig[] = [
  relaxV3,
  relax,
  sleep,
  erotic,
  focus,
];

export function getSession(id: string): SessionConfig | undefined {
  return sessions.find((s) => s.id === id);
}

export { relax, relaxV3, sleep, erotic, focus };
