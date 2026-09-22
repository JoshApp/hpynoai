import unittest
from pathlib import Path
from hpyno_pipeline.script import parse_script, ScriptError, char_count, GateItem, SilenceItem, TextItem, BreathItem, words_of

SCRIPT = Path(__file__).resolve().parents[2] / 'scripts' / 'surrender.v3.txt'

class ParseTests(unittest.TestCase):
    def test_surrender_parses(self):
        s = parse_script(SCRIPT.read_text())
        self.assertEqual(s.id, 'surrender')
        self.assertEqual([st.name for st in s.stages], ['settling', 'invitation', 'surrender', 'devotion', 'ecstasy', 'afterglow'])
        self.assertEqual(s.model, 'eleven_v3')
        self.assertAlmostEqual(s.settings.speed, 0.9)
        self.assertEqual(s.theme['shape'], 0.25)
        gates = [i for st in s.stages for i in st.items if isinstance(i, GateItem)]
        self.assertEqual(len(gates), 2)
        self.assertEqual(gates[0].window, 7.0)
        self.assertTrue(any(isinstance(i, BreathItem) for i in s.stages[0].items))
        total = sum(char_count(s).values())
        self.assertTrue(2000 < total < 6000, total)

    def test_lines_and_spans(self):
        s = parse_script("[SESSION: t]\n[STAGE: a]\nhello there...\nto just... [CMD obey].\n\nmore open... [DOUBLE more mine].\n")
        items = [i for i in s.stages[0].items if isinstance(i, TextItem)]
        self.assertEqual(len(items), 2)
        l0 = items[0].line
        self.assertEqual(l0.text, 'hello there... to just... obey.')
        self.assertEqual(l0.spans[0].kind, 'cmd')
        self.assertEqual(l0.words[l0.spans[0].word_start:l0.spans[0].word_end], ['obey.'])
        l1 = items[1].line
        self.assertEqual(l1.spans[0].kind, 'double')
        self.assertEqual(l1.words[l1.spans[0].word_start:l1.spans[0].word_end], ['more', 'mine.'])

    def test_delivery_tags_pass_through_and_are_not_words(self):
        s = parse_script("[SESSION: t]\n[STAGE: a]\n[whispers] so good.\n")
        line = s.stages[0].items[0].line
        self.assertEqual(line.text, '[whispers] so good.')
        self.assertEqual(line.words, ['so', 'good.'])
        self.assertEqual(words_of('[softly] a [sighs] b'), ['a', 'b'])

    def test_errors(self):
        with self.assertRaises(ScriptError): parse_script("hello\n")
        with self.assertRaises(ScriptError): parse_script("[SESSION: x]\n[STAGE: a]\n[NOPE: 1]\n")
        with self.assertRaises(ScriptError): parse_script("[SESSION: x]\n[STAGE: a]\n[PAUSE 2]\n")
        with self.assertRaises(ScriptError): parse_script("[STAGE: a]\nhi\n")

if __name__ == '__main__': unittest.main()
