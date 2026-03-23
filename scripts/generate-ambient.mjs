#!/usr/bin/env node
/**
 * Generate ambient background tracks for HPYNO sessions using Suno AI.
 *
 * Prerequisites:
 *   1. Get your Suno cookie from app.suno.com (DevTools → Network → clerk request → Cookie header)
 *   2. Set it: export SUNO_COOKIE="your_cookie_here"
 *   3. Run: node scripts/generate-ambient.mjs [session-id]
 *
 * This script uses the gcui-art/suno-api proxy (runs temporarily via Docker).
 * Alternatively, set SUNO_API_URL if you have the proxy running already.
 */

import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PUBLIC_AUDIO = path.join(PROJECT_ROOT, 'public', 'audio');

// Ambient prompts per session
const PROMPTS = {
  relax: {
    prompt: 'gentle relaxing ambient music, warm analog pads, soft reverb piano notes, no vocals, calm meditation, spa atmosphere, dreamy, loopable',
    title: 'HPYNO Relax Ambient',
  },
  sleep: {
    prompt: 'deep sleep ambient drone, very slow evolving pads, dark warm textures, no vocals, theta wave feel, distant bells, loopable, extremely calm',
    title: 'HPYNO Sleep Ambient',
  },
  focus: {
    prompt: 'minimal focus ambient, clean sine wave tones, subtle lo-fi texture, no vocals, gentle pulse, study music, concentration, loopable',
    title: 'HPYNO Focus Ambient',
  },
  surrender: {
    prompt: 'dark sensual ambient, warm deep analog pads, slow seductive pulse, breathy filtered textures, no vocals, intimate atmosphere, dim lighting mood, loopable',
    title: 'HPYNO Surrender Ambient',
  },
};

const SUNO_COOKIE = process.env.SUNO_COOKIE;
const SUNO_API_URL = process.env.SUNO_API_URL || 'http://localhost:3000';
const DOCKER_CONTAINER_NAME = 'hpyno-suno-api';

// ── Helpers ──

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}

// ── Docker management ──

function isProxyRunning() {
  try {
    execSync(`docker inspect ${DOCKER_CONTAINER_NAME} --format '{{.State.Running}}'`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function startProxy() {
  if (!SUNO_COOKIE) {
    console.error('\n❌ SUNO_COOKIE not set!\n');
    console.error('To get your cookie:');
    console.error('  1. Go to https://app.suno.com');
    console.error('  2. Open DevTools (F12) → Network tab');
    console.error('  3. Refresh the page');
    console.error('  4. Find a request to clerk.suno.com');
    console.error('  5. Copy the Cookie header value');
    console.error('  6. Run: export SUNO_COOKIE="your_cookie_value"');
    process.exit(1);
  }

  console.log('🚀 Starting Suno API proxy via Docker...');

  // Kill existing container if any
  try {
    execSync(`docker rm -f ${DOCKER_CONTAINER_NAME}`, { stdio: 'pipe' });
  } catch {}

  execSync(
    `docker run -d --name ${DOCKER_CONTAINER_NAME} -p 3000:3000 -e SUNO_COOKIE="${SUNO_COOKIE}" ghcr.io/gcui-art/suno-api`,
    { stdio: 'inherit' }
  );

  console.log('⏳ Waiting for proxy to start...');
}

async function waitForProxy(maxWait = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      await fetch(`${SUNO_API_URL}/api/get_limit`);
      return true;
    } catch {
      await sleep(2000);
    }
  }
  throw new Error('Proxy did not start in time');
}

function stopProxy() {
  try {
    execSync(`docker rm -f ${DOCKER_CONTAINER_NAME}`, { stdio: 'pipe' });
    console.log('🛑 Proxy stopped');
  } catch {}
}

// ── Suno generation ──

async function generateTrack(prompt, title) {
  console.log(`\n🎵 Generating: "${title}"`);
  console.log(`   Prompt: ${prompt.substring(0, 80)}...`);

  // Create generation
  const data = await fetchJSON(`${SUNO_API_URL}/api/custom_generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: '',
      tags: prompt,
      title: title,
      make_instrumental: true,
      wait_audio: false,
    }),
  });

  const clips = Array.isArray(data) ? data : [data];
  const clipIds = clips.map(c => c.id).filter(Boolean);

  if (clipIds.length === 0) {
    throw new Error('No clip IDs returned. Response: ' + JSON.stringify(data));
  }

  console.log(`   Clip IDs: ${clipIds.join(', ')}`);
  console.log('   ⏳ Waiting for generation...');

  // Poll for completion
  const audioUrl = await pollForAudio(clipIds[0]);
  return audioUrl;
}

async function pollForAudio(clipId, maxWait = 180000) {
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    await sleep(5000);

    try {
      const data = await fetchJSON(`${SUNO_API_URL}/api/get?ids=${clipId}`);
      const clips = Array.isArray(data) ? data : [data];
      const clip = clips[0];

      if (clip?.status === 'complete' && clip?.audio_url) {
        console.log(`   ✅ Complete!`);
        return clip.audio_url;
      }

      const elapsed = Math.round((Date.now() - start) / 1000);
      process.stdout.write(`\r   ⏳ Status: ${clip?.status || 'unknown'} (${elapsed}s)`);
    } catch (err) {
      // Retry on transient errors
    }
  }

  throw new Error(`Generation timed out after ${maxWait / 1000}s`);
}

async function downloadTrack(url, outputPath) {
  console.log(`   📥 Downloading to ${path.relative(PROJECT_ROOT, outputPath)}`);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, buffer);

  const sizeMB = (buffer.length / 1024 / 1024).toFixed(1);
  console.log(`   ✅ Saved (${sizeMB} MB)`);
}

// ── Main ──

async function main() {
  const args = process.argv.slice(2);
  const sessionIds = args.length > 0 ? args : Object.keys(PROMPTS);

  // Validate session IDs
  for (const id of sessionIds) {
    if (!PROMPTS[id]) {
      console.error(`❌ Unknown session: "${id}". Available: ${Object.keys(PROMPTS).join(', ')}`);
      process.exit(1);
    }
  }

  console.log('🎧 HPYNO Ambient Track Generator');
  console.log(`   Sessions: ${sessionIds.join(', ')}`);

  // Start proxy if needed
  let startedProxy = false;
  if (!process.env.SUNO_API_URL) {
    if (!isProxyRunning()) {
      startProxy();
      startedProxy = true;
    }
    await waitForProxy();
    console.log('✅ Proxy ready');
  }

  // Check credits
  try {
    const limit = await fetchJSON(`${SUNO_API_URL}/api/get_limit`);
    console.log(`   Credits remaining: ${limit.credits_left ?? 'unknown'}`);
  } catch {}

  // Generate tracks
  for (const id of sessionIds) {
    const { prompt, title } = PROMPTS[id];
    const outputPath = path.join(PUBLIC_AUDIO, id, 'ambient.mp3');

    // Skip if already exists
    if (fs.existsSync(outputPath)) {
      console.log(`\n⏭️  ${id}: ambient.mp3 already exists, skipping (delete to regenerate)`);
      continue;
    }

    try {
      const audioUrl = await generateTrack(prompt, title);
      await downloadTrack(audioUrl, outputPath);
    } catch (err) {
      console.error(`\n❌ ${id}: ${err.message}`);
    }
  }

  // Stop proxy if we started it
  if (startedProxy) {
    stopProxy();
  }

  console.log('\n🎉 Done! Update session configs to add:');
  console.log('   backgroundTrack: \'audio/{session-id}/ambient.mp3\'');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
