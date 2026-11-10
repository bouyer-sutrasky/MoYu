#!/usr/bin/env python3
"""Pre-declaration probe: ask the configured route to read a real screenshot.

Proves the model accepts image input before any `input: [text, image]` declaration is
written. Key resolution: COMMAND_CODE_API_KEY, then --key-file, then the default
credentials file. Usage: l113-vision-probe.py <png> [model] [--key-file PATH]
"""
import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_KEY_FILE = '/root/.dsh-m5/.credentials.yaml'
USER_AGENT = 'moyu-m6a-evidence/1.0'


def read_key_file(path: str) -> str:
    try:
        with open(path, encoding='utf-8') as handle:
            for line in handle:
                stripped = line.strip()
                if stripped.startswith('COMMAND_CODE_API_KEY:'):
                    return stripped.split(':', 1)[1].strip().strip('"').strip("'")
    except OSError:
        return ''
    return ''


def api_key(key_file: str) -> str:
    key = os.environ.get('COMMAND_CODE_API_KEY', '')
    if key:
        return key
    key = read_key_file(key_file)
    if key:
        return key
    raise SystemExit(
        f'COMMAND_CODE_API_KEY is not set and {key_file} has no COMMAND_CODE_API_KEY entry'
    )


def main() -> None:
    parser = argparse.ArgumentParser(description='Ask a chat-completions route to read a PNG.')
    parser.add_argument('png', help='image file to send')
    parser.add_argument('model', nargs='?', default='deepseek/deepseek-v4.1-flash')
    parser.add_argument(
        '--key-file',
        default=DEFAULT_KEY_FILE,
        help=f'credentials YAML used when the env var is unset (default: {DEFAULT_KEY_FILE})',
    )
    args = parser.parse_args()
    key = api_key(args.key_file)
    with open(args.png, 'rb') as handle:
        image = base64.b64encode(handle.read()).decode()
    prompt = (
        'Look at the image. Answer in exactly five lines, no extra text:\n'
        'WIDTH=<width>\nHEIGHT=<height>\nTOKEN=<the big yellow token>\n'
        "ROW=<text after 'Row:'>\nBOX=<color of the rectangle>"
    )
    body = json.dumps({
        'model': args.model,
        'messages': [{'role': 'user', 'content': [
            {'type': 'text', 'text': prompt},
            {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,' + image}},
        ]}],
        'max_tokens': 3000,
        'temperature': 0,
    }).encode()
    request = urllib.request.Request(
        'https://api.commandcode.ai/provider/v1/chat/completions',
        data=body,
        headers={
            'Authorization': 'Bearer ' + key,
            'Content-Type': 'application/json',
            'User-Agent': USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            raw = response.read().decode('utf-8', errors='replace')
        payload = json.loads(raw)
    except urllib.error.HTTPError as error:
        print('HTTP', error.code, error.read().decode('utf-8', errors='replace')[:500])
        raise SystemExit(1)
    except urllib.error.URLError as error:
        print('network error:', error.reason)
        raise SystemExit(1)
    except TimeoutError:
        print('probe timed out after 180s')
        raise SystemExit(1)
    except json.JSONDecodeError as error:
        print('response was not JSON:', error)
        raise SystemExit(1)
    choice = payload['choices'][0]
    print('finish:', choice.get('finish_reason'), 'usage:', payload.get('usage'))
    print(choice['message'].get('content'))


if __name__ == '__main__':
    main()
