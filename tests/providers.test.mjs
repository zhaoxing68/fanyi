/**
 * providers.js 单元测试：各服务商协议、错误归一、回退策略。
 * 全部通过注入的 mock fetch 完成，绝不发起真实网络请求。
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  translateWithProvider,
  testProviderConnection,
  TranslatorError,
  resetBingCache,
  setBingThrottleForTests,
} from '../src/lib/providers.js';

const BING_HTML = [
  '<!doctype html><html><head><script>',
  'var params_AbusePreventionHelper = [1700000000000,"bing-token-abc",3600000];',
  'var IG:"0123456789abcdef0123456789abcdef";',
  '</script></head><body>translator</body></html>',
].join('');

function response(text, options) {
  const opts = options || {};
  const status = opts.status || 200;
  return {
    ok: opts.ok !== undefined ? opts.ok : status < 400,
    status,
    url: opts.url || '',
    text: async () => text,
  };
}

function jsonResponse(data, options) {
  return response(JSON.stringify(data), options);
}

function bingPageResponse(url) {
  return response(BING_HTML, { url: url || 'https://cn.bing.com/translator' });
}

function bingTranslateResponse(text) {
  return jsonResponse([{ translations: [{ text, to: 'zh-Hans' }], detectedLanguage: { language: 'en' } }]);
}

function deepseekConfig(overrides) {
  return Object.assign({ apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' }, overrides || {});
}

beforeEach(() => {
  resetBingCache();
  // 单测里把必应节流间隔调到 0，避免真实等待（生产默认 120~250ms 间隔、300ms 刷新重试）
  setBingThrottleForTests({ minGapMs: 0, maxGapMs: 0, authRetryDelayMs: 0 });
});

/* ------------------------------ 必应 ------------------------------ */

test('必应：解析 token 页面并按协议构造 ttranslatev3 请求', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url) === 'https://cn.bing.com/translator') return bingPageResponse();
    return bingTranslateResponse('线程');
  };

  const result = await translateWithProvider({
    providerId: 'bing-free',
    config: {},
    targetLang: 'zh-CN',
    texts: ['thread'],
    fetchImpl,
  });

  assert.deepEqual(result.translations, ['线程']);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.method, 'GET');

  const post = calls[1];
  assert.ok(post.url.indexOf('https://cn.bing.com/ttranslatev3?isVertical=1&&IG=0123456789abcdef0123456789abcdef&IID=translator.5028.1') === 0);
  assert.equal(post.init.method, 'POST');
  assert.equal(post.init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.ok(String(calls[0].init.headers['User-Agent']).indexOf('Mozilla') === 0);
  assert.ok(String(calls[0].init.headers['User-Agent']).indexOf('Edg/') !== -1);
  assert.ok(String(post.init.headers['User-Agent']).indexOf('Mozilla') === 0);
  assert.ok(String(post.init.headers['User-Agent']).indexOf('Edg/') !== -1);

  const body = new URLSearchParams(post.init.body);
  assert.equal(body.get('fromLang'), 'auto-detect');
  assert.equal(body.get('to'), 'zh-Hans');
  assert.equal(body.get('text'), 'thread');
  assert.equal(body.get('token'), 'bing-token-abc'); // token 是页面里的字符串
  assert.equal(body.get('key'), '1700000000000'); // key 是页面里的数字
  assert.equal(typeof body.get('key'), 'string');
});

test('必应：texts 数组逐条串行请求（单次请求只带一条 text）', async () => {
  const posts = [];
  const fetchImpl = async (url, init) => {
    if (String(url) === 'https://cn.bing.com/translator') return bingPageResponse();
    posts.push(new URLSearchParams(init.body));
    return bingTranslateResponse('译文' + posts.length);
  };

  const result = await translateWithProvider({
    providerId: 'bing-free',
    config: {},
    targetLang: 'zh-CN',
    texts: ['thread', 'process'],
    fetchImpl,
  });

  assert.deepEqual(result.translations, ['译文1', '译文2']);
  assert.equal(posts.length, 2);
  assert.equal(posts[0].get('text'), 'thread');
  assert.equal(posts[1].get('text'), 'process');
  assert.equal(posts[0].getAll('text').length, 1);
});

