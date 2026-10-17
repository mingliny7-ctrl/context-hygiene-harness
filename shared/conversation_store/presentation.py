"""Read-only DOM presentation metadata, independent of semantic message content."""
import hashlib
import ipaddress
import json
from urllib.parse import urlsplit

TAGS = set('text p div h1 h2 h3 h4 h5 h6 strong em del ul ol li blockquote pre code table thead tbody tfoot tr th td a img br hr'.split())


def body_digest(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def safe_url(value, image=False):
    if not isinstance(value, str) or len(value) > 8192:
        return None
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
    if len(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()) > 500_000:
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
    old = connection.execute('SELECT body_digest FROM message_presentations WHERE conversation_id=? AND message_key=?', (cid, message['key'])).fetchone()
    incoming = body_digest(message['content'])
    if old and old[0] == body_digest(row[0]) and incoming != old[0]:
        return
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    connection.execute('''INSERT INTO message_presentations VALUES (?,?,?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(conversation_id,message_key) DO UPDATE SET
        body_digest=excluded.body_digest,payload_json=excluded.payload_json,captured_at=excluded.captured_at
        WHERE message_presentations.body_digest!=excluded.body_digest OR message_presentations.payload_json!=excluded.payload_json''',
        (cid, message['key'], incoming, payload))
