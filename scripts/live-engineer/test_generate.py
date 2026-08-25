import importlib.util
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("generate.py")
spec = importlib.util.spec_from_file_location("live_engineer_generate", MODULE_PATH)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class GenerateTest(unittest.TestCase):
    def test_atomic_synthesis_text_is_sentence_cased(self) -> None:
        self.assertEqual(module.synthesis_text("number.two", "two"), "Two.")
        self.assertEqual(module.synthesis_text("phrase.fastest.class", "Fastest in class."), "Fastest in class.")

    def test_opponent_pace_prefixes_use_sentence_case(self) -> None:
        for segment_id in ("phrase.within-class-pace", "phrase.off-class-pace"):
            text = module.synthesis_text(segment_id, "You are")
            self.assertEqual(text, "You are.")
            self.assertNotIn("[", text)
    def test_transcript_validation_accepts_expected_phrase(self) -> None:
        self.assertIsNone(module.validate_transcript("phrase.within-class-pace", "You are", "You are"))

    def test_transcript_validation_rejects_hallucinated_phrase(self) -> None:
        failure = module.validate_transcript("phrase.within-class-pace", "Decree stuff", "You are")
        self.assertIn("transcript mismatch", failure)

    def test_transcript_validation_accepts_numeric_alias(self) -> None:
        self.assertIsNone(module.validate_transcript("number.eight", "8", "eight"))
    def test_speech_bounds_measure_active_audio_without_cutting(self) -> None:
        import numpy as np
        audio = np.concatenate([np.zeros(240), np.full(480, 0.1), np.zeros(240)])
        self.assertEqual(module.speech_bounds(audio), (240, 720))

    def test_pre_speech_energy_rejects_voiced_prefix(self) -> None:
        import numpy as np
        audio = np.concatenate([np.full(2400, 0.1), np.zeros(1200), np.full(2400, 0.1)])
        failure = module.validate_pre_speech_energy(audio, first_word_start_s=0.05)
        self.assertIn("pre-speech voiced energy", failure)

    def test_pre_speech_energy_accepts_silence_before_word(self) -> None:
        import numpy as np
        audio = np.concatenate([np.zeros(1200), np.full(2400, 0.1)])
        self.assertIsNone(module.validate_pre_speech_energy(audio, first_word_start_s=0.05))

    def test_generation_uses_requested_speed_steps_and_join_gap(self) -> None:
        self.assertEqual(module.LANGUAGE, "en")
        self.assertEqual(module.SPEED, 1.4)
        self.assertEqual(module.NUM_STEPS, 60)
        self.assertEqual(module.JOIN_GAP_MS, -50)
if __name__ == "__main__":
    unittest.main()
