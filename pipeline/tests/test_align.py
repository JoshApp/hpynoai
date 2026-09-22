import unittest
from hpyno_pipeline.align import words_from_chars, map_to_script, align_line

def chars_of(text, per=0.1):
    chars = list(text); starts = [i * per for i in range(len(chars))]; ends = [(i + 1) * per for i in range(len(chars))]
    return chars, starts, ends

class AlignTests(unittest.TestCase):
    def test_words_skip_tags(self):
        c, s, e = chars_of('[whispers] so good.')
        w = words_from_chars(c, s, e)
        self.assertEqual([x.word for x in w], ['so', 'good.'])
        self.assertAlmostEqual(w[0].start, 1.1)

    def test_map_exact(self):
        wt = align_line('you chose to be here', *chars_of('you chose to be here'), 2.0)
        self.assertEqual([w.word for w in wt], ['you', 'chose', 'to', 'be', 'here'])
        self.assertTrue(all(wt[i].end <= wt[i + 1].start + 1e-6 for i in range(4)))

    def test_map_with_dropped_and_extra_tokens(self):
        # provider merged "to be" and added a stray token
        c, s, e = chars_of('you chose tobe here uh')
        wt = align_line('you chose to be here', c, s, e, 2.2)
        self.assertEqual(len(wt), 5)
        self.assertLess(wt[1].end, wt[2].start + 1e-6)
        self.assertLess(wt[3].end, wt[4].start + 1e-6)

    def test_all_missing_interpolates(self):
        wt = map_to_script(['a', 'b'], [], 1.0)
        self.assertAlmostEqual(wt[1].start, 0.5)

if __name__ == '__main__': unittest.main()
