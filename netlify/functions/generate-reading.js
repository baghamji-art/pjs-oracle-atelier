exports.handler = async function(event) {
  if (event.httpMethod === 'GET') {
    return json(200, { ok: true, message: 'generate-reading function is alive' });
  }

  if (event.httpMethod === 'OPTIONS') {
    return json(204, {});
  }

  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return json(500, { error: 'OPENAI_API_KEY is not set' });
  }

  let body = {};
  try {
    body = JSON.parse(event.body || '{}');
  } catch (error) {
    return json(400, { error: 'Invalid JSON body' });
  }

  const question = safeText(body.question, 160);
  const qtype = safeText(body.qtype, 80);
  const language = safeText(body.language || 'ko', 8);
  const userContext = body.userContext && typeof body.userContext === 'object' ? body.userContext : {};
  const cards = Array.isArray(body.cards) ? body.cards.slice(0, 3).map(card => ({
    nameKo: safeText(card.nameKo, 60),
    nameEn: safeText(card.nameEn, 80),
    orientation: safeText(card.orientation, 20),
    position: safeText(card.position, 60),
    key: safeText(card.key, 60)
  })) : [];
  const dbReport = safeText(body.dbReport, 6000);

  if (!question || !cards.length || !dbReport) {
    return json(400, { error: 'Missing question, cards, or dbReport' });
  }

  const isDatingPossibility = qtype === 'dating_possibility' || /연애로 발전|관계.*발전|situationship|connection.*relationship/i.test(question);
  const isPastLifeConnection = qtype === 'past_life_connection' || /전생에서\s*이어진\s*인연/i.test(question);
  const reportShape = isDatingPossibility ? [
    '',
    'Q1 전용 작성 규칙:',
    '- 이 질문은 "이 관계가 연애로 발전할 수 있을까? (썸 전용)"에 대한 리포트다.',
    '- sections는 반드시 아래 5개 heading을 이 순서 그대로 사용한다.',
    '  1. 관계의 발전성',
    '  2. 상대방의 속마음',
    '  3. 관계의 문제점',
    '  4. 앞으로 해야 할 행동',
    '  5. 마무리 멘트',
    '- 각 section body는 4~6문장으로 작성한다.',
    '- 첫 문장은 결론을 바로 말하고, 다음 문장부터 근거와 흐름을 이어 붙인다.',
    '- "먼저/두 번째/마지막으로" 같은 나열식 연결어를 쓰지 않는다.',
    '- "그런데", "다만", "그래서", "이 때문에", "반대로" 같은 연결어를 문맥에 맞게 자연스럽게 섞는다.',
    '- 카드 3장의 의미를 각각 따로 설명하지 말고, 서로 밀고 당기는 흐름으로 합쳐 해석한다.',
    '- 상대가 이미 연인처럼 행동한다고 단정하지 말고, 썸/애매한 관계에서 실제로 확인 가능한 태도 중심으로 쓴다.',
    '- body 안에서 같은 결론 문장을 반복하지 않는다.',
    '- 마무리 멘트는 감성적이되 과장하지 말고, 사용자가 다음 행동을 정리할 수 있게 쓴다.',
    '- headline은 관계 발전 가능성에 대한 한 문장 결론으로 쓴다.'
  ] : isPastLifeConnection ? [
    '',
    '운1 전용 작성 규칙:',
    '- 이 질문은 "전생에서 이어진 인연이 이번 생에도 나타날까?"에 대한 리포트다.',
    '- 제공된 DB 문구에 있는 인물 유형, 관계의 특징, 다시 만난 이유를 빠뜨리거나 바꾸지 않는다.',
    '- 카드 스토리의 시대·장소·사건과 성씨·색·말투·행동 단서는 새로 만들지 않는다.',
    '- sections는 반드시 아래 3개 heading을 이 순서 그대로 사용한다.',
    '  1. 한눈에 보는 결론',
    '  2. 그 사람의 특징',
    '  3. 왜 다시 만났을까?',
    '- 각 section body는 2~3문장으로, 중복 없이 짧고 구체적으로 쓴다.',
    '- 사용자를 "너"라고 부르거나 주어를 생략하고, 전체 문장은 자연스러운 반말로 쓴다.',
    '- "성장하기", "이어지기", "놓아주기"처럼 행동이 보이지 않는 추상어만으로 결론 내리지 않는다.',
    '- 왜 다시 만났는지는 실제로 확인할 수 있는 약속, 날짜, 돈, 역할, 연락, 선택 같은 행동 기준으로 설명한다.',
    '- headline은 이번 생에 나타날 가능성과 가장 가까운 인물 유형을 한 문장으로 답한다.'
  ] : [
    '',
    '일반 작성 규칙:',
    '- 기존 리포트의 섹션 구조를 최대한 유지한다.',
    '- 각 section body는 3~5문장으로 작성한다.',
    '- 문장 사이 연결이 끊기지 않게 원인, 심리, 행동 순서로 이어 쓴다.'
  ];

  const prompt = [
    '너는 PJ의 오라클 아틀리에 타로 리딩 작가다.',
    '역할: 제공된 DB 리딩 문구와 선택 카드 정보를 바탕으로, 사람이 쓴 것처럼 자연스럽고 매끄러운 리딩 리포트를 작성한다.',
    '',
    '절대 규칙:',
    '- DB에 없는 구체적 사건을 단정적으로 지어내지 않는다.',
    '- 같은 문장 구조와 같은 첫 구절을 반복하지 않는다.',
    '- 카드 사전식 설명을 나열하지 않는다.',
    '- 사용자의 질문에 직접 답한다.',
    '- 확정 예언 대신 가능성, 흐름, 현실 조언 중심으로 쓴다.',
    '- 한국어라면 자연스러운 한국어 맞춤법과 띄어쓰기를 지킨다.',
    '',
    '출력은 반드시 JSON만 반환한다. 마크다운 금지.',
    '형식:',
    '{"headline":"한 문장 핵심 결론","sections":[{"heading":"소제목","body":"자연스러운 한 문단"}],"closing":"마무리 조언"}',
    ...reportShape,
    '',
    `언어: ${language}`,
    `질문 유형: ${qtype}`,
    `질문: ${question}`,
    `사용자 선택 상황: ${JSON.stringify(userContext)}`,
    `선택 카드: ${JSON.stringify(cards)}`,
    '',
    'DB/기존 리딩 재료:',
    dbReport
  ].join('\n');

  try {
    const models = unique([process.env.OPENAI_MODEL, 'gpt-4.1-mini', 'gpt-4o-mini'].filter(Boolean));
    let data = null;
    let lastError = null;
    let usedModel = models[0];

    for (const model of models) {
      usedModel = model;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 18000);
      let response;
      try {
        response = await fetch('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          signal: controller.signal,
          body: JSON.stringify({
            model,
            input: prompt,
            store: false,
            temperature: 0.55,
            max_output_tokens: isDatingPossibility ? 2300 : isPastLifeConnection ? 1400 : 1600,
            text: {
              format: {
                type: 'json_schema',
                name: 'tarot_reading_report',
                strict: true,
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    headline: { type: 'string' },
                    sections: {
                      type: 'array',
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          heading: { type: 'string' },
                          body: { type: 'string' }
                        },
                        required: ['heading', 'body']
                      }
                    },
                    closing: { type: 'string' }
                  },
                  required: ['headline', 'sections', 'closing']
                }
              }
            }
          })
        });
      } catch (error) {
        if (error && error.name === 'AbortError') {
          return json(504, { error: 'OpenAI request timed out', model });
        }
        throw error;
      } finally {
        clearTimeout(timeoutId);
      }

      data = await response.json();
      if (response.ok) {
        lastError = null;
        break;
      }
      lastError = data.error?.message || 'OpenAI request failed';
      const retryableModelError = /model|does not exist|not found|unsupported/i.test(lastError);
      if (!retryableModelError) {
        return json(response.status, { error: lastError, model });
      }
    }

    if (lastError) {
      return json(500, { error: lastError, model: usedModel });
    }

    const text = extractOutputText(data);
    if (!text) {
      return json(502, { error: 'OpenAI returned an empty response', model: usedModel });
    }
    return json(200, { result: text, model: usedModel });
  } catch (error) {
    return json(500, { error: error.message || 'Unknown error' });
  }
};

function json(statusCode, payload) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    },
    body: JSON.stringify(payload)
  };
}

function unique(values) {
  return [...new Set(values)];
}

function safeText(value, limit) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function extractOutputText(data) {
  if (typeof data.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }
  const chunks = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === 'output_text' && content.text) chunks.push(content.text);
      if (content.type === 'text' && content.text) chunks.push(content.text);
    }
  }
  return chunks.join('\n').trim();
}
