import sys
import json
import subprocess
from pathlib import Path
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'explorer'))
import agent_mcp


class ChatMcpTests(unittest.TestCase):
    def test_malformed_requests_do_not_stop_the_stdio_server(self):
        requests = ['not JSON', '[]', json.dumps({'id': 1, 'method': 'ping', 'params': []}),
                    json.dumps({'id': 2, 'method': 'initialize'}), json.dumps({'id': 3, 'method': 'ping'})]
        result = subprocess.run([sys.executable, agent_mcp.__file__], input='\n'.join(requests) + '\n',
                                text=True, encoding='utf-8', capture_output=True, timeout=10, check=True)
        responses = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual([r['error']['code'] for r in responses[:3]], [-32700, -32600, -32602])
        self.assertEqual(responses[3]['result']['serverInfo']['name'], 'explorer')
        self.assertEqual(responses[4], {'jsonrpc': '2.0', 'id': 3, 'result': {}})

    def test_shared_tool_definitions_and_exact_payloads(self):
        names = {t['name'] for t in agent_mcp.TOOLS}
        self.assertTrue({'get_ui_state', 'set_chat_controls', 'fill_chat_prompt', 'submit_chat_prompt',
                         'select_neuron', 'open_tab', 'steer', 'read_file', 'run_shell'} <= names)
        for dose in (-.8, 0, .8):
            with patch.object(agent_mcp, 'post', return_value={'state': {'chat': {'dose': dose}}}) as post:
                result = agent_mcp.call('set_chat_controls', {'mode': 'add', 'direction': 'writes', 'dose': dose})
                self.assertEqual(post.call_args.args[1]['dose'], dose)
                self.assertEqual(post.call_args.args[1]['action'], 'chat_controls')
                self.assertEqual(result['state']['chat']['dose'], dose)
        with patch.object(agent_mcp, 'post', return_value={'state': {'open_tab': 'chat'}}) as post:
            agent_mcp.call('open_tab', {'tab': 'chat', 'browser_id': 'browser'})
            self.assertEqual(post.call_args.args[1]['browser_id'], 'browser')
            self.assertEqual(post.call_args.args[1]['action'], 'tab')
        with patch.object(agent_mcp, 'post', return_value={'submission': {'status': 'completed'}}) as post:
            agent_mcp.call('submit_chat_prompt', {'timeout_seconds': 400})
            self.assertEqual(post.call_args.kwargs['timeout'], 410)
        with self.assertRaises(ValueError): agent_mcp.call('submit_chat_prompt', {'timeout_seconds': True})


if __name__ == '__main__': unittest.main()
