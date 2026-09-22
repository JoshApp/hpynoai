/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath, URL } from 'node:url';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

/** Imports .vert/.frag files as strings. */
function shaderLoader(): Plugin {
  return {
    name: 'shader-loader',
    transform(code, id) {
      if (id.endsWith('.vert') || id.endsWith('.frag') || id.endsWith('.glsl')) {
        return { code: `export default ${JSON.stringify(code)};`, map: null };
      }
      return null;
    },
  };
}

/**
 * Dev-only authoring endpoints for the preview tool:
 *   GET  /__hpyno/script/:id      → { script, overrides }
 *   POST /__hpyno/overrides/:id   ← JSON overrides → written to scripts/<id>.overrides.json
 *   POST /__hpyno/assemble/:id    → runs the free assemble step, returns its log
 */
function authoringApi(): Plugin {
  const root = fileURLToPath(new URL('.', import.meta.url));
  const scriptPath = (id: string): string => resolve(root, 'scripts', `${id}.v3.txt`);
  const overridesPath = (id: string): string => resolve(root, 'scripts', `${id}.overrides.json`);
  const safe = (id: string): boolean => /^[a-z0-9_-]+$/i.test(id);
  return {
    name: 'hpyno-authoring-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__hpyno', (req, res) => {
        const fm = /^\/file\/([a-zA-Z0-9_.-]+\.mp3)$/.exec(req.url ?? '');
        if (fm) {
          const fp = resolve(root, 'content-src', 'auditions', fm[1]!);
          if (!existsSync(fp)) { res.statusCode = 404; res.end('no file'); return; }
          res.setHeader('content-type', 'audio/mpeg'); res.end(readFileSync(fp)); return;
        }
        const m = /^\/(script|overrides|assemble|audition|fx)\/([^/?]+)/.exec(req.url ?? '');
        if (!m || !safe(m[2]!)) { res.statusCode = 404; res.end('not found'); return; }
        const [, action, id] = m;
        const json = (code: number, body: unknown): void => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
        if (action === 'script' && req.method === 'GET') {
          if (!existsSync(scriptPath(id!))) return json(404, { error: 'no script' });
          const overrides = existsSync(overridesPath(id!)) ? JSON.parse(readFileSync(overridesPath(id!), 'utf8')) : { cues: {}, silences: {} };
          return json(200, { script: readFileSync(scriptPath(id!), 'utf8'), overrides });
        }
        if (action === 'fx' && req.method === 'GET') {
          const r = spawnSync(resolve(root, '.venv/bin/python'), ['-m', 'hpyno_pipeline', 'fx', scriptPath(id!)],
            { cwd: root, env: { ...process.env, PYTHONPATH: resolve(root, 'pipeline') }, encoding: 'utf8', timeout: 60000 });
          if (r.status !== 0) return json(500, { error: r.stderr });
          res.statusCode = 200; res.setHeader('content-type', 'application/json'); res.end(r.stdout); return;
        }
        if (req.method !== 'POST') return json(405, { error: 'method' });
        let body = '';
        req.on('data', (c: Buffer) => { body += c.toString(); });
        req.on('end', () => {
          try {
            if (action === 'overrides') {
              const parsed = JSON.parse(body || '{}');
              writeFileSync(overridesPath(id!), JSON.stringify({ cues: parsed.cues ?? {}, silences: parsed.silences ?? {}, fx: parsed.fx ?? {} }, null, 1) + '\n');
              return json(200, { ok: true });
            }
            const py = (args: string[]) => spawnSync(resolve(root, '.venv/bin/python'), ['-m', 'hpyno_pipeline', ...args],
              { cwd: root, env: { ...process.env, PYTHONPATH: resolve(root, 'pipeline') }, encoding: 'utf8', timeout: 600000 });
            if (action === 'audition') {
              const stage = new URL(req.url ?? '', 'http://x').searchParams.get('stage') ?? '';
              if (!/^[a-z0-9_-]+$/i.test(stage)) return json(400, { error: 'bad stage' });
              const r = py(['audition', '--script', scriptPath(id!), '--stage', stage]);
              const files = [...(r.stdout || '').matchAll(/^(\S+): .*→ .*\/([^/]+\.mp3)/gm)].map(x => ({ model: x[1], url: `/__hpyno/file/${x[2]}` }));
              return json(r.status === 0 ? 200 : 500, { ok: r.status === 0, files, log: (r.stdout || '') + (r.stderr || '') });
            }
            const r = py(['assemble', scriptPath(id!)]);
            return json(r.status === 0 ? 200 : 500, { ok: r.status === 0, log: (r.stdout || '') + (r.stderr || '') });
          } catch (e) { return json(500, { error: String(e) }); }
        });
      });
    },
  };
}

export default defineConfig({
  base: '/hpynoai/',
  plugins: [shaderLoader(), svelte(), authoringApi()],
  resolve: {
    alias: {
      '@engine': fileURLToPath(new URL('./src/engine', import.meta.url)),
      '@player': fileURLToPath(new URL('./src/player', import.meta.url)),
      '@content': fileURLToPath(new URL('./src/content', import.meta.url)),
      '@app': fileURLToPath(new URL('./src/app', import.meta.url)),
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
