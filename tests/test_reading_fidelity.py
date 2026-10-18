import hashlib
import json
import sqlite3
import pytest
from shared.conversation_store.database import init_db
from shared.conversation_store.store import save_observation, read_stored_conversation
from shared.conversation_store.presentation import validate_presentation, safe_url, image_data_url, cache_public_images

def document():
    return {'version':1,'nodes':[{'tag':'h2','children':[{'tag':'text','text':'真实标题'}]},
        {'tag':'p','children':[{'tag':'strong','text':'重点'}]},
        {'tag':'pre','children':[{'tag':'code','text':'def f():\n    return "<script>"'}]},
        {'tag':'img','src':'https://example.org/example.png','alt':'原始图片'}]}

def test_format_only_capture_keeps_body_save_event_and_source_fingerprint(tmp_path):
    path=tmp_path/'source.db';init_db(path)
    m={'key':'chatgpt:00000001-0000-4000-8000-000000000000:assistant','role':'assistant','content':'真实标题\n重点'}
    save_observation('A',[m],path)
    with sqlite3.connect(path) as c:
        before=c.execute('select * from messages').fetchall()
        event=c.execute('select * from collector_save_state').fetchall()
    save_observation('A',[{**m,'presentation':document()}],path)
    save_observation('A',[{**m,'presentation':document()}],path)
    with sqlite3.connect(path) as c:
        assert c.execute('select * from messages').fetchall()==before
        assert c.execute('select * from collector_save_state').fetchall()==event
        assert c.execute('select count(*) from message_presentations').fetchone()[0]==1
    stored=read_stored_conversation('A',path)['messages'][0]
    assert stored['content']==m['content']
    assert stored['presentation']==document()
    assert stored['source_created_at'] is None
    assert stored['presentation_status']=='captured_dom'

def test_shorter_dom_does_not_bind_wrong_snapshot_or_destroy_complete_presentation(tmp_path):
    path=tmp_path/'source.db';init_db(path)
    m={'key':'k','role':'assistant','content':'完整正文保留'}
    save_observation('A',[m],path)
    save_observation('A',[{**m,'content':'短','presentation':document()}],path)
    row=read_stored_conversation('A',path)['messages'][0]
    assert row['content']==m['content'] and row['presentation'] is None
    assert row['presentation_status']=='source_mismatch'
    assert row['observed_presentation']==document()  # Explicit opt-in only; old body stays intact.
    save_observation('A',[{**m,'presentation':document()}],path)
    save_observation('A',[{**m,'content':'短','presentation':{'version':1,'nodes':[{'tag':'p','text':'短'}]}}],path)
    assert read_stored_conversation('A',path)['messages'][0]['presentation']==document()

def test_migration_backs_up_legacy_and_read_does_not_create_schema(tmp_path):
    path=tmp_path/'source.db';init_db(path)
    save_observation('A',[{'key':'k','role':'user','content':'旧原文'}],path)
    with sqlite3.connect(path) as c:c.execute('drop table message_presentations')
    assert read_stored_conversation('A',path)['messages'][0]['presentation'] is None
    assert not list(tmp_path.glob('*.reading-backup-*.db'))
    init_db(path)
    assert len(list(tmp_path.glob('*.reading-backup-*.db')))==1
    assert read_stored_conversation('A',path)['messages'][0]['content']=='旧原文'

@pytest.mark.parametrize('url',['javascript:alert(1)','data:text/html,x','file:///c:/secret','https://127.0.0.1/x','https://localhost/x','https://10.0.0.1/x','https://user:pass@example.com/x','blob:https://chatgpt.com/x'])
def test_unsafe_resource_urls_are_not_renderable(url):
    assert safe_url(url,image=True) is None

def test_untrusted_html_attributes_rejected_without_partial_write(tmp_path):
    path=tmp_path/'source.db';init_db(path)
    with pytest.raises(ValueError):
        save_observation('A',[{'key':'k','role':'assistant','content':'正文','presentation':{'version':1,'nodes':[{'tag':'img','src':'https://example.com/x','onerror':'alert(1)'}]}}],path)
    assert read_stored_conversation('A',path) is None
    with pytest.raises(ValueError):validate_presentation({'version':1,'nodes':[{'tag':'script','text':'alert(1)'}]})

def test_presentation_never_invalidates_completed_segment_or_conversation_digest(tmp_path):
    from plugins.conversation_atlas.backend.incremental_index import IncrementalIndex
    from plugins.conversation_atlas.backend.analysis import prepare_input
    path=tmp_path/'source.db';init_db(path)
    keys=['chatgpt:00000001-0000-4000-8000-000000000000:user','chatgpt:00000002-0000-4000-8000-000000000000:assistant']
    messages=[{'key':k,'role':r,'content':t} for k,r,t in zip(keys,['user','assistant'],['问题','结果'])]
    save_observation('A',messages,path,observed_order=keys)
    index=IncrementalIndex(path,tmp_path/'index.db');index.initialize()
    prepared=index.prepare_batch(index.plan('A'),manual=True)
    analysis={'title':'结果','summary':'说明结果','keywords':[],'outcomes':[],'outcome_evidence':[],
              'key_assistant_answers':[{'message_id':keys[1],'reason':'完整说明'}]}
    index.commit_batch(prepared['batch_id'],[{'operation':'create','segment_id':'s','message_ids':keys,'analysis':analysis,'theme_state':'结束'}],model='test',prompt_version='test')
    before=index.inspect('A');source_digest=prepare_input('A',path)[1]['source_digest']
    save_observation('A',[{**messages[1],'presentation':{'version':1,'nodes':[{'tag':'p','text':'结果'}]}}],path)
    assert index.inspect('A')==before
    assert not index.plan('A')['pending']
    assert prepare_input('A',path)[1]['source_digest']==source_digest


def test_local_image_bytes_survive_reopen_without_touching_message_body(tmp_path):
    path=tmp_path/'source.db';init_db(path)
    png=b'\x89PNG\r\n\x1a\n' + b'example image bytes'
    uri=image_data_url('image/png',png)
    message={'key':'native-user','role':'user','content':'看图'}
    save_observation('A',[message],path)
    save_observation('A',[{**message,'presentation':{'version':1,'nodes':[
        {'tag':'img','src':uri,'alt':'用户附件'}, {'tag':'p','text':'看图'}]}}],path)
    with sqlite3.connect(path) as connection:
        assert connection.execute('select content from messages').fetchone()[0]=='看图'
        assert uri in connection.execute('select payload_json from message_presentations').fetchone()[0]
    row=read_stored_conversation('A',path)['messages'][0]
    assert row['presentation']['nodes'][0]['src']==uri
    assert safe_url('data:image/svg+xml;base64,PHN2Zz4=',image=True) is None


def test_known_public_image_can_be_cached_locally(monkeypatch):
    png=b'\x89PNG\r\n\x1a\n' + b'public image bytes'
    class Response:
        headers=type('Headers',(),{'get_content_type':lambda self:'image/png'})()
        def __enter__(self):return self
        def __exit__(self,*args):return False
        def geturl(self):return 'https://images.openai.com/safe.png'
        def read(self,limit):return png
    class Opener:
        def open(self,request,timeout):return Response()
    monkeypatch.setattr('shared.conversation_store.presentation.build_opener',lambda *args:Opener())
    document={'version':1,'nodes':[{'tag':'img','src':'https://images.openai.com/safe.png','alt':'图'}]}
    cache_public_images(document)
    assert document['nodes'][0]['src']==image_data_url('image/png',png)
