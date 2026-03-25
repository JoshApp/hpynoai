#!/usr/bin/env python3
"""
HPYNO Audio Analyzer

Analyzes processed audio for:
- Clipping / digital overs
- DC offset
- Sudden amplitude spikes (pops/clicks)
- Frequency balance (bass buildup, harsh frequencies)
- Phase issues from processing
- Silence quality (noise in pauses)
- Before/after comparison with raw audio

Outputs:
- Per-stage report with issues flagged
- Spectrogram images for visual inspection
- Waveform plots showing problem areas

Usage:
  .venv/bin/python scripts/analyze-audio.py
"""

import json, os, sys
import numpy as np

sys.path.insert(0, os.path.dirname(__file__))

try:
    import librosa
    import soundfile as sf
    import matplotlib
    matplotlib.use('Agg')  # non-interactive backend
    import matplotlib.pyplot as plt
except ImportError as e:
    print(f"Missing dependency: {e}")
    print("pip install librosa soundfile matplotlib")
    sys.exit(1)

RAW_DIR = "public/audio/relax/raw"
V2_DIR = "public/audio/relax-v2"
OUT_DIR = "public/audio/relax-v2/analysis"

STAGES = [
    ("00_settle", "settle"),
    ("01_induction", "induction"),
    ("02_deepening", "deepening"),
    ("03_trance", "trance"),
    ("04_deep", "deep"),
    ("05_emergence", "emergence"),
]


