# Voice Generation Workflow

## Overview
Pre-generated voice lines using SexyVoice.ai API, stored as WAV files, played during sessions instead of browser TTS.

## API Details
- **Provider**: SexyVoice.ai
- **Endpoint**: `POST https://sexyvoice.ai/api/v1/speech`
- **Auth**: Bearer token in Authorization header
- **API Key**: stored in env var `SEXYVOICE_API_KEY`
- **Model**: `gpro` (Gemini-based, up to 1000 chars, free-text style descriptions)
- **Voice**: `zephyr` (multilingual, works great for whispery/dominant/seductive)
- **Response**: JSON with `url` to hosted WAV file on Cloudflare CDN
- **Cost**: ~300-400 credits per line, ~1000 credits per minute of audio
- **Current balance**: ~22k credits (started with ~35k)

## Styles We Use
| Key | Style Description | Use Case |
|-----|-------------------|----------|
| dominant | slow and deliberate, dripping with desire, soft dominance | Commands, deepening |
| seductive | slow, seductive, confident, low voice, intimate | Praise, invitation |
| commanding | breathy, dominant, commanding yet gentle, hypnotic | Escalation, possession |
| whisper | warm, sultry, close whisper, like speaking into someone's ear | Intimate moments |
| trance | calm hypnotic trance voice, sensual, slightly breathless | Trance states, calm |

## File Structure
```
public/audio/surrender/
  manifest.json           # Maps text → audio files + durations
  00_invitation_00.wav    # Stage narration lines
  00_invitation_01.wav
  ...
  04_afterglow_05.wav
  breath_intro.wav        # Interactive clips
  breath_instructions.wav
  breath_good.wav
  breath_continue.wav
  gate_deeper.wav
  gate_surrender.wav
  gate_response.wav
  deeper_now.wav
  sinking.wav
  responsive.wav
```

## Manifest Format
```json
{
  "session": "surrender",
  "voice": "zephyr",
  "model": "gpro",
  "stages": [
    {
      "name": "invitation",
      "lines": [
        {
          "file": "audio/surrender/00_invitation_00.wav",
          "text": "you chose to be here...",
          "style": "seductive",
          "duration": 6.33
        }
      ]
    }
  ],
  "interactive": [
    {
      "id": "breath_intro",
      "file": "audio/surrender/breath_intro.wav",
      "duration": 2.41
    }
  ]
}
```

## How It Works

### Generation
1. Write script in `scripts/surrender-script.json` (text + style per line)
2. Run `python3 scripts/generate-voices.py scripts/surrender-script.json`
3. Script calls API per line, downloads WAV, measures duration, writes manifest
4. Files saved to `public/audio/surrender/`
5. Skips existing files (safe to re-run)

### Playback
1. When a session starts, `main.ts` calls `narration.loadManifest('audio/{sessionId}/manifest.json')`
2. Manifest builds a text → audio file lookup (normalized lowercase)
3. When `narration.speak(text)` is called, it checks the lookup:
   - **Match found**: plays the WAV file via `HTMLAudioElement`
   - **No match**: falls back to browser TTS
4. Interactive clips played via `narration.playClip('clip_id')`
5. Text display still works normally (text3d.show) regardless of audio source

### Text Matching
The narration engine matches by **exact text content** (trimmed, lowercased). The session's stage `texts[]` array must contain the same strings as the manifest's `text` fields. If they don't match, browser TTS is used as fallback.

## Adding a New Session

1. Create `scripts/{session}-script.json` following the format
2. Run the generator: `python3 scripts/generate-voices.py scripts/{session}-script.json`
3. Update the session config (`src/sessions/{session}.ts`):
   - Set `id` to match the manifest's `session` field
   - Stage `texts[]` must match manifest text exactly
4. Audio files go to `public/audio/{session}/`

## Future Improvements

### Long-form generation + slicing
Instead of one API call per line:
1. Generate full stage as one chunk with `...` pauses at cut points
2. Run speech-to-text (Whisper) to get word-level timestamps
3. Slice on the pauses with ffmpeg
4. Better voice consistency within a stage, more natural flow

### Dynamic generation
For personalized sessions:
1. AI generates script based on user preferences
2. Call SexyVoice API on-the-fly (cache results)
3. Stream audio as it generates

### Voice selection
Let users pick their preferred voice in settings. Generate variants with different voices.

## Seed Strategy
- Use `seed = 42 + stageIndex * 100 + lineIndex` for consistency
- Same seed + same text + same style = same output
- Different seeds within a stage give slight variation while keeping the voice consistent
