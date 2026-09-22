import { mount } from 'svelte';
import './app/tokens.css';
import App from './app/App.svelte';
import { Engine } from '@engine/engine';

const canvas = document.getElementById('world') as HTMLCanvasElement | null;
const target = document.getElementById('app');
if (!canvas || !target) throw new Error('missing #world or #app');

const engine = new Engine(canvas);
engine.start();

mount(App, { target, props: { engine } });

if (import.meta.env.DEV) (window as unknown as { __hpyno: unknown }).__hpyno = engine;

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => { navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {}); });
}