test('必应：长文本按约 1200 字符切分后串行请求', async () => {
  const posts = [];
  const fetchImpl = async (url, init) => {
    if (String(url) === 'https://cn.bing.com/translator') return bingPageResponse();
    posts.push(new URLSearchParams(init.body));
    return bingTranslateResponse('块');
  };

  const longText = 'word '.repeat(400).trim(); // 1999 字符
  const result = await translateWithProvider({
    providerId: 'bing-free',
    config: {},
    targetLang: 'zh-CN',
    texts: [longText],
    fetchImpl,
  });

  assert.ok(posts.length >= 2);
  for (const body of posts) {
    assert.ok(body.get('text').length <= 1200, '单个请求文本长度：' + body.get('text').length);
  }
  assert.equal(result.translations[0], '块'.repeat(posts.length));
});

test('必应：cn 不可用时切换到 www，并使用重定向后的 origin', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    const target = String(url);
    urls.push(target);
    if (target === 'https://cn.bing.com/translator') throw new TypeError('fetch failed');
    if (target === 'https://www.bing.com/translator') return bingPageResponse('https://www.bing.com/translator');
    return bingTranslateResponse('线程');
  };

  const result = await translateWithProvider({
    providerId: 'bing-free',
    config: {},
    targetLang: 'zh-CN',
    texts: ['thread'],
    fetchImpl,
  });

  assert.deepEqual(result.translations, ['线程']);
  assert.equal(urls.length, 3);
  assert.ok(urls[2].indexOf('https://www.bing.com/ttranslatev3') === 0);
});

test('必应：token 过期(401)时强制刷新并重试一次', async () => {
  let tokenPageCount = 0;
  const postTokens = [];
  const fetchImpl = async (url, init) => {
    const target = String(url);
    if (target === 'https://cn.bing.com/translator') {
      tokenPageCount += 1;
      const html = tokenPageCount === 1
        ? BING_HTML
        : BING_HTML.replace('bing-token-abc', 'bing-token-new');
      return response(html, { url: 'https://cn.bing.com/translator' });
    }
    postTokens.push(new URLSearchParams(init.body).get('token'));
    if (postTokens.length === 1) return response('{"statusCode":401}', { status: 401 });
    return bingTranslateResponse('线程');
  };

  const result = await translateWithProvider({
    providerId: 'bing-free',
    config: {},
    targetLang: 'zh-CN',
    texts: ['thread'],
    fetchImpl,
  });

  assert.deepEqual(result.translations, ['线程']);
  assert.equal(tokenPageCount, 2);
  assert.deepEqual(postTokens, ['bing-token-abc', 'bing-token-new']);
});

test('必应：全局串行队列——并发调用时同一时刻最多 1 个 POST 在途', async () => {
  let inflight = 0;
  let maxInflight = 0;
  const postedTexts = [];
  const fetchImpl = async (url, init) => {
    const target = String(url);
    if (target === 'https://cn.bing.com/translator') return bingPageResponse();
    inflight += 1;
    maxInflight = Math.max(maxInflight, inflight);
    postedTexts.push(new URLSearchParams(init.body).get('text'));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 8));
    inflight -= 1;
    return bingTranslateResponse('译:' + new URLSearchParams(init.body).get('text'));
  };

  const results = await Promise.all([
    translateWithProvider({ providerId: 'bing-free', config: {}, targetLang: 'zh-CN', texts: ['alpha'], fetchImpl }),
    translateWithProvider({ providerId: 'bing-free', config: {}, targetLang: 'zh-CN', texts: ['beta'], fetchImpl }),
    translateWithProvider({ providerId: 'bing-free', config: {}, targetLang: 'zh-CN', texts: ['gamma'], fetchImpl }),
  ]);

  assert.equal(maxInflight, 1, '必应 POST 必须全局串行，实际最大在途数：' + maxInflight);
  assert.equal(postedTexts.length, 3);
  assert.deepEqual(new Set(postedTexts), new Set(['alpha', 'beta', 'gamma']));
  for (const result of results) {
    assert.equal(result.translations.length, 1);
    assert.ok(/^译:(alpha|beta|gamma)$/.test(result.translations[0]));
  }
});

test('必应：必应失败且 MyMemory 也不可用时，错误信息保留必应 HTTP 状态', async () => {
  let bingPostCount = 0;
  const fetchImpl = async (url) => {
    const target = String(url);
    if (target === 'https://cn.bing.com/translator') return bingPageResponse();
    if (target.indexOf('bing.com') !== -1) {
      bingPostCount += 1;
      return response('rejected', { status: 401 });
    }
    if (target.indexOf('mymemory') !== -1) return response('rate limited', { status: 429 });
    throw new Error('未预期的请求地址：' + target);
  };

  await assert.rejects(
    translateWithProvider({ providerId: 'bing-free', config: {}, targetLang: 'zh-CN', texts: ['thread'], fetchImpl }),
    (error) => {
      assert.ok(error instanceof TranslatorError);
      assert.equal(error.code, 'RATE_LIMIT');
      assert.ok(error.message.indexOf('必应翻译失败（HTTP 401）') !== -1, '实际信息：' + error.message);
      assert.ok(error.message.indexOf('MyMemory') !== -1, '实际信息：' + error.message);
      return true;
    },
  );
  assert.equal(bingPostCount, 2, '应包含首次请求 + 刷新 token 后重试共 2 次必应 POST');
});

