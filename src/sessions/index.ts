import type { SessionConfig } from '../session';
import { relax } from './relax';
import { sleep } from './sleep';
import { erotic } from './erotic';
import { focus } from './focus';

export const sessions: SessionConfig[] = [
  relax,
  sleep,
  erotic,
  focus,
];

export function getSession(id: string): SessionConfig | undefined {
  return sessions.find((s) => s.id === id);
}

export { relax, sleep, erotic, focus };
