from fastapi.testclient import TestClient
from app.main import create_app
from plugins.conversation_atlas.backend.main import create_app as atlas_app


def test_dom_overlap_places_late_discovered_history_before_new_messages(tmp_path):
    db=tmp_path/'order.db'
    with TestClient(create_app(db)) as collector, TestClient(atlas_app(db)) as atlas:
        def sync(cid, keys, times=None):
            r=collector.post('/sync',json={'conversation_id':cid,'messages':[
                {'key':k,'role':'user' if k.startswith('u') else 'assistant','content':k,
                 'source_created_at':(times or {}).get(k)} for k in keys], 'observed_order':keys})
            assert r.status_code==200,r.text
        sync('A',['u2','a2','u3','a3'])
        sync('A',['u1','a1','u2','a2'])
        raw=atlas.get('/api/atlas/conversations/A').json()
        assert [m['key'] for m in raw['messages']]==['u1','a1','u2','a2','u3','a3']
        assert raw['quality']['ordering']=='dom_relative'
        assert [m['sourceOrder'] for m in raw['messages']]==list(range(6))
        sync('B',['u1','a1'])
        for _ in range(3): sync('A',['u2','a2'])
    with TestClient(atlas_app(db)) as restarted:
        assert restarted.get('/api/atlas/conversations/A').json()==raw


def test_disconnected_conflicting_and_historical_order_is_explicit(tmp_path):
    db=tmp_path/'unknown.db'
    with TestClient(create_app(db)) as collector,TestClient(atlas_app(db)) as atlas:
        def sync(keys,order=None):
            r=collector.post('/sync',json={'conversation_id':'A','messages':[
                {'key':k,'role':'user','content':k} for k in keys], 'observed_order':order})
            assert r.status_code==200
        sync(['old'])
        sync(['a','b'],['a','b'])
        sync(['c','d'],['c','d'])
        raw=atlas.get('/api/atlas/conversations/A').json()
        assert raw['quality']['ordering']=='partial'
        assert all(m['sourceOrder'] is None for m in raw['messages'])
        assert next(m for m in raw['messages'] if m['key']=='old')['orderStatus']=='unresolved'
        sync(['b','c'],['b','c'])
        raw=atlas.get('/api/atlas/conversations/A').json()
        assert [m['key'] for m in raw['messages'] if m['orderStatus']=='dom_relative']==list('abcd')
        sync(['a','b'],['b','a'])
        raw=atlas.get('/api/atlas/conversations/A').json()
        assert any(m['orderStatus']=='conflict' for m in raw['messages'])
        bad=collector.post('/sync',json={'conversation_id':'A','messages':[], 'observed_order':['invented']})
        assert bad.status_code==422


def test_original_times_take_priority_without_observation_dates(tmp_path):
    db=tmp_path/'time.db'
    with TestClient(create_app(db)) as collector,TestClient(atlas_app(db)) as atlas:
        r=collector.post('/sync',json={'conversation_id':'A','messages':[
            {'key':'a','role':'assistant','content':'later','source_created_at':200},
            {'key':'u','role':'user','content':'earlier','source_created_at':100},
        ],'observed_order':['a','u']})
        assert r.status_code==200
        raw=atlas.get('/api/atlas/conversations/A').json()
        assert [m['key'] for m in raw['messages']]==['u','a']
        assert raw['quality']['ordering']=='source_time'
        assert [m['sourceCreatedAt'] for m in raw['messages']]==[100,200]


def test_legacy_readonly_schema_needs_no_migration_and_order_metadata_does_not_create_save_event(tmp_path):
    import sqlite3
    db=tmp_path/'legacy.db'
    with TestClient(create_app(db)) as collector:
        payload={'conversation_id':'A','messages':[
            {'key':'u','role':'user','content':'question'},
            {'key':'a','role':'assistant','content':'original answer'}]}
        first=collector.post('/sync',json=payload).json()
        payload['observed_order']=['u','a']
        assert collector.post('/sync',json=payload).json()==first
    with sqlite3.connect(db) as connection:
        connection.execute('DROP TABLE conversation_order_evidence')
    with TestClient(atlas_app(db)) as atlas:
        raw=atlas.get('/api/atlas/conversations/A').json()
        assert raw['quality']['ordering']=='unresolved'
        assert {m['content'] for m in raw['messages']}=={'question','original answer'}
    with sqlite3.connect(db) as connection:
        assert not connection.execute("SELECT 1 FROM sqlite_master WHERE name='conversation_order_evidence'").fetchone()
