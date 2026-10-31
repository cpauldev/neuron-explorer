"""Serving the compiled React entry must be explicit and actionable on a fresh checkout."""
from pathlib import Path
import unittest
from unittest.mock import patch

from server_fixture import load_server


class FrontendTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = load_server()

    def test_missing_build_explains_the_required_commands(self):
        with patch.object(Path, 'is_file', return_value=False):
            response = self.server.frontend()
        self.assertEqual(response.status_code, 503)
        self.assertIn(b'npm ci', response.body)
        self.assertIn(b'npm run build', response.body)

    def test_built_entry_has_no_cache_so_new_asset_hashes_are_loaded(self):
        with patch.object(Path, 'is_file', return_value=True):
            response = self.server.frontend()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers['cache-control'], 'no-cache')
        self.assertEqual(Path(response.path).name, 'index.html')
        self.assertEqual(Path(response.path).parent.name, 'dist')