test('必应：401 最终失败时给出不误导的错误文案', async () => {
  const fetchImpl = async () => response('rejected', { status: 401 });
  await assert.rejects(
    translateWithProvider({
      providerId: 'bing-free',
      config: { __freeFallback: false },
      targetLang: 'zh-CN',
      texts: ['thread'],
      fetchImpl,
    }),
    (error) => {
      assert.ok(error instanceof TranslatorError);
      assert.equal(error.code, 'INVALID_KEY');
      assert.ok(error.message.indexOf('拒绝了请求') !== -1);
      assert.ok(error.message.indexOf('密钥') === -1);
      return true;
    },
  );
});

test('必应：zh-TW 目标语言映射为 zh-Hant', async () => {
  let sentTo = '';
  const fetchImpl = async (url, init) => {
    if (String(url) === 'https://cn.bing.com/translator') return bingPageResponse();
    sentTo = new URLSearchParams(init.body).get('to');
    return bingTranslateResponse('執行緒');
  };
  const result = await translateWithProvider({
    providerId: 'bing-free',
    config: {},
    targetLang: 'zh-TW',
    texts: ['thread'],
    fetchImpl,
  });
  assert.equal(sentTo, 'zh-Hant');
  assert.deepEqual(result.translations, ['執行緒']);
});

test('必应：失败时回退 MyMemory 并附带 warning', async () => {
  const mymemoryCalls = [];
  const fetchImpl = async (url) => {
    const target = String(url);
    if (target.indexOf('bing.com') !== -1) return response('service unavailable', { status: 503 });
    mymemoryCalls.push(target);
    return jsonResponse({ responseData: { translatedText: '线程' }, responseStatus: 200 });
  };

  const result = await translateWithProvider({
    providerId: 'bing-free',
    config: {},
    targetLang: 'zh-CN',
    texts: ['thread'],
    fetchImpl,
  });

  assert.deepEqual(result.translations, ['线程']);
  assert.equal(result.unprotected, false);
  assert.equal(mymemoryCalls.length, 1);
  assert.ok(result.warnings.some((warning) => warning.indexOf('MyMemory') !== -1));
});

test('必应：术语保护下回退 MyMemory 时直接翻译未保护原文', async () => {
  let mymemoryQuery = '';
  const fetchImpl = async (url) => {
    const target = String(url);
    if (target.indexOf('bing.com') !== -1) throw new TypeError('fetch failed');
    if (target.indexOf('mymemory') !== -1) {
      mymemoryQuery = new URL(target).searchParams.get('q');
      return jsonResponse({ responseData: { translatedText: '一个线程是安全的' }, responseStatus: 200 });
    }
    throw new Error('未预期的请求地址：' + target);
  };

  const result = await translateWithProvider({
    providerId: 'bing-free',
    config: { __originalTexts: ['A thread is safe.'] },
    targetLang: 'zh-CN',
    texts: ['A ⟦T0⟧ is safe.'],
    fetchImpl,
  });

  assert.deepEqual(result.translations, ['一个线程是安全的']);
  assert.equal(result.unprotected, true);
  assert.equal(mymemoryQuery, 'A thread is safe.');
  assert.ok(result.warnings.some((warning) => warning.indexOf('未启用术语保护') !== -1));
});

test('必应：__freeFallback=false 时抛错且不回退', async () => {
  const fetchImpl = async () => response('boom', { status: 500 });
  await assert.rejects(
    translateWithProvider({
      providerId: 'bing-free',
      config: { __freeFallback: false },
      targetLang: 'zh-CN',
      texts: ['thread'],
      fetchImpl,
    }),
    (error) => error instanceof TranslatorError && error.code === 'UPSTREAM_ERROR' && error.provider === 'bing-free',
  );
});

/* ------------------------------ 大模型 ------------------------------ */

