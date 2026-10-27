r"""Opt-in real MCP/browser/model check; requires --browser-id from a test page.

    .venv\Scripts\python.exe tests/live_chat_smoke.py --browser-id <id>

Appends three visible Chat turns, preserves history, and leaves L7 N1870 at add/writes/+0.8.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import subprocess
import sys
import time


class Mcp:
    def __init__(self):
        root = Path(__file__).resolve().parents[1]
        self.proc = subprocess.Popen([sys.executable, str(root / 'explorer' / 'agent_mcp.py')],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding='utf-8',
            env={**os.environ, 'EXPLORER_CHAT': ''})
        self.serial = 0
        self.rpc('initialize', {'protocolVersion': '2025-06-18', 'capabilities': {},
                               'clientInfo': {'name': 'chat-smoke', 'version': '1'}})

    def rpc(self, method, params):
        self.serial += 1
        self.proc.stdin.write(json.dumps({'id': self.serial, 'method': method, 'params': params}) + '\n')
        self.proc.stdin.flush()
        response = json.loads(self.proc.stdout.readline())
        assert response['id'] == self.serial, response
        return response['result']

    def tool(self, name, browser, **args):
        response = self.rpc('tools/call', {'name': name, 'arguments': {'browser_id': browser, **args}})
        result = json.loads(response['content'][0]['text'])
        return result

    def close(self):
        self.proc.stdin.close()
        self.proc.wait(timeout=5)


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--browser-id', required=True)
    browser = parser.parse_args().browser_id
    client, observer = Mcp(), Mcp()
    try:
        names = {t['name'] for t in client.rpc('tools/list', {})['tools']}
        assert {'get_ui_state', 'set_chat_controls', 'fill_chat_prompt', 'submit_chat_prompt'} <= names
        def call(name, **args):
            result = client.tool(name, browser, **args)
            assert 'error' not in result, result
            return result
        result = call('select_head', layer=7, head=15)
        assert result['state']['selected_head'] == {'layer': 7, 'head': 15}
        for args in ({'layer': 7, 'head': 16}, {'layer': 32, 'head': 0}, {'layer': 0, 'head': -1}):
            assert 'error' in client.tool('select_head', browser, **args)
        print('Acknowledged head selection and invalid-head rejection passed', flush=True)
        call('select_neuron', layer=7, n=1870)
        call('open_tab', tab='chat')
        call('set_chat_controls', mode='add', direction='writes', dose=.8)
        prompt = 'Reply with just OK.'
        call('fill_chat_prompt', prompt=prompt)
        state = call('get_ui_state')['state']
        assert state['selected_neuron'] == {'layer': 7, 'n': 1870, 'kind': 'neuron'}
        assert state['open_tab'] == 'chat'
        assert all(state['chat'][k] == v for k, v in {'dose': .8, 'mode': 'add', 'direction': 'writes', 'prompt': prompt, 'running': False}.items()), state
        baseline = state['chat']['history_length']
        print('Requested select/open/add/writes/+0.8/fill/read-back flow passed', flush=True)
        for mode in ('add', 'mul'):
            for dose in (-.8, 0):
                state = call('set_chat_controls', mode=mode, dose=dose)['state']
                assert state['chat']['dose'] == dose and state['chat']['history_length'] == baseline
        call('set_chat_controls', direction='reads you')
        before = call('get_ui_state')['state']['chat']
        for args in ({'dose': '0.8'}, {'dose': True}, {'dose': float('nan')}, {'dose': float('inf')},
                     {'mode': 'bad'}, {'direction': 'reads'}, {'mode': 'add', 'dose': 'bad'}):
            result = client.tool('set_chat_controls', browser, **args)
            assert 'error' in result, result
            after = call('get_ui_state')['state']['chat']
            for key in ('dose', 'mode', 'direction', 'prompt', 'history_length'):
                assert after[key] == before[key], (args, key, before, after)
        print('Negative/zero doses in add and mul, reads-you direction, and atomic invalid-argument rejection passed', flush=True)
        for dose in (-.8, 0):
            call('set_chat_controls', mode='add', direction='writes', dose=dose)
            call('fill_chat_prompt', prompt='Reply with just OK.')
            result = call('submit_chat_prompt', timeout_seconds=60)
            baseline += 1
            assert result['submission']['status'] == 'completed' and result['submission']['dose'] == dose, result
            assert result['state']['chat']['history_length'] == baseline, result
        print('Live negative-dose and zero-dose submissions completed', flush=True)
        call('set_chat_controls', mode='add', direction='writes', dose=.8)
        call('fill_chat_prompt', prompt='Count from 1 to 12, separated by spaces, and nothing else.')
        with ThreadPoolExecutor(1) as pool:
            future = pool.submit(client.tool, 'submit_chat_prompt', browser, timeout_seconds=180)
            observed = False
            for _ in range(100):
                current = observer.tool('get_ui_state', browser)
                assert 'error' not in current, current
                if current['state']['chat']['running']:
                    duplicate = observer.tool('submit_chat_prompt', browser, timeout_seconds=10)
                    assert 'already running' in duplicate.get('error', ''), duplicate
                    observed = True
                    break
                if future.done(): break
                time.sleep(.05)
            result = future.result(timeout=200)
            assert 'error' not in result, result
            assert result['submission']['status'] == 'completed', result
            assert result['state']['chat']['running'] is False
            assert result['state']['chat']['history_length'] == baseline + 1
            assert any(result['submission']['replies']), result
            print('Live visible prompt submission completed; busy-state rejection observed:', observed, flush=True)
        call('set_chat_controls', direction='reads you')
        call('fill_chat_prompt', prompt='Hello world.')
        result = call('submit_chat_prompt', timeout_seconds=60)
        assert result['submission']['direction'] == 'reads you'
        assert result['state']['chat']['history_length'] == baseline + 1
        call('set_chat_controls', mode='add', direction='writes', dose=.8)
        print('Reads-you submission completed without changing Chat history', flush=True)
        call('select_neuron', layer=7, n=1871)
        call('select_neuron', layer=7, n=1870)
        assert call('get_ui_state')['state']['chat']['history_length'] == baseline + 1
        call('fill_chat_prompt', prompt=prompt)
        state = call('get_ui_state')['state']
        print('Per-neuron history preserved. Final applied state:', json.dumps(state), flush=True)
    finally:
        client.close(); observer.close()


if __name__ == '__main__': main()
