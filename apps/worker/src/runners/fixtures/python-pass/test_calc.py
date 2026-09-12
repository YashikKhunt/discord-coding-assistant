import unittest


class CalcTest(unittest.TestCase):
    def test_add(self):
        self.assertEqual(1 + 1, 2)

    def test_upper(self):
        self.assertEqual("a".upper(), "A")


if __name__ == "__main__":
    unittest.main()
