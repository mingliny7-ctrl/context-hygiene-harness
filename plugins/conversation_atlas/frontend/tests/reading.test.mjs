import test from 'node:test';
import assert from 'node:assert/strict';
import {markdownDocument,renderDocument,renderReading,safeUrl} from '../reading.mjs';

test('stored literal Markdown preserves headings emphasis lists quotes code tables links and images',()=>{
  const value=markdownDocument('# 标题\n\n段落 **重点** 和 `code`\n\n- 项目一\n- 项目二\n\n> 引用\n\n```python\ndef f():\n    return "<script>"\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n[原链接](https://example.com/a) ![原图](https://images.openai.com/a.png)');
  assert.deepEqual(value.nodes.map(n=>n.tag),['h1','p','ul','blockquote','pre','table','p']);
  assert.equal(value.nodes[4].children[0].text,'def f():\n    return "<script>"');
  assert.equal(value.nodes[5].children[1].children[0].children[1].children[0].text,'2');
  assert.ok(value.nodes[1].children.some(n=>n.tag==='strong'));
});

class Node {
  constructor(tag,text=''){this.tagName=tag;this.value=text;this.children=[];this.handlers={};this.className='';this.classList={add:n=>{this.className+=' '+n;}};}
  append(...items){this.children.push(...items);for(const n of items)n.parent=this;}
  replaceChildren(...items){this.children=[];this.append(...items);}
  set textContent(text){this.value=text;this.children=[];}
  get textContent(){return this.value+this.children.map(n=>n.textContent).join('');}
  addEventListener(name,handler){this.handlers[name]=handler;}
  remove(){this.parent.children=this.parent.children.filter(n=>n!==this);}
}
const doc={createElement:t=>new Node(t),createTextNode:t=>new Node('#text',t)};
test('rendering builds inert nodes, refuses scripts and unsafe links, and reports image failure',()=>{
  const root=renderDocument({version:1,nodes:[{tag:'script',text:'EXECUTE'},{tag:'p',text:'<img onerror=alert(1)>'},
    {tag:'a',href:'javascript:alert(1)',text:'link'},{tag:'img',src:'https://images.openai.com/a.png',alt:'原图'}]},doc);
  assert.ok(!root.textContent.includes('EXECUTE'));
  assert.ok(root.textContent.includes('<img onerror=alert(1)>'));
  assert.equal(root.children[2].href,undefined);
  const figure=root.children[3],image=figure.children[0];
  assert.equal(image.referrerPolicy,'no-referrer');image.handlers.error();
  assert.ok(figure.textContent.includes('图片无法访问'));
  assert.ok(!figure.children.includes(image));
});
test('local and temporary image resources cannot silently execute or be fetched',()=>{
  for(const value of ['javascript:x','data:text/html,x','blob:https://chatgpt.com/x','https://127.0.0.1/x','https://172.16.1.1/x'])assert.equal(safeUrl(value,true),null);
});

test('validated local image bytes render from the saved reading document',()=>{
  const src='data:image/png;base64,iVBORw0KGgo=';
  assert.equal(safeUrl(src,true),src);
  const root=renderDocument({version:1,nodes:[{tag:'img',src,alt:'用户附件'}]},doc);
  assert.equal(root.children[0].children[0].src,src);
});

test('actual multiline CODE inside a div keeps indentation without inventing fences in plain text',()=>{
  const root=renderDocument({version:1,nodes:[{tag:'div',children:[{tag:'code',children:[{tag:'text',text:'def f():\n    pass'}]}]}]},doc);
  assert.equal(root.children[0].children[0].tagName,'pre');
  assert.equal(root.textContent,'def f():\n    pass');
});

test('a different captured version displays its structure with warning and retains the saved body',()=>{
  const message={content:'旧原文保留',observedPresentation:{version:1,nodes:[{tag:'h2',text:'当前页面标题'}]}};
  const root=renderReading(message,doc);
  assert.ok(root.textContent.includes('旧正文和索引均未替换'));
  assert.ok(root.textContent.includes('当前页面标题'));
  root.children[1].handlers.click();
  assert.ok(root.textContent.includes('旧原文保留'));
  assert.equal(message.content,'旧原文保留');
  root.children[1].handlers.click();assert.ok(root.textContent.includes('当前页面标题'));
});
