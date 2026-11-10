#!/usr/bin/env python3
"""Pre-declaration probe: ask the configured route to read a real screenshot.

Proves the model accepts image input before any `input: [text, image]` declaration is
written. Reads COMMAND_CODE_API_KEY from the environment, else from /root/.dsh/.env.
Usage: l113-vision-probe.py <png> [model]
"""
import base64
import json
import os
import sys
import urllib.error
import urllib.request


def api_key() -> str:
    key = os.environ.get('COMMAND_CODE_API_KEY', '')
    if key:
        return key
    for line in open('/root/.dsh/.env'):
        if line.startswith('COMMAND_CODE_API_KEY='):
            return line.split('=', 1)[1].strip().strip('"').strip("'")
    raise SystemExit('COMMAND_CODE_API_KEY is not set')


def main() -> None:
    path = sys.argv[1]
    model = sys.argv[2] if len(sys.argv) > 2 else 'deepseek/deepseek-v4.1-flash'
    image = base64.b64encode(open(path, 'rb').read()).decode()
    prompt = (
        'Look at the image. Answer in exactly five lines, no extra text:\n'
        'WIDTH=<width>\nHEIGHT=<height>\nTOKEN=<the big yellow token>\n'
        "ROW=<text after 'Row:'>\nBOX=<color of the rectangle>"
    )
    body = json.dumps({
        'model': model,
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
            'Authorization': 'Bearer ' + api_key(),
            'Content-Type': 'application/json',
            'User-Agent': 'curl/8.5.0',
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as error:
        print('HTTP', error.code, error.read().decode()[:500])
        raise SystemExit(1)
    choice = payload['choices'][0]
    print('finish:', choice.get('finish_reason'), 'usage:', payload.get('usage'))
    print(choice['message'].get('content'))


if __name__ == '__main__':
    main()