test('DeepSeek：自动补 /v1 并发出标准 Chat Completions 请求', async () => {
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
    return jsonResponse({ choices: [{ message: { content: '线程' } }] });
  };

  const result = await translateWithProvider({
    providerId: 'deepseek',
    config: deepseekConfig(),
    targetLang: 'zh-CN',
    texts: ['thread'],
    fetchImpl,
  });

  assert.equal(captured.url, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(captured.headers.Authorization, 'Bearer sk-test');
  assert.equal(captured.body.model, 'deepseek-chat');
  assert.equal(captured.body.temperature, 0.2);
  assert.equal(captured.body.stream, false);
  assert.deepEqual(JSON.parse(captured.body.messages[1].content), { texts: ['thread'] });
  assert.deepEqual(result.translations, ['线程']);
  assert.equal(result.raw, '线程');
});

test('OpenAI 兼容：baseUrl 已含 /v1 不重复拼接，apiKey 可留空', async () => {
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = { url: String(url), headers: init.headers };
    return jsonResponse({ choices: [{ message: { content: '线程' } }] });
  };

  await translateWithProvider({
    providerId: 'openai-compatible',
    config: { apiKey: '', baseUrl: 'https://api.example.com/v1/', model: 'local-model' },
    targetLang: 'zh-CN',
    texts: ['thread'],
    fetchImpl,
  });

  assert.equal(captured.url, 'https://api.example.com/v1/chat/completions');
  assert.equal(captured.headers.Authorization, undefined);
});

test('LLM：错误状态归一为 INVALID_KEY / RATE_LIMIT / UPSTREAM_ERROR，且不泄露密钥', async () => {
  const cases = [[401, 'INVALID_KEY'], [429, 'RATE_LIMIT'], [500, 'UPSTREAM_ERROR']];
  for (const [status, code] of cases) {
    const fetchImpl = async () => response(JSON.stringify({ error: { message: 'server says no' } }), { status });
    await assert.rejects(
      translateWithProvider({
        providerId: 'deepseek',
        config: deepseekConfig({ apiKey: 'sk-secret' }),
        targetLang: 'zh-CN',
        texts: ['thread'],
        fetchImpl,
      }),
      (error) => {
        assert.ok(error instanceof TranslatorError);
        assert.equal(error.code, code);
        assert.ok(error.message.indexOf('sk-secret') === -1);
        return true;
      },
    );
  }
});

test('配置校验：必填字段为空抛 PROVIDER_NOT_CONFIGURED，未知服务商抛 UNKNOWN_PROVIDER', async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return jsonResponse({});
  };
  await assert.rejects(
    translateWithProvider({ providerId: 'deepseek', config: { apiKey: '', baseUrl: '', model: '' }, targetLang: 'zh-CN', texts: ['thread'], fetchImpl }),
    (error) => error instanceof TranslatorError && error.code === 'PROVIDER_NOT_CONFIGURED' && error.message.indexOf('设置') !== -1,
  );
  await assert.rejects(
    translateWithProvider({ providerId: 'no-such-provider', config: {}, targetLang: 'zh-CN', texts: ['thread'], fetchImpl }),
    (error) => error instanceof TranslatorError && error.code === 'UNKNOWN_PROVIDER',
  );
  assert.equal(called, false);
});

test('外部 AbortSignal 已取消时抛 ABORTED 且不发起请求', async () => {
  let called = false;
  const controller = new AbortController();
  controller.abort();
  const fetchImpl = async () => {
    called = true;
    return jsonResponse({});
  };
  await assert.rejects(
    translateWithProvider({ providerId: 'mymemory', config: {}, targetLang: 'zh-CN', texts: ['thread'], fetchImpl, signal: controller.signal }),
    (error) => error instanceof TranslatorError && error.code === 'ABORTED',
  );
  assert.equal(called, false);
});

/* ------------------------------ Azure ------------------------------ */

test('Azure：批量请求、语言映射与请求头正确', async () => {
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
    return jsonResponse(captured.body.map((item) => ({ translations: [{ text: '译:' + item.Text }] })));
  };

  const result = await translateWithProvider({
    providerId: 'azure',
    config: { apiKey: 'azure-key', region: 'eastasia' },
    targetLang: 'zh-CN',
    texts: ['one', 'two'],
    fetchImpl,
  });

  assert.deepEqual(result.translations, ['译:one', '译:two']);
  assert.equal(captured.url, 'https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=zh-Hans');
  assert.equal(captured.headers['Ocp-Apim-Subscription-Key'], 'azure-key');
  assert.equal(captured.headers['Ocp-Apim-Subscription-Region'], 'eastasia');
  assert.deepEqual(captured.body, [{ Text: 'one' }, { Text: 'two' }]);
});

