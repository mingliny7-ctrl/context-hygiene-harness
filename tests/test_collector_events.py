import sqlite3
import pytest
from fastapi.testclient import TestClient
from app.main import create_app
from shared.conversation_store.database import init_db
from shared.conversation_store.store import save_observation


def answer(n, text):
    return {'key':f'chatgpt:00000000-0000-4000-8000-{n:012d}:assistant',
            'role':'assistant','content':text}


def test_save_events_count_no_source_order_and_noop_restart(tmp_path):
    db=tmp_path/'events.db'
    with TestClient(create_app(db)) as client:
        def sync(cid, messages):
            r=client.post('/sync',json={'conversation_id':cid,'messages':messages})
            assert r.status_code==200, r.text
            return r.json()
        initial=[answer(i, f'第{i}条回答') for i in range(1,4)]
        first=sync('A', initial+[answer(0,' \n')])
        assert first['assistant_reply_count']==3
        assert first['latest_assistant_status']=='saved_event'
        assert first['latest_assistant_preview']=='第3条回答'
        assert first['latest_save_revision']==3
        body='新增第四条真正保存的模型回答用于检查截断是否合适'
        fourth=sync('A',[answer(4,body)])
        assert fourth['assistant_reply_count']==4
        assert fourth['latest_assistant_preview']==body[:16]+'…'
        assert fourth['latest_save_revision']==4
        for _ in range(3):
            repeated=sync('A',initial+[answer(4,body)])
            assert repeated==fourth
        old=sync('A',[answer(5,'刚发现的旧历史回答')])
        assert old['assistant_reply_count']==5
        assert old['latest_assistant_preview']=='刚发现的旧历史回答'
        extended=sync('A',[answer(1,'第1条回答更新成更长的实际正文')])
        assert extended['latest_save_revision']==6
        assert extended['assistant_reply_count']==5
        assert extended['latest_assistant_preview']=='第1条回答更新成更长的实际正文'
        assert sync('B',[answer(1,'另一个对话')])['assistant_reply_count']==1
        # The entire write and event must rollback together.
        with pytest.raises(KeyError):
            save_observation('A',[answer(6,'必须回滚'),{'key':'bad','role':'assistant'}],db)
        assert client.get('/conversations/A/status').json()==extended
    with TestClient(create_app(db)) as restarted:
        assert restarted.get('/conversations/A/status').json()==extended


def test_history_migration_no_fabricated_event_and_rollback(tmp_path):
    db=tmp_path/'old.db'
    init_db(db)
    with sqlite3.connect(db) as c:
        c.execute('DROP TABLE IF EXISTS collector_save_state')
        c.execute("INSERT INTO conversations (conversation_id) VALUES ('old')")
        row=answer(1,'历史上已经存在的原始回答')
        c.execute('INSERT INTO messages(conversation_id,message_key,role,content) VALUES (?,?,?,?)',
                  ('old',row['key'],row['role'],row['content']))
    with TestClient(create_app(db)) as client:
        status=client.get('/conversations/old/status').json()
        assert status['assistant_reply_count']==1
        assert status['latest_assistant_status']=='history_untracked'
        assert status['latest_assistant_preview'] is None
        unchanged=client.post('/sync',json={'conversation_id':'old','messages':[row]}).json()
        assert unchanged==status
        legacy=client.post('/sync',json={'conversation_id':'old','messages':[
            {'key':'fallback-turn-0:assistant','role':'assistant','content':row['content']}]}).json()
        assert legacy['assistant_reply_count'] is None
        assert legacy['confirmed_assistant_reply_count']==1
    with sqlite3.connect(db) as c:
        c.execute('DROP TABLE collector_save_state')
        assert c.execute('SELECT count(*) FROM messages').fetchone()[0]==2
    init_db(db)
    with TestClient(create_app(db)) as client:
        assert client.get('/conversations/old/status').json()['latest_assistant_status']=='history_untracked'


def test_invalid_assistant_cannot_leave_an_effective_preview(tmp_path):
    with TestClient(create_app(tmp_path/'invalid.db')) as client:
        def sync(messages):
            return client.post('/sync',json={'conversation_id':'A','messages':messages}).json()
        assert sync([answer(1,'有效回答')])['latest_assistant_status']=='saved_event'
        invalid=sync([answer(1,' '*20)])
        assert invalid['assistant_reply_count']==0
        assert invalid['latest_assistant_status']=='empty'
        assert invalid['latest_assistant_preview'] is None
