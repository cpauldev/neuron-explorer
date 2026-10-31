"""Model choices for the existing CLI assistants; no global configuration writes."""
import asyncio
import os
import re
import time

_cache = {}


def validate_model(value):
    if value is None:
        return None
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:/@+\[\]-]{0,159}', value):
        raise ValueError('choose a valid assistant model')
    return value


async def model_catalog(provider, cwd, codex_type):
    configured = os.environ.get(f'EXPLORER_{provider.upper()}_MODEL')
    key = (provider, configured, os.environ.get('EXPLORER_CODEX_BIN'))
    cached = _cache.get(key)
    if cached and time.monotonic() - cached[0] < 60:
        return cached[1]
    models = [{'id': 'default', 'name': 'CLI default',
               'description': f'Use {configured}' if configured else 'Use the model configured in your CLI'}]
    if configured:
        models.append({'id': configured, 'name': configured, 'description': 'Configured server model'})
    warning = None
    if provider == 'claude':
        # Documented CLI aliases resolve using the person's provider/account settings.
        models.extend({'id': alias, 'name': f'Claude {alias.title()}',
                       'description': 'CLI alias · availability depends on your account'}
                      for alias in ('sonnet', 'opus', 'haiku'))
    else:
        os.makedirs(cwd, exist_ok=True)
        client = codex_type(cwd, asyncio.Queue())
        try:
            async with asyncio.timeout(12):
                await client.start()
                cursor = None
                for _ in range(10):
                    page = await client.call('model/list', {'cursor': cursor, 'includeHidden': False})
                    for item in page.get('data', []):
                        identifier = item.get('model') or item.get('id')
                        if not isinstance(identifier, str) or item.get('hidden'):
                            continue
                        models.append({'id': identifier, 'name': item.get('displayName') or identifier,
                                       'description': item.get('description') or 'Available in Codex CLI'})
                    cursor = page.get('nextCursor')
                    if not cursor:
                        break
        except Exception as error:
            warning = f'Model discovery unavailable: {error or "timed out"}. CLI default remains available.'
        finally:
            await client.close()
    result = {'models': list({m['id']: m for m in models}.values()), 'warning': warning}
    _cache[key] = (time.monotonic(), result)
    return result