test('Azure：超过 100 条自动分批并按原顺序返回', async () => {
  const batchSizes = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    batchSizes.push(body.length);
    return jsonResponse(body.map((item) => ({ translations: [{ text: item.Text + '!' }] })));
  };

  const texts = Array.from({ length: 120 }, (unused, index) => 'item-' + index);
  const result = await translateWithProvider({
    providerId: 'azure',
    config: { apiKey: 'k', region: 'r' },
    targetLang: 'en',
    texts,
    fetchImpl,
  });

  assert.deepEqual(batchSizes, [100, 20]);
  assert.equal(result.translations.length, 120);
  assert.equal(result.translations[0], 'item-0!');
  assert.equal(result.translations[119], 'item-119!');
});

test('Azure：401 归一为 INVALID_KEY', async () => {
  const fetchImpl = async () => response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 });
  await assert.rejects(
    translateWithProvider({ providerId: 'azure', config: { apiKey: 'k', region: 'r' }, targetLang: 'zh-CN', texts: ['one'], fetchImpl }),
    (error) => error instanceof TranslatorError && error.code === 'INVALID_KEY',
  );
});

/* ------------------------------ MyMemory ------------------------------ */

test('MyMemory：按 450 字节切片、langpair/de 参数正确且按序拼接', async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(String(url));
    requests.push(parsed);
    return jsonResponse({ responseData: { translatedText: '译' + requests.length }, responseStatus: 200 });
  };

  const longText = 'word '.repeat(200).trim(); // 999 字节
  const result = await translateWithProvider({
    providerId: 'mymemory',
    config: { email: 'me@example.com' },
    targetLang: 'zh-CN',
    texts: [longText],
    fetchImpl,
  });

  assert.ok(requests.length >= 2);
  for (const parsed of requests) {
    const query = parsed.searchParams.get('q');
    const bytes = new TextEncoder().encode(query).length;
    assert.ok(bytes <= 450, 'q 参数字节数应为 450 以内，实际：' + bytes);
    assert.equal(parsed.searchParams.get('langpair'), 'en|zh-CN');
    assert.equal(parsed.searchParams.get('de'), 'me@example.com');
  }
  const expected = requests.map((unused, index) => '译' + (index + 1)).join('');
  assert.equal(result.translations[0], expected);
});

test('MyMemory：quotaFinished 归一为 QUOTA_EXCEEDED', async () => {
  const fetchImpl = async () => jsonResponse({ quotaFinished: true, responseData: { translatedText: 'x' }, responseStatus: 200 });
  await assert.rejects(
    translateWithProvider({ providerId: 'mymemory', config: {}, targetLang: 'zh-CN', texts: ['thread'], fetchImpl }),
    (error) => error instanceof TranslatorError && error.code === 'QUOTA_EXCEEDED',
  );
});

/* ------------------------------ Google ------------------------------ */

test('Google：拼接响应数组第一列', async () => {
  const fetchImpl = async () => jsonResponse([[['你好', 'hello']], null, 'en']);
  const result = await translateWithProvider({
    providerId: 'google-free',
    config: {},
    targetLang: 'zh-CN',
    texts: ['hello'],
    fetchImpl,
  });
  assert.deepEqual(result.translations, ['你好']);
});

test('Google：网络不可达归一 NETWORK_ERROR 并提示改用必应或 DeepSeek', async () => {
  const fetchImpl = async () => {
    throw new TypeError('fetch failed');
  };
  await assert.rejects(
    translateWithProvider({ providerId: 'google-free', config: {}, targetLang: 'zh-CN', texts: ['hello'], fetchImpl }),
    (error) => {
      assert.ok(error instanceof TranslatorError);
      assert.equal(error.code, 'NETWORK_ERROR');
      assert.ok(error.message.indexOf('当前网络无法访问 Google') !== -1);
      assert.ok(error.message.indexOf('必应') !== -1);
      return true;
    },
  );
});

test('Google：长文本分段请求后按序拼接', async () => {
  let callCount = 0;
  const fetchImpl = async () => {
    callCount += 1;
    return jsonResponse([[['段' + callCount, 'x']], null, 'en']);
  };
  const result = await translateWithProvider({
    providerId: 'google-free',
    config: {},
    targetLang: 'zh-CN',
    texts: ['word '.repeat(300).trim()], // 1499 字符，超过单次上限
    fetchImpl,
  });
  assert.ok(callCount >= 2);
  assert.equal(result.translations[0], Array.from({ length: callCount }, (unused, index) => '段' + (index + 1)).join(''));
});

