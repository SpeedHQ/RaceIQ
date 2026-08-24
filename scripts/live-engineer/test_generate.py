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


if __name__ == "__main__":
    unittest.main()
