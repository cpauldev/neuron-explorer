import copy
import json
import os
import subprocess
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'explorer'))
import agent_mcp
from research_report import validate_findings

ARCH = {'n_layers': 32, 'inter': 9216, 'attn_heads': 16, 'linear_v_heads': 32, 'layer_types': ['linear_attention'] * 32}
REPORT = {'title': 'A tentative role', 'summary': 'May promote requirements in writing advice.', 'confidence': 'low',
          'evidence': [{'source': 'neuron', 'kind': 'observation', 'text': 'The steering lens includes writing.'}],
          'caveats': ['No causal verification yet.'], 'references': [{'layer': 16, 'n': 2311, 'kind': 'neuron'}],
          'next_steps': [{'label': 'Test a control', 'prompt': 'Compare writing and cooking instructions.'}]}


class FindingsTests(unittest.TestCase):
    def test_stdio_accepts_utf8_findings_under_a_legacy_windows_encoding(self):
        report = copy.deepcopy(REPORT)
        report['evidence'][0]['text'] = '写作 · 目前 · café — observed'
        request = {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': 'present_findings', 'arguments': report}}
        explorer = str(Path(__file__).resolve().parents[1] / 'explorer')
        script = f'import sys; sys.path.insert(0, {explorer!r}); import agent_mcp; agent_mcp.get = lambda *a, **k: {{"arch": {ARCH!r}}}; agent_mcp.main()'
        result = subprocess.run([sys.executable, '-c', script], input=(json.dumps(request, ensure_ascii=False) + '\n').encode('utf-8'),
                                capture_output=True, timeout=10, env={**os.environ, 'PYTHONIOENCODING': 'cp1252'})
        self.assertEqual(result.returncode, 0, result.stderr.decode('utf-8', errors='replace'))
        reply = json.loads(result.stdout)
        self.assertFalse(reply['result']['isError'])
        self.assertEqual(json.loads(reply['result']['content'][0]['text']), report)

    def test_presentation_tool_validates_against_the_explored_model_without_writes(self):
        with patch.object(agent_mcp, 'get', return_value={'arch': ARCH}) as read, patch.object(agent_mcp, 'post') as write:
            self.assertEqual(agent_mcp.call('present_findings', REPORT), REPORT)
            read.assert_called_once_with('/api/agent/overview')
            write.assert_not_called()

    def test_rejects_invalid_references_categories_lengths_and_unexpected_fields(self):
        bad_values = []
        for field, value in [('confidence', 'certain'), ('title', 'x' * 121), ('evidence', []), ('next_steps', REPORT['next_steps'] * 4), ('execute', 'command')]:
            report = copy.deepcopy(REPORT); report[field] = value; bad_values.append(report)
        for field, value in [('layer', 32), ('n', -1), ('n', True), ('kind', 'random')]:
            report = copy.deepcopy(REPORT); report['references'][0][field] = value; bad_values.append(report)
        for report in bad_values:
            with self.subTest(report=report), self.assertRaises(ValueError): validate_findings(report, ARCH)

    def test_head_bounds_follow_layer_architecture(self):
        report = copy.deepcopy(REPORT)
        report['references'] = [{'layer': 0, 'n': 31, 'kind': 'head'}]
        self.assertEqual(validate_findings(report, ARCH)['references'][0]['n'], 31)
        full = {**ARCH, 'layer_types': ['full_attention'] * 32}
        with self.assertRaises(ValueError): validate_findings(report, full)
