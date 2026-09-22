import unittest, tempfile
from pathlib import Path
from hpyno_pipeline.script import parse_script
from hpyno_pipeline.providers import make_provider, SR
from hpyno_pipeline.assemble import render_stage, build_segments, Segment

SRC = """[SESSION: t]
[VOICE: v]
[SETTINGS: speed=1.0]
[STAGE: a]
[DEPTH: 0.3 ramp=5]
[BREATH: 4/1/3/0]
hello there my friend.

this is a [CMD test] line.
[PAUSE 2]
[GATE: do you want more?]
after the gate.
[INTERLUDE 3]
"""

class AssembleTests(unittest.TestCase):
    def test_plan_and_render(self):
        s = parse_script(SRC)
        st = s.stages[0]
        plan = build_segments(s, st, 4000)
        kinds = [p.__class__.__name__ for p in plan]
        self.assertEqual(kinds, ['Segment', 'SilenceItem', 'Segment', 'SilenceItem', 'Segment', 'SilenceItem'])
        self.assertEqual(plan[2].gate.prompt, 'do you want more?')
        self.assertIn('do you want more?', plan[2].text)
        with tempfile.TemporaryDirectory() as td:
            prov = make_provider('mock', Path(td))
            r = render_stage(s, st, prov, 4000, None, log=lambda m: None)
            self.assertGreater(r.duration, 2 + 7 + 3)
            texts = [l.text for l in r.lines]
            self.assertEqual(texts, ['hello there my friend.', 'this is a test line.', 'do you want more?', 'after the gate.'])
            gate = [c for c in r.cues if c['type'] == 'gate'][0]
            snap = [c for c in r.cues if c['type'] == 'trigger' and c['kind'] == 'snap']
            self.assertEqual(len(snap), 1)
            self.assertGreater(gate['t'], r.lines[2].end - 0.01)
            self.assertLess(gate['t'], r.lines[3].start)
            # words are monotonic and inside the stage
            last = -1
            for l in r.lines:
                for w in l.words:
                    self.assertGreaterEqual(w.start, last - 1e-6); last = w.start
                    self.assertLess(w.end, r.duration)
            # second render hits the cache
            r2 = render_stage(s, st, prov, 4000, None, log=lambda m: None)
            self.assertEqual(r2.cache_hits, r2.requests)

    def test_long_stage_splits_under_max(self):
        body = '\n\n'.join('sentence number %d is here for length.' % i for i in range(60))
        s = parse_script('[SESSION: t]\n[VOICE: v]\n[STAGE: a]\n' + body + '\n')
        plan = build_segments(s, s.stages[0], 400)
        segs = [p for p in plan if isinstance(p, Segment)]
        self.assertGreater(len(segs), 3)
        self.assertTrue(all(len(x.text) <= 400 for x in segs))

if __name__ == '__main__': unittest.main()


class EffectTests(unittest.TestCase):
    def test_echo_and_stretch_keep_timings_consistent(self):
        src = """[SESSION: t]
[VOICE: v]
[STAGE: a]
[FX: stretch=1.05 echo=-9]
we go [ECHO deeper] now and now.

[GATE: yes?]
after.
"""
        s = parse_script(src)
        st = s.stages[0]
        with tempfile.TemporaryDirectory() as td:
            prov = make_provider('mock', Path(td))
            r = render_stage(s, st, prov, 4000, None, log=lambda m: None)
            self.assertEqual(r.audio.shape[1], 2)
            gate = [c for c in r.cues if c['type'] == 'gate'][0]
            self.assertGreater(gate['t'], r.lines[1].end - 0.01)   # cues scaled with the stretch
            self.assertLess(r.lines[-1].end, r.duration)
            self.assertEqual(r.lines[0].words[2].word, 'deeper')


class WordBoundTests(unittest.TestCase):
    def test_start_snaps_to_energy(self):
        import numpy as np
        from hpyno_pipeline import dsp
        sr = SR
        audio = np.zeros(sr, dtype=np.float32)          # 1 s: silence, then a burst from 0.4 to 0.7
        a, b = int(0.4 * sr), int(0.7 * sr)
        t = np.arange(b - a) / sr
        audio[a:b] = 0.3 * np.sin(2 * np.pi * 200 * t)
        s, e = dsp.refine_word_bounds(audio, 0.0, 0.9)
        self.assertAlmostEqual(s, 0.385, delta=0.02)
        self.assertLess(e, 0.9)
        self.assertGreater(e, 0.69)


