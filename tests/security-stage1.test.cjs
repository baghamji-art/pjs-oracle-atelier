'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseObjectBody, validateReading } = require('../netlify/functions/_request-validation');
const reading = require('../netlify/functions/generate-reading').handler;
const admin = require('../netlify/functions/admin-auth').handler;
const fixture = () => ({
  question: '전생에서 이어진 인연이 이번 생에도 나타날까?',
  qtype: 'past_life_connection', language: 'ko', userContext: {}, dbReport: '테스트 리딩',
  cards: ['fool', 'magician', 'priestess'].map((key, index) => ({key, nameKo: '테스트 카드', nameEn: 'Fixture', position: String(index), orientation: index ? 'upright' : 'reversed'}))
});
const event = body => ({httpMethod:'POST', headers:{origin:'https://pjtarot.netlify.app','content-type':'application/json'}, body:JSON.stringify(body)});

test('body parser rejects invalid JSON, null, arrays and oversized input', () => {
  for (const body of ['{', 'null', '[]', '1', '"text"']) assert.equal(parseObjectBody({body}, 64).error, 400);
  assert.equal(parseObjectBody({body:JSON.stringify({value:'가'.repeat(60)})}, 64).error, 413);
  const encoded = Buffer.from('{"ok":true}').toString('base64');
  assert.deepEqual(parseObjectBody({body:encoded,isBase64Encoded:true},64).body,{ok:true});
});

test('accepts current three-card request shape and all supported languages', () => {
  for (const language of ['ko','en','zh']) assert.equal(validateReading({...fixture(),language}),true);
});

test('rejects malformed card objects, directions, context and wrong card counts', () => {
  const value=fixture();
  for (const cards of [[],[null],[null,null,null],[{}, {}, {}],value.cards.slice(0,2),[...value.cards,value.cards[0]],value.cards.map(c=>({...c,orientation:'sideways'}))]) {
    assert.equal(validateReading({...value,cards}),false);
  }
  for(const userContext of [null,[],{text:'x'.repeat(9000)}]) assert.equal(validateReading({...value,userContext}),false);
  assert.equal(validateReading({...value,language:'invalid'}),false);
  assert.equal(validateReading({...value,question:{}}),false);
});

test('HTTP handlers reject malformed input before any upstream call; valid requests remain compatible', async () => {
  const previousFetch=global.fetch;
  const previousEnv={...process.env};
  let calls=0;
  process.env.OPENAI_API_KEY='test-only-not-a-real-key';
  process.env.ADMIN_MASTER_CODE='fixture-admin-code-only';
  process.env.ADMIN_SESSION_SECRET='fixture-session-secret-longer-than-32-characters';
  const report=JSON.stringify({headline:'테스트',sections:[{heading:'결론',body:'테스트 문장'}],closing:'테스트'});
  global.fetch=async()=>{calls++;return new Response(JSON.stringify({output_text:report}));};
  try {
    for(const body of [null,[],{...fixture(),cards:[null,null,null]}]) assert.equal((await reading(event(body))).statusCode,400);
    assert.equal((await reading(event({...fixture(),extra:'x'.repeat(70000)}))).statusCode,413);
    for(const body of [null,[],{code:{}},{code:'x'.repeat(257)}]) assert.equal((await admin(event(body))).statusCode,400);
    assert.equal(calls,0);
    const result=await reading(event(fixture()));
    assert.equal(result.statusCode,200);
    assert.equal(JSON.parse(result.body).result,report);
    assert.equal(calls,1);
    const login=await admin(event({code:process.env.ADMIN_MASTER_CODE}));
    assert.equal(login.statusCode,200);
    assert.match(login.headers['Set-Cookie'],/HttpOnly/);
    assert.match(login.headers['Set-Cookie'],/Secure/);
    // Authentication/quota enforcement is NOT claimed by this validation-only stage.
  } finally {
    global.fetch=previousFetch;
    for(const key of ['OPENAI_API_KEY','ADMIN_MASTER_CODE','ADMIN_SESSION_SECRET']) {
      if(previousEnv[key]===undefined) delete process.env[key]; else process.env[key]=previousEnv[key];
    }
  }
});