/* ------------------------------ 离线词典 ------------------------------ */

test('glossary：离线替换命中的术语，不发起网络请求', async () => {
  const entries = [
    { en: 'thread', zh: '线程', category: '测试', pos: 'noun', aliases: [] },
    { en: 'garbage collection', zh: '垃圾回收', category: '测试', pos: 'noun', aliases: [] },
    { en: 'garbage', zh: '垃圾', category: '测试', pos: 'noun', aliases: [] },
  ];
  let called = false;
  const fetchImpl = async () => {
    called = true;
    throw new Error('离线模式不应联网');
  };

  const result = await translateWithProvider({
    providerId: 'glossary',
    config: { __glossary: entries },
    targetLang: 'zh-CN',
    texts: ['thread and garbage collection', 'plain text'],
    fetchImpl,
  });

  assert.deepEqual(result.translations, ['线程 and 垃圾回收', 'plain text']);
  assert.equal(called, false);
  assert.deepEqual(result.warnings, []);
});

/* ------------------------------ 连接测试 ------------------------------ */

test('testProviderConnection：必应成功返回示例译文', async () => {
  const fetchImpl = async (url) => (
    String(url) === 'https://cn.bing.com/translator' ? bingPageResponse() : bingTranslateResponse('线程')
  );
  const result = await testProviderConnection({ providerId: 'bing-free', config: {}, targetLang: 'zh-CN', fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.sample, '线程');
  assert.ok(result.message.indexOf('连接成功') !== -1);
});

test('testProviderConnection：LLM 分支可从 JSON / 代码围栏中提取示例译文', async () => {
  const makeFetch = (content) => async () => jsonResponse({ choices: [{ message: { content } }] });
  const config = { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' };

  const plain = await testProviderConnection({ providerId: 'deepseek', config, targetLang: 'zh-CN', fetchImpl: makeFetch('{"translations":["线程"]}') });
  assert.equal(plain.ok, true);
  assert.equal(plain.sample, '线程');

  const fence = String.fromCharCode(96, 96, 96);
  const fenced = await testProviderConnection({
    providerId: 'deepseek',
    config,
    targetLang: 'zh-CN',
    fetchImpl: makeFetch(fence + 'json\n' + '{"translations":["线程（轻量级执行单元）"]}' + '\n' + fence),
  });
  assert.equal(fenced.ok, true);
  assert.equal(fenced.sample, '线程（轻量级执行单元）');
});

test('testProviderConnection：配置缺失 / 网络错误 / 未知服务商均返回 ok:false 而不抛错', async () => {
  const missing = await testProviderConnection({
    providerId: 'azure',
    config: { apiKey: '', region: '' },
    targetLang: 'zh-CN',
    fetchImpl: async () => {
      throw new Error('不应联网');
    },
  });
  assert.equal(missing.ok, false);
  assert.ok(missing.message.indexOf('尚未配置') !== -1);

  const network = await testProviderConnection({
    providerId: 'mymemory',
    config: {},
    targetLang: 'zh-CN',
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
  });
  assert.equal(network.ok, false);
  assert.ok(network.message.length > 0);

  const unknown = await testProviderConnection({ providerId: 'nope', config: {}, targetLang: 'zh-CN' });
  assert.equal(unknown.ok, false);
});

/* ------------------------------ 其他边界 ------------------------------ */

test('fetch 在调用时解析：未注入 fetchImpl 时使用 globalThis.fetch', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ responseData: { translatedText: '线程' }, responseStatus: 200 });
  try {
    const result = await translateWithProvider({ providerId: 'mymemory', config: {}, targetLang: 'zh-CN', texts: ['thread'] });
    assert.deepEqual(result.translations, ['线程']);
  } finally {
    globalThis.fetch = original;
  }
});

test('空 texts / 纯空白文本不发起网络请求且保留原文', async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return jsonResponse({});
  };
  const result = await translateWithProvider({
    providerId: 'mymemory',
    config: {},
    targetLang: 'zh-CN',
    texts: ['', '   '],
    fetchImpl,
  });
  assert.deepEqual(result.translations, ['', '   ']);
  assert.equal(called, false);

  const empty = await translateWithProvider({ providerId: 'mymemory', config: {}, targetLang: 'zh-CN', texts: [], fetchImpl });
  assert.deepEqual(empty.translations, []);
  assert.equal(called, false);
});
