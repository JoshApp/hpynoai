"""
TTS providers. `ElevenLabs` renders with timestamps and request stitching;
`Mock` synthesises tones with even timestamps for tests and dry runs.
Every render is cached by a content hash so edits re-render only what changed.
"""
from __future__ import annotations

import base64
import hashlib
import json
import math
import os
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Protocol

import numpy as np
import soundfile as sf

from .script import VoiceSettings

SR = 44100


@dataclass
class Rendered:
    audio: np.ndarray          # float32 mono at SR
    chars: list[str]
    starts: list[float]
    ends: list[float]
    request_id: Optional[str]
    cached: bool
    billed_chars: int


@dataclass
class RenderRequest:
    text: str
    voice: str
    model: str
    settings: VoiceSettings
    previous_text: str = ''
    next_text: str = ''
    previous_request_ids: tuple[str, ...] = ()
    seed: int = 0
    output_format: str = 'mp3_44100_128'

    def key(self) -> str:
        blob = json.dumps({
            'text': self.text, 'voice': self.voice, 'model': self.model,
            'settings': self.settings.__dict__, 'prev': self.previous_text, 'next': self.next_text,
            'prev_ids': list(self.previous_request_ids), 'seed': self.seed,
            **({'fmt': self.output_format} if self.output_format != 'mp3_44100_128' else {}),
        }, sort_keys=True)
        return hashlib.sha256(blob.encode()).hexdigest()[:24]


class Provider(Protocol):
    name: str
    def render(self, req: RenderRequest) -> Rendered: ...


class Cache:
    def __init__(self, root: Path):
        self.root = root
        root.mkdir(parents=True, exist_ok=True)

    def get(self, key: str) -> Optional[Rendered]:
        wav, meta = self.root / f'{key}.flac', self.root / f'{key}.json'
        if not (wav.exists() and meta.exists()):
            return None
        audio, sr = sf.read(wav, dtype='float32')
        if audio.ndim > 1: audio = audio.mean(axis=1)
        if sr != SR: raise RuntimeError(f'cache sample rate {sr} != {SR}')
        m = json.loads(meta.read_text())
        return Rendered(audio, m['chars'], m['starts'], m['ends'], m.get('request_id'), True, 0)

    def put(self, key: str, r: Rendered) -> None:
        sf.write(self.root / f'{key}.flac', r.audio, SR, subtype='PCM_16')
        (self.root / f'{key}.json').write_text(json.dumps({
            'chars': r.chars, 'starts': r.starts, 'ends': r.ends, 'request_id': r.request_id,
        }))


class NotCached(RuntimeError):
    pass


class CacheOnly:
    """Serves only cached renders; raises NotCached otherwise (free assemble step)."""
    name = 'cache-only'
    def __init__(self, cache: Cache): self.cache = cache
    def render(self, req: RenderRequest) -> Rendered:
        hit = self.cache.get(req.key())
        if not hit: raise NotCached(f'segment not in cache ({len(req.text)} chars): {req.text[:60]}…')
        return hit


class Cached:
    """Wraps a provider with the cache."""
    def __init__(self, inner: Provider, cache: Cache):
        self.inner, self.cache = inner, cache
        self.name = inner.name

    def render(self, req: RenderRequest) -> Rendered:
        key = req.key()
        hit = self.cache.get(key)
        if hit: return hit
        r = self.inner.render(req)
        self.cache.put(key, r)
        return r


# ── Mock ──

class Mock:
    name = 'mock'
    CHARS_PER_SEC = 13.0

    def render(self, req: RenderRequest) -> Rendered:
        text = req.text
        dur = max(0.6, len(text) / self.CHARS_PER_SEC / req.settings.speed)
        n = int(dur * SR)
        t = np.arange(n) / SR
        # a soft tone burst per word so energy looks speech-like
        audio = np.zeros(n, dtype=np.float32)
        per = dur / max(1, len(text))
        starts, ends = [], []
        for i, ch in enumerate(text):
            s, e = i * per, (i + 1) * per
            starts.append(round(s, 4)); ends.append(round(e, 4))
            if not ch.isspace():
                a, b = int(s * SR), int(e * SR)
                audio[a:b] += 0.12 * np.sin(2 * np.pi * 180 * t[a:b]) * np.hanning(max(1, b - a))
        return Rendered(audio, list(text), starts, ends, f'mock-{req.key()[:8]}', False, len(text))


