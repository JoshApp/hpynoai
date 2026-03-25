#!/usr/bin/env python3
"""
Re-timestamp processed audio using energy detection + script matching.

Instead of re-running Whisper on processed audio (which gets confused by
inserted silence), this detects speech regions by energy and maps them
to known words from the script.

Much more reliable than Whisper for post-processed audio with:
- Inserted pauses (silence between words)
- Time-stretched speech
- Single-word sparse stages (deep)
"""

import numpy as np

try:
    import librosa
    HAS_LIBROSA = True
except ImportError:
    HAS_LIBROSA = False


def retimestamp(audio_path, original_words, min_silence_db=-35, min_word_ms=50):
    """Find where each word lives in the processed audio.

    Args:
        audio_path: path to the processed audio file
        original_words: list of {word, start, end} from initial transcription
                        (used for word identity, not timing)
        min_silence_db: threshold below which audio is considered silence (dB)
        min_word_ms: minimum speech region duration to count as a word (ms)

    Returns:
        list of {word, start, end} with timestamps from the processed audio
    """
    if not HAS_LIBROSA:
        return original_words  # can't process without librosa

    # Load audio
    y, sr = librosa.load(audio_path, sr=None, mono=True)
    duration = len(y) / sr

    # Compute RMS energy in short windows (20ms hop)
    hop_length = int(0.02 * sr)
    frame_length = int(0.04 * sr)
    rms = librosa.feature.rms(y=y, frame_length=frame_length, hop_length=hop_length)[0]
    rms_db = librosa.amplitude_to_db(rms, ref=np.max)
    times = librosa.frames_to_time(np.arange(len(rms)), sr=sr, hop_length=hop_length)

    # Find speech regions (above threshold)
    is_speech = rms_db > min_silence_db

    # Smooth: fill tiny gaps (< 80ms) within speech
    fill_frames = int(0.08 * sr / hop_length)
    for i in range(len(is_speech)):
        if not is_speech[i]:
            # Check if there's speech within fill_frames on both sides
            look_back = max(0, i - fill_frames)
            look_fwd = min(len(is_speech), i + fill_frames)
            if np.any(is_speech[look_back:i]) and np.any(is_speech[i+1:look_fwd]):
                is_speech[i] = True

    # Extract speech islands (contiguous speech regions)
    islands = []
    in_speech = False
    start_idx = 0
    for i in range(len(is_speech)):
        if is_speech[i] and not in_speech:
            start_idx = i
            in_speech = True
        elif not is_speech[i] and in_speech:
            island_start = times[start_idx]
            island_end = times[i]
            island_dur_ms = (island_end - island_start) * 1000
            if island_dur_ms >= min_word_ms:
                islands.append((island_start, island_end))
            in_speech = False
    # Handle speech at end of file
    if in_speech:
        island_start = times[start_idx]
        island_end = duration
        if (island_end - island_start) * 1000 >= min_word_ms:
            islands.append((island_start, island_end))

    # Map islands to words
    # Strategy: walk through words and islands together
    # Each island may contain one or more words (multi-word phrases)
    word_texts = [w["word"] for w in original_words]

    result = []
    word_idx = 0

    for island_start, island_end in islands:
        if word_idx >= len(word_texts):
            break

        island_dur = island_end - island_start

        # Count how many original words fit in this island
        # Use the original word durations as hints for splitting
        words_in_island = []
        remaining_dur = island_dur
        scan_idx = word_idx

        while scan_idx < len(word_texts) and remaining_dur > 0.03:
            orig_dur = original_words[scan_idx]["end"] - original_words[scan_idx]["start"]
            # If the original word was very short, still give it at least 50ms
            word_dur = max(orig_dur, 0.05)

            # Check if next original word has a gap (suggesting island boundary)
            if scan_idx + 1 < len(original_words):
                orig_gap = original_words[scan_idx + 1]["start"] - original_words[scan_idx]["end"]
                if orig_gap > 0.3 and len(words_in_island) > 0:
                    # Large gap in original — this island probably ends here
                    break

            words_in_island.append(scan_idx)
            remaining_dur -= word_dur
            scan_idx += 1

        if not words_in_island:
            # Island too short for any word — skip
            continue

        # Distribute island time among its words proportionally
        total_orig_dur = sum(
            max(original_words[wi]["end"] - original_words[wi]["start"], 0.05)
            for wi in words_in_island
        )

        t = island_start
        for wi in words_in_island:
            orig_dur = max(original_words[wi]["end"] - original_words[wi]["start"], 0.05)
            proportion = orig_dur / total_orig_dur
            word_dur = island_dur * proportion

            result.append({
                "word": word_texts[wi],
                "start": round(t, 3),
                "end": round(t + word_dur, 3),
            })
            t += word_dur

        word_idx = words_in_island[-1] + 1

    # Any remaining words that weren't matched — estimate from audio end
    while word_idx < len(word_texts):
        # Place them at the end with minimal duration
        t = result[-1]["end"] + 0.1 if result else 0
        result.append({
            "word": word_texts[word_idx],
            "start": round(t, 3),
            "end": round(t + 0.1, 3),
        })
        word_idx += 1

    return result
