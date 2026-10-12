from django.test import SimpleTestCase
from workspace.execution import EXTENSION_LANGUAGES, detect_language, has_filename_extension, language_from_content, language_from_filename


class LanguageDetectionTests(SimpleTestCase):
    def test_every_recognized_extension_and_case(self):
        for extension, language in EXTENSION_LANGUAGES.items():
            with self.subTest(extension=extension):
                self.assertEqual(language_from_filename('main' + extension.upper()), language)
                self.assertEqual(detect_language('main' + extension, 'irrelevant'), (language, None))

    def test_extension_wins_over_conflicting_source(self):
        self.assertEqual(detect_language('main.py', 'std::cout << 42;'), ('python', None))
        self.assertEqual(detect_language('main.c', 'print(1)'), ('c', None))

    def test_unknown_extension_never_falls_back_to_source(self):
        language, error = detect_language('main.unknown', 'print(1)')
        self.assertIsNone(language)
        self.assertIn('.unknown', error)

    def test_extensionless_hidden_and_nested_filenames(self):
        self.assertFalse(has_filename_extension('main'))
        self.assertFalse(has_filename_extension('.env'))
        self.assertEqual(language_from_filename('/dir.with.dot/main.PY'), 'python')
        self.assertIsNone(language_from_filename('README'))

    def test_supported_source_signatures(self):
        for source, expected in [('print(1)', 'python'), ('def hello():\n    pass', 'python'), ('#include <stdio.h>\nint main(void) { puts("hi"); }', 'c'), ('#include <iostream>\nint main() { std::cout << 1; }', 'cpp')]:
            self.assertEqual(detect_language('main', source), (expected, None))

    def test_ambiguous_and_empty_code_do_not_guess(self):
        for source in ['', 'x = 1', 'print(1); console.log(1);', 'int main() { return 0; }']:
            with self.subTest(source=source):
                self.assertIsNone(language_from_content(source))
                self.assertIsNotNone(detect_language('main', source)[1])

    def test_c_main_is_not_evidence_of_cpp(self):
        self.assertEqual(language_from_content('#include <stdio.h>\nint main() { puts("hi"); }'), 'c')