# ── ElevenLabs ──

class ElevenLabs:
    name = 'elevenlabs'
    BASE = 'https://api.elevenlabs.io/v1'

    def __init__(self, api_key: str, output_format: str = 'mp3_44100_128', retries: int = 4):
        import requests  # local import keeps Mock usable without network deps
        self.http = requests.Session()
        self.http.headers.update({'xi-api-key': api_key, 'content-type': 'application/json'})
        self.output_format = output_format
        self.retries = retries

    def render(self, req: RenderRequest) -> Rendered:
        body: dict = {
            'text': req.text,
            'model_id': req.model,
            'voice_settings': {
                'stability': req.settings.stability,
                'similarity_boost': req.settings.similarity,
                'style': req.settings.style,
                'speed': req.settings.speed,
                'use_speaker_boost': req.settings.speaker_boost,
            },
            'seed': req.seed % 4294967295,
        }
        if req.previous_request_ids:
            body['previous_request_ids'] = list(req.previous_request_ids)[-3:]
        elif req.previous_text:
            body['previous_text'] = req.previous_text[-600:]
        if req.next_text:
            body['next_text'] = req.next_text[:600]
        url = f'{self.BASE}/text-to-speech/{req.voice}/with-timestamps'
        params = {'output_format': self.output_format}
        last: Optional[Exception] = None
        for attempt in range(self.retries):
            resp = self.http.post(url, params=params, json=body, timeout=180)
            if resp.status_code == 200:
                data = resp.json()
                audio = _decode(base64.b64decode(data['audio_base64']), self.output_format)
                al = data.get('alignment') or data.get('normalized_alignment') or {}
                return Rendered(
                    audio, al.get('characters', []), al.get('character_start_times_seconds', []),
                    al.get('character_end_times_seconds', []), resp.headers.get('request-id'), False, len(req.text),
                )
            if resp.status_code in (429, 500, 502, 503, 504):
                wait = 2.0 * (attempt + 1)
                time.sleep(wait); last = RuntimeError(f'{resp.status_code}: {resp.text[:200]}'); continue
            raise RuntimeError(f'ElevenLabs {resp.status_code}: {resp.text[:400]}')
        raise RuntimeError(f'ElevenLabs gave up after retries: {last}')

    def voices(self) -> list[dict]:
        r = self.http.get(f'{self.BASE}/voices', timeout=60); r.raise_for_status()
        return r.json().get('voices', [])

    def subscription(self) -> dict:
        r = self.http.get(f'{self.BASE}/user/subscription', timeout=60); r.raise_for_status()
        return r.json()


def _decode(blob: bytes, output_format: str) -> np.ndarray:
    """Decode API audio bytes to float32 mono at SR via ffmpeg."""
    if output_format.startswith('pcm_'):
        rate = int(output_format.split('_')[1])
        pcm = np.frombuffer(blob, dtype='<i2').astype(np.float32) / 32768.0
        if rate == SR: return pcm
        return _resample(pcm, rate)
    p = subprocess.run(
        ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-f', 'f32le', '-ac', '1', '-ar', str(SR), 'pipe:1'],
        input=blob, capture_output=True, check=True,
    )
    return np.frombuffer(p.stdout, dtype=np.float32).copy()


def _resample(x: np.ndarray, rate: int) -> np.ndarray:
    from scipy.signal import resample_poly
    g = math.gcd(rate, SR)
    return resample_poly(x, SR // g, rate // g).astype(np.float32)


def make_provider(kind: str, cache_dir: Path) -> Cached | CacheOnly:
    if kind == 'cache-only':
        return CacheOnly(Cache(cache_dir / 'elevenlabs'))
    if kind == 'mock':
        inner: Provider = Mock()
    elif kind == 'elevenlabs':
        key = os.environ.get('ELEVENLABS_API_KEY')
        if not key:
            raise RuntimeError('ELEVENLABS_API_KEY not set (put it in .env)')
        inner = ElevenLabs(key)
    else:
        raise RuntimeError(f'unknown provider {kind}')
    return Cached(inner, Cache(cache_dir / kind))
