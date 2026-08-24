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
    def test_transcript_validation_allows_whisper_article_for_number(self) -> None:
        self.assertIsNone(module.validate_transcript("number.one", "A one", "one"))

if __name__ == "__main__":
    unittest.main()
