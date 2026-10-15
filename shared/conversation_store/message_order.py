"""Only explicit source times or observed DOM precedence establish chronology."""

import json


def save_order_evidence(connection, cid, messages, observed_order):
    row = connection.execute('SELECT evidence FROM conversation_order_evidence WHERE conversation_id=?', (cid,)).fetchone()
    evidence = json.loads(row[0]) if row else {'times': {}, 'edges': [], 'observed': []}
    for message in messages:
        if message.get('source_created_at') is not None:
            # A timestamp is source data, never derived from observation/save time.
            evidence['times'].setdefault(message['key'], message['source_created_at'])
    if observed_order is not None:
        evidence['observed'] = sorted(set(evidence['observed']) | set(observed_order))
        evidence['edges'] = [list(pair) for pair in sorted(
            {tuple(pair) for pair in evidence['edges']} | set(zip(observed_order, observed_order[1:])))]
    if evidence['times'] or evidence['observed']:
        connection.execute('''INSERT INTO conversation_order_evidence VALUES (?, ?)
            ON CONFLICT(conversation_id) DO UPDATE SET evidence=excluded.evidence''',
            (cid, json.dumps(evidence, sort_keys=True)))


def order_messages(messages, evidence):
    """Connect overlapping windows. Ambiguous/disconnected order is never guessed."""
    evidence = evidence or {'times': {}, 'edges': [], 'observed': []}
    by_key = {m['key']: dict(m) for m in messages}
    times = {k: t for k, t in evidence['times'].items() if k in by_key}
    edges = {tuple(pair) for pair in evidence['edges'] if all(k in by_key for k in pair)}
    # Explicit creation time takes priority over inconsistent DOM observations.
    edges = {(a,b) for a,b in edges if not (a in times and b in times and times[a] > times[b])}
    timed = sorted(times, key=lambda k: times[k])
    for a, b in zip(timed, timed[1:]):
        if times[a] < times[b]:
            edges.add((a,b))
    neighbours = {k: set() for k in by_key}
    after = {k: set() for k in by_key}
    for a,b in edges:
        neighbours[a].add(b); neighbours[b].add(a); after[a].add(b)
    remaining = set(by_key)
    groups = []
    while remaining:
        component, pending = set(), [min(remaining)]
        while pending:
            k = pending.pop()
            if k not in component:
                component.add(k); pending.extend(neighbours[k] - component)
        remaining -= component
        degrees = {k: 0 for k in component}
        for k in component:
            for target in after[k]: degrees[target] += 1
        ready = [k for k in component if not degrees[k]]
        ordered, ambiguous = [], False
        while ready:
            if len(ready) != 1: ambiguous = True
            k = sorted(ready)[0]; ready.remove(k); ordered.append(k)
            for target in after[k]:
                degrees[target] -= 1
                if degrees[target] == 0: ready.append(target)
        status = 'source_time' if all(k in times for k in component) else 'dom_relative'
        if len(ordered) != len(component): status = 'conflict'
        elif ambiguous or not (component & (set(evidence['observed']) | set(times))): status = 'unresolved'
        if status in ('conflict', 'unresolved'): ordered = sorted(component)
        groups.append((ordered, status))
    # Group listing is deterministic, but carries NO between-group chronology.
    groups.sort(key=lambda group: (group[1] in ('conflict','unresolved'), min(group[0])))
    full = len(groups) == 1 and groups[0][1] in ('source_time','dom_relative')
    result = []
    for group_index, (keys, status) in enumerate(groups):
        for index,k in enumerate(keys):
            result.append({**by_key[k], 'source_created_at': times.get(k),
                           'source_order': index if full else None,
                           'order_group': group_index,
                           'relative_order': index if status in ('source_time','dom_relative') else None,
                           'order_status': status})
    quality = groups[0][1] if full else 'partial' if any(s in ('source_time','dom_relative') for _,s in groups) else 'unresolved'
    return result, quality
