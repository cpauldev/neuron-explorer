import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "explorer"))
from token_display import BYTE_VALUES, token_label


class TokenDisplayTests(unittest.TestCase):
    def test_alphabet_is_reversible_and_includes_whitespace(self):
        self.assertEqual(set(BYTE_VALUES.values()), set(range(256)))
        self.assertEqual(BYTE_VALUES["Ġ"], 32)
        self.assertEqual(BYTE_VALUES["Ċ"], 10)

    def test_fragment_keeps_exact_bytes(self):
        self.assertEqual(token_label("�", "ä½", 123, True), "bytes:E4 BD")
        self.assertEqual(token_label("a�", "aä½", 124, True), "bytes:61 E4 BD")

    def test_multilingual_text_is_unchanged(self):
        for text in ["你好", "café", "العربية", "🙂", " hello"]:
            self.assertEqual(token_label(text, "ignored", 1, True), text)

    def test_unknown_decoder_does_not_guess_bytes(self):
        self.assertEqual(token_label("�", "raw_piece", 123), "token:123 (raw_piece)")

    def test_actual_replacement_character_is_escaped(self):
        self.assertEqual(token_label("�", "ï¿½", 1, True), r"\uFFFD")


if __name__ == "__main__":
    unittest.main()