class EditTests(unittest.TestCase):
    def test_apply_edits_remaps_times(self):
        import numpy as np
        from hpyno_pipeline import dsp
        audio = np.ones(SR * 2, dtype=np.float32)          # 2 s
        out, remap = dsp.apply_edits(audio, [(0.5, 0.5, dsp.silence(1.0)), (1.5, 1.6, np.zeros(int(0.3 * SR), dtype=np.float32))])
        self.assertAlmostEqual(out.size / SR, 3.2, places=3)
        self.assertAlmostEqual(remap(0.25), 0.25)
        self.assertAlmostEqual(remap(1.0), 2.0)           # after the 1 s insert
        self.assertAlmostEqual(remap(1.5), 2.5)
        self.assertAlmostEqual(remap(1.6), 2.8)           # 0.1 s span became 0.3 s
        self.assertAlmostEqual(remap(2.0), 3.2)

    def test_pause_scaling_lengthens_gaps(self):
        src = "[SESSION: t]\n[VOICE: v]\n[STAGE: a]\n[FX: pause=2.0 pause_min=0.05]\none two three.\n"
        s = parse_script(src)
        with tempfile.TemporaryDirectory() as td:
            prov = make_provider('mock', Path(td))
            r1 = render_stage(s, s.stages[0], prov, 4000, None, log=lambda m: None)
            s.stages[0].fx = None
            r0 = render_stage(s, s.stages[0], prov, 4000, None, log=lambda m: None)
            self.assertGreater(r1.duration, r0.duration)
            self.assertGreater(r1.lines[0].words[-1].start - r1.lines[0].words[0].start,
                               r0.lines[0].words[-1].start - r0.lines[0].words[0].start)


class FadeTests(unittest.TestCase):
    def test_fade_span_sinks(self):
        import numpy as np
        from hpyno_pipeline import dsp
        y = np.ones(SR, dtype=np.float32)
        dsp.fade_span(y, 0.0, 1.0, -12.0)
        self.assertAlmostEqual(float(y[0]), 1.0, places=3)
        self.assertAlmostEqual(float(y[-1]), 10 ** (-12 / 20), places=2)


class WarpTests(unittest.TestCase):
    def test_warp_to_maps_knots(self):
        import numpy as np
        from hpyno_pipeline import dsp
        src = np.arange(SR * 2, dtype=np.float32) / SR        # value == source time
        out = dsp.warp_to(src, [0.0, 1.0, 2.0], [0.0, 0.5, 2.0], 2.0)
        self.assertAlmostEqual(float(out[int(0.5 * SR)]), 1.0, places=2)   # dst 0.5 → src 1.0
        self.assertAlmostEqual(float(out[int(1.25 * SR)]), 1.5, places=2)  # dst 1.25 → src 1.5

    def test_echo_reserves_silence(self):
        src = "[SESSION: t]\n[VOICE: v]\n[STAGE: a]\n[FX: echo=-9]\npulls you [ECHO a little deeper] a little closer.\n"
        s = parse_script(src)
        with tempfile.TemporaryDirectory() as td:
            prov = make_provider('mock', Path(td))
            r = render_stage(s, s.stages[0], prov, 4000, None, log=lambda m: None)
            w = r.lines[0].words
            gap_after_echo = w[5].start - w[4].end       # 'deeper' → 'a'
            self.assertGreater(gap_after_echo, 1.0)


class WhisperizeTests(unittest.TestCase):
    def test_whisperize_keeps_length_and_envelope(self):
        import numpy as np
        from hpyno_pipeline import dsp
        t = np.arange(SR * 2) / SR
        x = (np.sin(2 * np.pi * 180 * t) * (t < 1.0)).astype(np.float32)   # tone for 1 s, silence for 1 s
        y = dsp.whisperize(x)
        self.assertEqual(y.size, x.size)
        self.assertGreater(np.sqrt(np.mean(y[:SR] ** 2)), 5 * np.sqrt(np.mean(y[SR + 2048:] ** 2)))


class CmdHoldTests(unittest.TestCase):
    def test_line_ending_command_holds(self):
        src = "[SESSION: t]\n[VOICE: v]\n[STAGE: a]\n[FX: cmd_hold=1.5 pause=1.0]\nnow [CMD let go].\n\nyou are perfect.\n"
        s = parse_script(src)
        with tempfile.TemporaryDirectory() as td:
            prov = make_provider('mock', Path(td))
            r = render_stage(s, s.stages[0], prov, 4000, None, log=lambda m: None)
            self.assertGreater(r.lines[1].start - r.lines[0].end, 1.4)
