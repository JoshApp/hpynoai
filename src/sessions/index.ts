import type { SessionConfig } from '../session';
import { relax } from './relax';
import { relaxV2 } from './relax-v2';
import { sleep } from './sleep';
import { erotic } from './erotic';
import { focus } from './focus';

export const sessions: SessionConfig[] = [
  relaxV2,
  relax,
  sleep,
  erotic,
  focus,
];

export function getSession(id: string): SessionConfig | undefined {
  return sessions.find((s) => s.id === id);
}

export { relax, relaxV2, sleep, erotic, focus };
