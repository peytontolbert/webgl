import unittest

from assetto_nurburgring_scene_compiler import is_non_visual_node


class AssettoNodeVisibilityTests(unittest.TestCase):
    def test_gameplay_locators_are_not_scenery(self):
        for name in (
            "AC_START_0",
            "AC_PIT_21",
            "AC_TIME_2_L",
            "AC_HOTLAP_START_0",
            "AC_AUDIO_1",
        ):
            with self.subTest(name=name):
                self.assertTrue(is_non_visual_node(name))

    def test_visual_ac_nodes_remain_available(self):
        for name in ("AC_CREW_0", "AC_POBJECT_7", "Text002", "grail-new"):
            with self.subTest(name=name):
                self.assertFalse(is_non_visual_node(name))


if __name__ == "__main__":
    unittest.main()