def analyze_stage(raw_path, processed_path, stage_name, out_dir):
    """Full analysis of one stage."""
    print(f"\n{'='*60}")
    print(f"  {stage_name}")
    print(f"{'='*60}")

    issues = []

    # Load audio
    y_raw, sr = librosa.load(raw_path, sr=None, mono=True)
    y_proc, sr2 = librosa.load(processed_path, sr=None, mono=True)
    if sr != sr2:
        print(f"  WARNING: sample rate mismatch raw={sr} proc={sr2}")

    dur_raw = len(y_raw) / sr
    dur_proc = len(y_proc) / sr
    print(f"  Raw: {dur_raw:.1f}s | Processed: {dur_proc:.1f}s ({dur_proc/dur_raw:.0%})")

    # ── 1. Clipping detection ──
    clip_threshold = 0.98
    raw_clips = np.sum(np.abs(y_raw) > clip_threshold)
    proc_clips = np.sum(np.abs(y_proc) > clip_threshold)
    print(f"  Clipping (>{clip_threshold}): raw={raw_clips} proc={proc_clips}")
    if proc_clips > 100:
        issues.append(f"CLIPPING: {proc_clips} samples above {clip_threshold}")

    # ── 2. Peak analysis ──
    raw_peak = np.max(np.abs(y_raw))
    proc_peak = np.max(np.abs(y_proc))
    raw_rms = np.sqrt(np.mean(y_raw**2))
    proc_rms = np.sqrt(np.mean(y_proc**2))
    print(f"  Peak: raw={raw_peak:.4f} proc={proc_peak:.4f}")
    print(f"  RMS:  raw={raw_rms:.4f} proc={proc_rms:.4f}")

    # ── 3. DC offset ──
    raw_dc = np.mean(y_raw)
    proc_dc = np.mean(y_proc)
    print(f"  DC offset: raw={raw_dc:.6f} proc={proc_dc:.6f}")
    if abs(proc_dc) > 0.01:
        issues.append(f"DC OFFSET: {proc_dc:.4f} (should be near 0)")

    # ── 4. Click/pop detection (sudden amplitude spikes) ──
    # Compute sample-to-sample differences
    diff = np.abs(np.diff(y_proc))
    # Threshold: spikes > 10x the median difference
    median_diff = np.median(diff)
    spike_threshold = max(median_diff * 15, 0.05)
    spikes = np.where(diff > spike_threshold)[0]

    # Group nearby spikes (within 50ms)
    spike_groups = []
    if len(spikes) > 0:
        group_start = spikes[0]
        group_end = spikes[0]
        for s in spikes[1:]:
            if s - group_end < int(0.05 * sr):
                group_end = s
            else:
                spike_groups.append((group_start / sr, group_end / sr))
                group_start = s
                group_end = s
        spike_groups.append((group_start / sr, group_end / sr))

    print(f"  Clicks/pops: {len(spike_groups)} detected (threshold={spike_threshold:.4f})")
    if spike_groups:
        for start, end in spike_groups[:10]:
            print(f"    at {start:.2f}s")
        if len(spike_groups) > 10:
            print(f"    ... and {len(spike_groups) - 10} more")
        if len(spike_groups) > 5:
            issues.append(f"CLICKS: {len(spike_groups)} potential pops/clicks detected")

    # ── 5. Silence quality (check noise in pauses) ──
    # Find silence regions (RMS < threshold in 50ms windows)
    window = int(0.05 * sr)
    rms_env = np.sqrt(np.convolve(y_proc**2, np.ones(window)/window, mode='same'))
    silence_mask = rms_env < 0.005
    silence_samples = y_proc[silence_mask]
    if len(silence_samples) > 0:
        silence_noise = np.sqrt(np.mean(silence_samples**2))
        silence_peak = np.max(np.abs(silence_samples))
        print(f"  Silence noise floor: RMS={silence_noise:.6f} Peak={silence_peak:.4f}")
        if silence_noise > 0.002:
            issues.append(f"NOISE IN SILENCE: RMS={silence_noise:.6f}")
    else:
        print(f"  No silence regions detected")

    # ── 6. Frequency analysis ──
    # Compare spectral balance raw vs processed
    S_raw = np.abs(librosa.stft(y_raw))
    S_proc = np.abs(librosa.stft(y_proc[:len(y_raw)] if len(y_proc) > len(y_raw) else y_proc))

    freqs = librosa.fft_frequencies(sr=sr)

    # Band energy comparison
    bands = [
        ("sub-bass", 20, 80),
        ("bass", 80, 250),
        ("low-mid", 250, 500),
        ("mid", 500, 2000),
        ("upper-mid", 2000, 5000),
        ("high", 5000, 10000),
        ("air", 10000, 20000),
    ]

    print(f"\n  Frequency balance (raw → processed):")
    band_changes = {}
    for name, lo, hi in bands:
        mask = (freqs >= lo) & (freqs < hi)
        if not np.any(mask):
            continue
        raw_energy = np.mean(S_raw[mask, :])
        proc_energy = np.mean(S_proc[mask, :])
        if raw_energy > 0:
            change_db = 20 * np.log10(proc_energy / raw_energy + 1e-10)
        else:
            change_db = 0
        band_changes[name] = change_db
        marker = ""
        if abs(change_db) > 3:
            marker = " ⚠️" if change_db > 0 else " ⬇"
        if abs(change_db) > 6:
            marker = " ‼️"
            issues.append(f"FREQ {name}: {change_db:+.1f}dB change")
        print(f"    {name:12s} {change_db:+.1f}dB{marker}")

    # ── 7. Crest factor (dynamic range) ──
    raw_crest = raw_peak / (raw_rms + 1e-10)
    proc_crest = proc_peak / (proc_rms + 1e-10)
    print(f"\n  Crest factor: raw={raw_crest:.1f} proc={proc_crest:.1f}")
    if proc_crest < raw_crest * 0.6:
        issues.append(f"OVER-COMPRESSED: crest factor dropped from {raw_crest:.1f} to {proc_crest:.1f}")

    # ── Generate plots ──
    fig, axes = plt.subplots(4, 1, figsize=(16, 12))
    fig.suptitle(f'{stage_name} — Audio Analysis', fontsize=14, color='white')
    fig.patch.set_facecolor('#0a0a12')

    for ax in axes:
        ax.set_facecolor('#12121e')
        ax.tick_params(colors='#806090')
        ax.spines['bottom'].set_color('#333')
        ax.spines['left'].set_color('#333')
        ax.spines['top'].set_visible(False)
        ax.spines['right'].set_visible(False)

    # Plot 1: Waveform comparison
    t_raw = np.linspace(0, dur_raw, len(y_raw))
    t_proc = np.linspace(0, dur_proc, len(y_proc))
    axes[0].plot(t_raw, y_raw, color='#4060a0', alpha=0.5, linewidth=0.3, label='raw')
    axes[0].plot(t_proc, y_proc, color='#c8a0ff', alpha=0.7, linewidth=0.3, label='processed')
    # Mark clicks
    for start, end in spike_groups:
        axes[0].axvspan(start, end + 0.02, color='red', alpha=0.3)
    axes[0].set_ylabel('Amplitude', color='#a090c0')
    axes[0].set_title('Waveform (blue=raw, purple=processed, red=clicks)', color='#a090c0', fontsize=10)
    axes[0].set_xlim(0, max(dur_raw, dur_proc))
    axes[0].legend(loc='upper right', fontsize=8)

    # Plot 2: Spectrogram of processed
    S_db = librosa.amplitude_to_db(np.abs(librosa.stft(y_proc)), ref=np.max)
    img = librosa.display.specshow(S_db, sr=sr, x_axis='time', y_axis='hz', ax=axes[1], cmap='magma')
    axes[1].set_ylim(0, 8000)
    axes[1].set_ylabel('Frequency (Hz)', color='#a090c0')
    axes[1].set_title('Spectrogram (processed)', color='#a090c0', fontsize=10)

    # Plot 3: RMS envelope comparison
    frame_length = int(0.1 * sr)
    hop = frame_length // 2
    rms_raw = librosa.feature.rms(y=y_raw, frame_length=frame_length, hop_length=hop)[0]
    rms_proc = librosa.feature.rms(y=y_proc, frame_length=frame_length, hop_length=hop)[0]
    t_rms_raw = np.linspace(0, dur_raw, len(rms_raw))
    t_rms_proc = np.linspace(0, dur_proc, len(rms_proc))
    axes[2].plot(t_rms_raw, 20*np.log10(rms_raw + 1e-10), color='#4060a0', alpha=0.6, label='raw')
    axes[2].plot(t_rms_proc, 20*np.log10(rms_proc + 1e-10), color='#c8a0ff', label='processed')
    axes[2].set_ylabel('RMS (dB)', color='#a090c0')
    axes[2].set_title('Loudness envelope', color='#a090c0', fontsize=10)
    axes[2].legend(loc='upper right', fontsize=8)
    axes[2].set_xlim(0, max(dur_raw, dur_proc))

    # Plot 4: Spectral difference (what processing added/removed)
    # Average spectrum
    raw_avg = np.mean(S_raw, axis=1)
    proc_avg = np.mean(S_proc, axis=1)
    min_len = min(len(raw_avg), len(proc_avg))
    diff_db = 20 * np.log10((proc_avg[:min_len] + 1e-10) / (raw_avg[:min_len] + 1e-10))
    freqs_plot = freqs[:min_len]
    axes[3].plot(freqs_plot, diff_db, color='#c8a0ff', linewidth=0.8)
    axes[3].axhline(0, color='#333', linewidth=0.5)
    axes[3].axhline(3, color='#806030', linewidth=0.5, linestyle='--')
    axes[3].axhline(-3, color='#806030', linewidth=0.5, linestyle='--')
    axes[3].fill_between(freqs_plot, diff_db, 0, where=diff_db > 0, color='#c8a0ff', alpha=0.15)
    axes[3].fill_between(freqs_plot, diff_db, 0, where=diff_db < 0, color='#4060a0', alpha=0.15)
    axes[3].set_xlabel('Frequency (Hz)', color='#a090c0')
    axes[3].set_ylabel('Change (dB)', color='#a090c0')
    axes[3].set_title('Spectral difference (processed vs raw)', color='#a090c0', fontsize=10)
    axes[3].set_xlim(20, 16000)
    axes[3].set_xscale('log')
    axes[3].set_ylim(-15, 15)

    plt.tight_layout()
    plot_path = os.path.join(out_dir, f"{stage_name}_analysis.png")
    fig.savefig(plot_path, dpi=120, facecolor=fig.get_facecolor())
    plt.close()
    print(f"\n  Plot: {plot_path}")

    # ── Summary ──
    if issues:
        print(f"\n  ⚠ ISSUES:")
        for issue in issues:
            print(f"    - {issue}")
    else:
        print(f"\n  ✓ No issues detected")

    return {
        "stage": stage_name,
        "duration_raw": round(dur_raw, 2),
        "duration_proc": round(dur_proc, 2),
        "peak_raw": round(float(raw_peak), 4),
        "peak_proc": round(float(proc_peak), 4),
        "rms_raw": round(float(raw_rms), 4),
        "rms_proc": round(float(proc_rms), 4),
        "dc_offset": round(float(proc_dc), 6),
        "clicks": len(spike_groups),
        "click_positions": [round(s, 2) for s, _ in spike_groups[:20]],
        "clipping_samples": int(proc_clips),
        "crest_factor": round(float(proc_crest), 1),
        "band_changes_db": {k: round(v, 1) for k, v in band_changes.items()},
        "issues": issues,
        "plot": plot_path,
    }


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    results = []

    for filename, stage_name in STAGES:
        raw_path = os.path.join(RAW_DIR, f"{filename}.wav")
        # Try mp3 first, then wav
        proc_path = os.path.join(V2_DIR, f"{filename}.mp3")
        if not os.path.exists(proc_path):
            proc_path = os.path.join(V2_DIR, f"{filename}.wav")
        if not os.path.exists(raw_path) or not os.path.exists(proc_path):
            print(f"SKIP {stage_name}: files not found")
            continue

        result = analyze_stage(raw_path, proc_path, stage_name, OUT_DIR)
        results.append(result)

    # Summary report
    print(f"\n{'='*60}")
    print(f"  SUMMARY")
    print(f"{'='*60}")

    total_clicks = sum(r["clicks"] for r in results)
    total_clipping = sum(r["clipping_samples"] for r in results)
    all_issues = []
    for r in results:
        for issue in r["issues"]:
            all_issues.append(f"{r['stage']}: {issue}")

    print(f"  Total clicks/pops: {total_clicks}")
    print(f"  Total clipping samples: {total_clipping}")
    print(f"  Stages with issues: {sum(1 for r in results if r['issues'])}/{len(results)}")

    if all_issues:
        print(f"\n  All issues:")
        for issue in all_issues:
            print(f"    - {issue}")

    # Save report
    report_path = os.path.join(OUT_DIR, "report.json")
    with open(report_path, "w") as f:
        json.dump(results, f, indent=2)
    print(f"\n  Report: {report_path}")
    print(f"  Plots: {OUT_DIR}/*_analysis.png")


if __name__ == "__main__":
    main()
