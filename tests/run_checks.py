"""Run the release checks without downloading models or contacting assistant providers."""
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def main():
    for directory in ('explorer', 'tests'):
        for path in sorted((ROOT / directory).glob('*.py')):
            compile(path.read_bytes(), str(path), 'exec')
    node = shutil.which('node')
    if node is None:
        raise SystemExit('Node.js is required for the frontend checks.')
    commands = [[sys.executable, '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py', '-v']]
    commands += [[node, '--check', str(path.relative_to(ROOT))] for path in sorted((ROOT / 'explorer/static').glob('*.js'))]
    commands += [[node, str(path.relative_to(ROOT))] for path in sorted((ROOT / 'tests').glob('test_*.cjs'))]
    commands += [[node, str(path.relative_to(ROOT))] for path in sorted((ROOT / 'tests').glob('test_*.mjs'))]
    for command in commands:
        print('Running:', ' '.join(command), flush=True)
        subprocess.run(command, cwd=ROOT, check=True)
    print('All release checks passed.')


if __name__ == '__main__':
    main()
