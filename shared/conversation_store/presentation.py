"""Read-only DOM presentation metadata, independent of semantic message content."""
import hashlib
import ipaddress
import json
import base64
import binascii
import re
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

TAGS = set('text p div h1 h2 h3 h4 h5 h6 strong em del ul ol li blockquote pre code table thead tbody tfoot tr th td a img br hr'.split())
MAX_IMAGE_BYTES = 5_000_000
PUBLIC_IMAGE_HOSTS = {'images.openai.com'}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


def image_data_url(mime, data):
    if mime not in {'image/png', 'image/jpeg', 'image/webp', 'image/gif'} or not data or len(data) > MAX_IMAGE_BYTES:
        return None
    signatures = {
        'image/png': data.startswith(b'\x89PNG\r\n\x1a\n'),
        'image/jpeg': data.startswith(b'\xff\xd8\xff'),
        'image/webp': data.startswith(b'RIFF') and data[8:12] == b'WEBP',
        'image/gif': data.startswith((b'GIF87a', b'GIF89a')),
    }
    return f'data:{mime};base64,{base64.b64encode(data).decode("ascii")}' if signatures[mime] else None


def cache_public_images(document):
    """Keep small, public OpenAI image bytes in presentation metadata only."""
    def visit(node):
        if node['tag'] == 'img' and isinstance(node.get('src'), str):
            url = node['src']
            if urlsplit(url).hostname in PUBLIC_IMAGE_HOSTS and url.startswith('https://'):
                try:
                    with build_opener(NoRedirect()).open(Request(url, headers={'User-Agent': 'Mozilla/5.0'}), timeout=4) as response:
                        if urlsplit(response.geturl()).hostname not in PUBLIC_IMAGE_HOSTS:
                            return
                        mime = response.headers.get_content_type()
                        data = response.read(MAX_IMAGE_BYTES + 1)
                    node['src'] = image_data_url(mime, data) or url
                except (OSError, ValueError):
                    pass  # A failed public fetch retains its original HTTPS reference.
        for child in node.get('children', []):
            visit(child)
    for node in document['nodes']:
        visit(node)
    return document


def body_digest(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def safe_url(value, image=False):
    if not isinstance(value, str):
        return None
    if len(value) > (7_000_000 if image and value.startswith('data:') else 8192):
        return None
    if image and value.startswith('data:'):
        match = re.fullmatch(r'data:(image/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})', value)
        if not match:
            return None
        try:
            data = base64.b64decode(match[2], validate=True)
        except (ValueError, binascii.Error):
            return None
        return value if image_data_url(match[1], data) else None
    try:
        url = urlsplit(value)
        host = (url.hostname or '').lower()
        if url.scheme not in (('https',) if image else ('http', 'https')) or not host or url.username or url.password:
            return None
        if host == 'localhost' or host.endswith(('.localhost', '.local')) or url.port not in (None, 80, 443):
            return None
        try:
            if not ipaddress.ip_address(host).is_global:
                return None
        except ValueError:
            pass
        return value
    except ValueError:
        return None


def validate_presentation(value):
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) != {'version', 'nodes'} or value['version'] != 1 or not isinstance(value['nodes'], list):
        raise ValueError('Unsupported presentation document')
    if len(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()) > 12_000_000:
        raise ValueError('Presentation too large')
    count = 0
    def visit(node, depth=0):
        nonlocal count
        count += 1
        if count > 8000 or depth > 36 or not isinstance(node, dict) or node.get('tag') not in TAGS:
            raise ValueError('Invalid presentation node')
        if set(node) - {'tag', 'text', 'children', 'href', 'src', 'alt', 'start'}:
            raise ValueError('Unexpected presentation attribute')
        result = {'tag': node['tag']}
        if 'text' in node:
            if not isinstance(node['text'], str):
                raise ValueError('Invalid presentation text')
            result['text'] = node['text']
        if 'children' in node:
            if not isinstance(node['children'], list):
                raise ValueError('Invalid presentation children')
            result['children'] = [visit(n, depth+1) for n in node['children']]
        if node['tag'] == 'a':
            result['href'] = safe_url(node.get('href'))
        if node['tag'] == 'img':
            result['src'] = safe_url(node.get('src'), image=True)
            result['alt'] = str(node.get('alt') or '')[:2000]
        if node['tag'] == 'ol' and isinstance(node.get('start'), int):
            result['start'] = max(1, min(node['start'], 100000))
        return result
    return {'version': 1, 'nodes': [visit(node) for node in value['nodes']]}


def save_presentation(connection, cid, message):
    value = validate_presentation(message.get('presentation'))
    if value is None:
        return
    row = connection.execute('SELECT content FROM messages WHERE conversation_id=? AND message_key=?', (cid, message['key'])).fetchone()
    if not row:
        return
    # Never replace a valid complete presentation with a shorter/changed observation.
    old = connection.execute('SELECT body_digest,payload_json FROM message_presentations WHERE conversation_id=? AND message_key=?', (cid, message['key'])).fetchone()
    incoming = body_digest(message['content'])
    if old and old[0] == body_digest(row[0]) and incoming != old[0]:
        return
    if old and old[0] == incoming:
        def reuse(new, saved):
            if new.get('tag') != saved.get('tag'):
                return
            if new['tag'] == 'img' and isinstance(saved.get('src'), str) and saved['src'].startswith('data:image/'):
                new['src'] = saved['src']
            for a, b in zip(new.get('children', []), saved.get('children', [])):
                reuse(a, b)
        previous = json.loads(old[1])
        for a, b in zip(value['nodes'], previous['nodes']):
            reuse(a, b)
    cache_public_images(value)
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    connection.execute('''INSERT INTO message_presentations VALUES (?,?,?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(conversation_id,message_key) DO UPDATE SET
        body_digest=excluded.body_digest,payload_json=excluded.payload_json,captured_at=excluded.captured_at
        WHERE message_presentations.body_digest!=excluded.body_digest OR message_presentations.payload_json!=excluded.payload_json''',
        (cid, message['key'], incoming, payload))
