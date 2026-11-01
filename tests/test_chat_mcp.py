import sys
import json
import subprocess
from pathlib import Path
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'explorer'))
import agent_mcp


class ChatMcpTests(unittest.TestCase):
    def test_sdk_negotiation_and_invalid_tool_arguments(self):
        import asyncio
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client
        async def run():
            async with stdio_client(StdioServerParameters(command=sys.executable, args=[agent_mcp.__file__])) as (reader, writer):
                async with ClientSession(reader, writer) as session:
                    initialized = await session.initialize()
                    self.assertEqual(initialized.server_info.name, 'explorer')
                    tools = await session.list_tools()
                    self.assertIn('overview', {t.name for t in tools.tools})
                    failed = await session.call_tool('read_file', {})
                    self.assertTrue(failed.is_error)
                    self.assertIn('path', failed.content[0].text)
        asyncio.run(run())

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
