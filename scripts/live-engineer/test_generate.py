import importlib.util
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("generate.py")
spec = importlib.util.spec_from_file_location("live_engineer_generate", MODULE_PATH)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class GenerateTest(unittest.TestCase):
    def test_opponent_pace_prefixes_use_plain_text(self) -> None:
        for segment_id in ("phrase.within-class-pace", "phrase.off-class-pace"):
            text = module.synthesis_text(segment_id, "You are")
            self.assertEqual(text, "You are")
            self.assertNotIn("[", text)

    def test_transcript_validation_accepts_expected_phrase(self) -> None:
        self.assertIsNone(module.validate_transcript("phrase.within-class-pace", "You are", "You are"))

    def test_transcript_validation_rejects_hallucinated_phrase(self) -> None:
        failure = module.validate_transcript("phrase.within-class-pace", "Decree stuff", "You are")
        self.assertIn("transcript mismatch", failure)

    def test_transcript_validation_accepts_numeric_alias(self) -> None:
        self.assertIsNone(module.validate_transcript("number.eight", "8", "eight"))
    def test_transcript_validation_rejects_leading_article_for_number(self) -> None:
        failure = module.validate_transcript("number.one", "A one", "one")
        self.assertIn("transcript mismatch", failure)
    def test_generation_uses_english_natural_speed(self) -> None:
        self.assertEqual(module.LANGUAGE, "en")
        self.assertEqual(module.SPEED, 1.0)
        self.assertEqual(module.NUM_STEPS, 48)

if __name__ == "__main__":
    unittest.main()
