import asyncio
import unittest
import uuid
from unittest.mock import patch

from server_fixture import JsonRequest, load_server

from ui_bridge import UiBridge, validate_ui_command


server = load_server()


class ValidationTests(unittest.TestCase):
    def test_negative_zero_and_all_or_nothing_validation(self):
        arch = {'n_layers': 32, 'inter': 9216}
        for dose in [-.8, 0, .8]:
            self.assertEqual(validate_ui_command({'action': 'chat_controls', 'dose': dose}, arch)['dose'], dose)
        for values in [{'dose': True}, {'dose': '0.8'}, {'dose': float('nan')}, {'dose': float('inf')},
                       {'mode': 'multiply'}, {'direction': 'reads'}, {}, {'mode': 'mul', 'dose': 'bad'}]:
            with self.subTest(values=values), self.assertRaises(ValueError):
                validate_ui_command({'action': 'chat_controls', **values}, arch)
        for command in [None, [], {'action': []}, {'action': 'select', 'layer': 7, 'n': 9216},
                        {'action': 'select', 'layer': True, 'n': 1},
                        {'action': 'chat_prompt', 'prompt': 3},
                        {'action': 'chat_controls', 'dose': 1, 'javascript': 'alert(1)'},
                        {'action': 'chat_submit', 'timeout_seconds': 0}]:
            with self.assertRaises(ValueError): validate_ui_command(command, arch)


class BridgeTests(unittest.IsolatedAsyncioTestCase):
    async def test_returns_browser_ack_not_queue_confirmation(self):
        bridge = UiBridge(); browser = str(uuid.uuid4()); client = bridge.connect(browser)
        task = asyncio.create_task(bridge.command({'action': 'state'}))
        request = await client['queue'].get()
        self.assertFalse(task.done())
        applied = {'state': {'browser_id': browser, 'chat': {'dose': -.8, 'running': False}}}
        self.assertFalse(bridge.complete(str(uuid.uuid4()), request['id'], applied))
        self.assertTrue(bridge.complete(browser, request['id'], applied))
        self.assertEqual(await task, applied)
        self.assertFalse(bridge.complete(browser, request['id'], applied))

    async def test_disconnect_timeout_reconnect_and_multiple_browsers(self):
        bridge = UiBridge()
        with self.assertRaisesRegex(ValueError, 'no connected'): bridge.resolve()
        browser = str(uuid.uuid4()); client = bridge.connect(browser)
        task = asyncio.create_task(bridge.command({'action': 'chat_submit'}, browser))
        await client['queue'].get()
        bridge.disconnect(browser, client)
        self.assertIn('disconnected', (await task)['error'])
        client = bridge.connect(browser)
        result = await bridge.command({'action': 'state'}, browser, timeout=.01)
        self.assertIn('timed out', result['error'])
        request = await client['queue'].get()
        self.assertEqual((await client['queue'].get())['cancel'], request['id'])
        self.assertFalse(bridge.complete(browser, request['id'], {'state': {}}))
        old = client
        task = asyncio.create_task(bridge.command({'action': 'state'}, browser))
        await old['queue'].get()
        client = bridge.connect(browser)
        self.assertIn('disconnected', (await task)['error'])
        bridge.disconnect(browser, old)
        self.assertIs(bridge.clients[browser], client)
        bridge.connect(str(uuid.uuid4()))
        with self.assertRaisesRegex(ValueError, 'multiple'): bridge.resolve()

    async def test_route_uses_bound_browser_and_rejects_bad_commands_before_queueing(self):
        bridge = UiBridge(); bound = str(uuid.uuid4()); other = str(uuid.uuid4())
        client = bridge.connect(bound); extra = bridge.connect(other)
        server._chats['ui-test'] = {'browser': bound}
        with patch.object(server, 'ui_bridge', bridge):
            task = asyncio.create_task(server.agent_ui(JsonRequest({'action': 'state', 'chat': 'ui-test'})))
            request = await client['queue'].get()
            self.assertTrue(extra['queue'].empty())
            await server.agent_ui_result(JsonRequest({'browser': bound, 'id': request['id'], 'result': {'state': {'open_tab': 'chat'}}}))
            self.assertEqual((await task)['state']['open_tab'], 'chat')
            result = await server.agent_ui(JsonRequest({'action': 'chat_controls', 'mode': 'mul', 'dose': 'bad', 'chat': 'ui-test'}))
            self.assertIn('error', result)
            self.assertTrue(client['queue'].empty())
            bridge.disconnect(bound, client)
            result = await server.agent_ui(JsonRequest({'action': 'state', 'chat': 'ui-test'}))
            self.assertIn('disconnected', result['error'])  # never fall back to another user's browser
        server._chats.pop('ui-test', None)


if __name__ == '__main__': unittest.main()
