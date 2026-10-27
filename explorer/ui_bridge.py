"""Acknowledged, browser-bound UI commands. No JavaScript evaluation surface."""
import asyncio
import math
import time
import uuid


UI_COMMAND_FIELDS = {
    'state': set(), 'select': {'layer', 'n'}, 'head': {'layer', 'head'}, 'tab': {'tab'},
    'chat_controls': {'dose', 'mode', 'direction'}, 'chat_prompt': {'prompt'},
    'chat_submit': {'timeout_seconds'},
}


def validate_ui_command(body, arch):
    """Validate the whole command before it can mutate any browser state."""
    if not isinstance(body, dict):
        raise ValueError('UI command must be an object')
    action = body.get('action')
    if not isinstance(action, str) or action not in UI_COMMAND_FIELDS:
        raise ValueError('unsupported acknowledged UI command')
    fields = UI_COMMAND_FIELDS[action]
    if set(body) - fields - {'action', 'chat', 'browser_id'}:
        raise ValueError('unknown UI command arguments')
    if 'browser_id' in body and (not isinstance(body['browser_id'], str) or not body['browser_id']):
        raise ValueError('browser_id must be a nonempty string')
    out = {k: v for k, v in body.items() if k in fields}
    if action == 'select':
        for key, maximum in (('layer', arch['n_layers']), ('n', arch['inter'])):
            if type(out.get(key)) is not int or not 0 <= out[key] < maximum:
                raise ValueError(f'{key} must be an integer in [0, {maximum - 1}]')
    if action == 'head':
        validate_head(arch, out.get('layer'), out.get('head'))
    if action == 'tab' and out.get('tab') not in ('examples', 'chat', 'details'):
        raise ValueError('tab must be examples, chat, or details')
    if action == 'chat_controls':
        if not out:
            raise ValueError('provide at least one Chat control')
        if 'dose' in out:
            try:
                finite = type(out['dose']) in (int, float) and math.isfinite(out['dose'])
            except OverflowError:
                finite = False
            if not finite:
                raise ValueError('dose must be a finite number (negative values and zero are supported)')
        if 'mode' in out and out['mode'] not in ('add', 'mul'):
            raise ValueError('mode must be add or mul')
        if 'direction' in out and out['direction'] not in ('writes', 'reads you'):
            raise ValueError('direction must be writes or reads you')
    if action == 'chat_prompt' and not isinstance(out.get('prompt'), str):
        raise ValueError('prompt must be a string')
    if action == 'chat_submit':
        value = out.get('timeout_seconds', 300)
        if type(value) is not int or not 1 <= value <= 900:
            raise ValueError('timeout_seconds must be an integer from 1 to 900')
        out['timeout_seconds'] = value
    return {'action': action, **out}


def validate_head(arch, layer, head):
    if type(layer) is not int or not 0 <= layer < arch['n_layers']:
        raise ValueError('layer is out of range')
    count = arch['attn_heads'] if arch['layer_types'][layer] == 'full_attention' else arch['linear_v_heads']
    if type(head) is not int or not 0 <= head < count:
        raise ValueError(f'head must be an integer in [0, {count - 1}]')


class UiBridge:
    def __init__(self):
        self.clients = {}

    def connect(self, browser):
        if str(uuid.UUID(browser)) != browser:
            raise ValueError('invalid browser id')
        if browser in self.clients:
            self.disconnect(browser, self.clients[browser])
        client = {'queue': asyncio.Queue(), 'pending': {}}
        self.clients[browser] = client
        return client

    def disconnect(self, browser, client):
        if self.clients.get(browser) is client:
            self.clients.pop(browser, None)
        for future in client['pending'].values():
            if not future.done():
                future.set_result({'error': 'browser disconnected before completing the UI command'})

    def resolve(self, browser=None):
        if browser:
            if browser not in self.clients:
                raise ValueError('target browser is disconnected; refresh the explorer')
            return browser
        if not self.clients:
            raise ValueError('no connected explorer browser; open or refresh the explorer')
        if len(self.clients) != 1:
            raise ValueError('multiple explorer browsers are connected; provide browser_id: ' + ', '.join(self.clients))
        return next(iter(self.clients))

    async def command(self, command, browser=None, timeout=20):
        browser = self.resolve(browser)
        client = self.clients[browser]
        request = uuid.uuid4().hex
        future = asyncio.get_running_loop().create_future()
        client['pending'][request] = future
        client['queue'].put_nowait({'id': request, 'command': command, 'expires_at': int((time.time() + timeout) * 1000)})
        try:
            return await asyncio.wait_for(future, timeout)
        except asyncio.TimeoutError:
            return {'error': 'UI command timed out; cancellation requested. Read UI state before retrying.', 'browser_id': browser}
        finally:
            client['pending'].pop(request, None)
            if not future.done() or future.cancelled():
                client['queue'].put_nowait({'cancel': request})

    def complete(self, browser, request, result):
        if not isinstance(browser, str) or not isinstance(request, str):
            raise ValueError('browser and request ids must be strings')
        client = self.clients.get(browser)
        future = client['pending'].get(request) if client else None
        if future is None or future.done():
            return False
        if not isinstance(result, dict):
            raise ValueError('UI result must be an object')
        future.set_result(result)
        return True
