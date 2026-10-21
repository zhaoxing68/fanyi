/**
 * translator.js 单元测试：大模型提示词/解析容错、机器翻译术语保护、离线词典、错误归一。
 * 全部通过 mock fetch 完成，绝不发起真实网络请求。
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { translateText, translateBatch, testProvider } from '../src/lib/translator.js';
import { TranslatorError, resetBingCache, setBingThrottleForTests } from '../src/lib/providers.js';

const BING_HTML = [
  '<!doctype html><html><head><script>',
  'var params_AbusePreventionHelper = [1700000000000,"bing-token-abc",3600000];',
  'var IG:"0123456789abcdef0123456789abcdef";',
  '</script></head><body>translator</body></html>',
].join('');

const GLOSSARY_ENTRIES = [
  { en: 'thread', zh: '线程', category: '操作系统', pos: 'noun', note: '', aliases: [], noEnforce: false, source: 'builtin' },
  { en: 'process', zh: '进程', category: '操作系统', pos: 'noun', note: '', aliases: [], noEnforce: false, source: 'builtin' },
  { en: 'garbage collection', zh: '垃圾回收', category: '编程语言', pos: 'noun', note: '', aliases: [], noEnforce: false, source: 'builtin' },
  { en: 'garbage', zh: '垃圾', category: '通用IT', pos: 'noun', note: '', aliases: [], noEnforce: false, source: 'builtin' },
];

function makeSettings(providerId, providerConfig, overrides) {
  return Object.assign({
    provider: providerId,
    targetLang: 'zh-CN',
    enforceTerms: true,
    glossaryLimit: 80,
    freeFallback: true,
    providers: { [providerId]: providerConfig || {} },
  }, overrides || {});
}

function deepseekSettings(overrides) {
  return makeSettings('deepseek', Object.assign({
    apiKey: 'sk-test',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
  }, overrides || {}));
}

function chatResponse(content) {
  return {
    ok: true,
    status: 200,
    url: '',
    text: async () => JSON.stringify({ choices: [{ message: { content } }] }),
  };
}

function bingPage() {
  return { ok: true, status: 200, url: 'https://cn.bing.com/translator', text: async () => BING_HTML };
}

function bingTranslation(text) {
  return {
    ok: true,
    status: 200,
    url: 'https://cn.bing.com/translations',
    text: async () => JSON.stringify([{ translations: [{ text, to: 'zh-Hans' }], detectedLanguage: { language: 'en' } }]),
  };
}

function myMemoryTranslation(text) {
  return {
    ok: true,
    status: 200,
    url: '',
    text: async () => JSON.stringify({ responseData: { translatedText: text }, responseStatus: 200 }),
  };
}

beforeEach(() => {
  resetBingCache();
  // 单测里把必应节流间隔调到 0，避免真实等待
  setBingThrottleForTests({ minGapMs: 0, maxGapMs: 0, authRetryDelayMs: 0 });
});

/* ------------------------------ 大模型 ------------------------------ */

test('DeepSeek：提示词包含术语表与 JSON 要求，返回解析后的译文', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return chatResponse('{"translations":["线程是一种轻量级进程。"]}');
  };

  const result = await translateText('A thread is a lightweight process.', {
    settings: deepseekSettings(),
    glossary: GLOSSARY_ENTRIES,
    fetchImpl,
  });

  assert.equal(result.translation, '线程是一种轻量级进程。');
  assert.equal(result.provider, 'deepseek');
  assert.deepEqual(result.warnings, []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(calls[0].headers.Authorization, 'Bearer sk-test');

  const body = calls[0].body;
  assert.equal(body.temperature, 0.2);
  assert.equal(body.stream, false);
  const system = body.messages[0].content;
  assert.ok(system.indexOf('计算机') !== -1);
  assert.ok(system.indexOf('thread => 线程') !== -1);
  assert.ok(system.indexOf('process => 进程') !== -1);
  assert.ok(system.indexOf('garbage') === -1, '未命中的术语不应出现在提示词中');
  assert.ok(system.indexOf('JSON') !== -1);
  assert.ok(system.indexOf('⟦T0⟧') !== -1);
  assert.deepEqual(JSON.parse(body.messages[1].content), { texts: ['A thread is a lightweight process.'] });
});

test('DeepSeek：容忍 JSON 代码围栏与前后缀说明文字', async () => {
  const fence = String.fromCharCode(96, 96, 96);
  const fencedContent = fence + 'json\n{"translations":["线程"]}\n' + fence;
  const first = await translateText('thread', {
    settings: deepseekSettings(),
    glossary: GLOSSARY_ENTRIES,
    fetchImpl: async () => chatResponse(fencedContent),
  });
  assert.equal(first.translation, '线程');

  const second = await translateText('thread', {
    settings: deepseekSettings(),
    glossary: GLOSSARY_ENTRIES,
    fetchImpl: async () => chatResponse('好的，结果如下：{"translations":["线程"]} 请查收。'),
  });
  assert.equal(second.translation, '线程');
});

test('DeepSeek：批量 JSON 数量不符时降级为逐条纯文本请求', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (calls.length === 1) return chatResponse('{"translations":["只有一条"]}');
    return chatResponse('逐条译文' + calls.length);
  };

  const result = await translateBatch(['thread', 'process'], {
    settings: deepseekSettings(),
    glossary: GLOSSARY_ENTRIES,
    fetchImpl,
  });

  assert.deepEqual(result.translations, ['逐条译文2', '逐条译文3']);
  assert.equal(calls.length, 3);
  assert.equal(calls[1].messages[1].content, 'thread');
  assert.equal(calls[2].messages[1].content, 'process');
  assert.ok(calls[1].messages[0].content.indexOf('纯文本') !== -1);
  assert.ok(result.warnings.some((warning) => warning.indexOf('逐条翻译') !== -1));
});

test('DeepSeek：批量输出不是合法 JSON 时降级逐条并清理纯文本输出', async () => {
  let callCount = 0;
  const fetchImpl = async () => {
    callCount += 1;
    return chatResponse(callCount === 1 ? '抱歉，我无法按格式输出。' : '线程');
  };

  const result = await translateText('thread', {
    settings: deepseekSettings(),
    glossary: GLOSSARY_ENTRIES,
    fetchImpl,
  });

  assert.equal(result.translation, '线程');
  assert.equal(callCount, 2);
});

test('DeepSeek：未配置 API Key 抛 PROVIDER_NOT_CONFIGURED 并提示去设置', async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return chatResponse('不应被调用');
  };
  await assert.rejects(
    translateText('thread', {
      settings: deepseekSettings({ apiKey: '' }),
      glossary: GLOSSARY_ENTRIES,
      fetchImpl,
    }),
    (error) => error instanceof TranslatorError
      && error.code === 'PROVIDER_NOT_CONFIGURED'
      && error.message.indexOf('设置') !== -1,
  );
  assert.equal(called, false);
});

test('DeepSeek：降级逐条请求后服务端仍失败时抛 TranslatorError', async () => {
  let callCount = 0;
  const fetchImpl = async () => {
    callCount += 1;
    if (callCount === 1) return chatResponse('{"translations":["只有一条"]}');
    return { ok: false, status: 500, url: '', text: async () => JSON.stringify({ error: { message: 'server down' } }) };
  };
  await assert.rejects(
    translateBatch(['thread', 'process'], { settings: deepseekSettings(), glossary: GLOSSARY_ENTRIES, fetchImpl }),
    (error) => error instanceof TranslatorError && error.code === 'UPSTREAM_ERROR',
  );
  assert.equal(callCount, 2);
});

/* --------------------------- 机器翻译 + 术语保护 --------------------------- */

test('必应 + 术语保护：请求里是占位符，返回后还原成术语表译名', async () => {
  const posts = [];
  const fetchImpl = async (url, init) => {
    if (String(url) === 'https://cn.bing.com/translator') return bingPage();
    posts.push(new URLSearchParams(init.body));
    return bingTranslation('一个⟦T0⟧ 是安全的');
  };

  const result = await translateText('A thread is safe.', {
    settings: makeSettings('bing-free', {}),
    glossary: GLOSSARY_ENTRIES,
    fetchImpl,
  });

  assert.equal(result.translation, '一个线程是安全的'); // 还原后中文之间的空格被清理
  assert.equal(result.provider, 'bing-free');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].get('text'), 'A ⟦T0⟧ is safe.');
  assert.deepEqual(result.warnings, []);
});

test('必应 + 术语保护：MT 已译出术语时不再插入叠词', async () => {
  const fetchImpl = async (url) => {
    if (String(url) === 'https://cn.bing.com/translator') return bingPage();
    return bingTranslation('线程池重用工作线程⟦T0⟧以减少上下文切换开销。');
  };

  const result = await translateText('Thread pool reuses worker threads to reduce context switching overhead.', {
    settings: makeSettings('bing-free', {}),
    glossary: GLOSSARY_ENTRIES,
    fetchImpl,
  });

  assert.equal(result.translation, '线程池重用工作线程以减少上下文切换开销。');
  assert.equal(result.translation.indexOf('线程线程'), -1);
  assert.deepEqual(result.warnings, []);
});

test('机器翻译：目标语言不是简体中文时不启用占位符保护', async () => {
  const postedTexts = [];
  const fetchImpl = async (url, init) => {
    if (String(url) === 'https://cn.bing.com/translator') return bingPage();
    postedTexts.push(new URLSearchParams(init.body).get('text'));
    return bingTranslation('原文');
  };

  for (const targetLang of ['zh-TW', 'en', 'ja']) {
    const result = await translateText('A thread is safe.', {
      settings: makeSettings('bing-free', {}, { targetLang }),
      glossary: GLOSSARY_ENTRIES,
      fetchImpl,
    });
    assert.equal(result.translation, '原文');
  }
  assert.deepEqual(postedTexts, ['A thread is safe.', 'A thread is safe.', 'A thread is safe.']);
});

test('必应 + 术语保护：占位符丢失时重试一次，仍失败则按普通翻译处理', async () => {
  const postedTexts = [];
  const fetchImpl = async (url, init) => {
    if (String(url) === 'https://cn.bing.com/translator') return bingPage();
    postedTexts.push(new URLSearchParams(init.body).get('text'));
    if (postedTexts.length <= 2) return bingTranslation('一个线程是安全的'); // 占位符被吞掉
    return bingTranslation('普通翻译结果');
  };

  const result = await translateText('A thread is safe.', {
    settings: makeSettings('bing-free', {}),
    glossary: GLOSSARY_ENTRIES,
    fetchImpl,
  });

  assert.equal(postedTexts.length, 3);
  assert.equal(postedTexts[0], 'A ⟦T0⟧ is safe.');
  assert.equal(postedTexts[1], 'A ⟦T0⟧ is safe.');
  assert.equal(postedTexts[2], 'A thread is safe.');
  assert.equal(result.translation, '普通翻译结果');
  assert.ok(result.warnings.indexOf('部分术语保护失效，已按普通翻译处理') !== -1);
});

test('必应不可用：自动回退 MyMemory 翻译未保护原文并给出 warning', async () => {
  let mymemoryQuery = '';
  const fetchImpl = async (url) => {
    const target = String(url);
    if (target.indexOf('bing.com') !== -1) throw new TypeError('fetch failed');
    if (target.indexOf('mymemory') !== -1) {
      mymemoryQuery = new URL(target).searchParams.get('q');
      return myMemoryTranslation('一个线程是安全的');
    }
    throw new Error('未预期的请求地址：' + target);
  };

  const result = await translateText('A thread is safe.', {
    settings: makeSettings('bing-free', {}),
    glossary: GLOSSARY_ENTRIES,
    fetchImpl,
  });

  assert.equal(mymemoryQuery, 'A thread is safe.');
  assert.equal(result.translation, '一个线程是安全的');
  assert.ok(result.warnings.some((warning) => warning.indexOf('未启用术语保护') !== -1));
});

/* ------------------------------ 离线词典 ------------------------------ */

test('glossary：离线词典模式仅替换命中的术语并给出 warning', async () => {
  const result = await translateBatch(['thread and garbage collection', 'plain text'], {
    settings: makeSettings('glossary', {}),
    glossary: GLOSSARY_ENTRIES,
    fetchImpl: () => {
      throw new Error('离线模式不应联网');
    },
  });

  assert.deepEqual(result.translations, ['线程 and 垃圾回收', 'plain text']);
  assert.equal(result.provider, 'glossary');
  assert.ok(result.warnings.some((warning) => warning.indexOf('离线词典模式') !== -1));
});

/* ------------------------------ 批量与边界 ------------------------------ */

test('translateBatch：空文本与纯空白保留原文，结果顺序与输入一致', async () => {
  const result = await translateBatch(['', 'thread', '  ', 'garbage'], {
    settings: makeSettings('glossary', {}),
    glossary: GLOSSARY_ENTRIES,
  });
  assert.deepEqual(result.translations, ['', '线程', '  ', '垃圾']);

  const single = await translateText('   ', {
    settings: makeSettings('glossary', {}),
    glossary: GLOSSARY_ENTRIES,
  });
  assert.equal(single.translation, '   ');
  assert.deepEqual(single.warnings, []);
});

test('translateBatch：超过 80 条自动分片且顺序保持一致', async () => {
  const texts = Array.from({ length: 90 }, (unused, index) => (index % 2 === 0 ? 'thread' : 'garbage'));
  const result = await translateBatch(texts, {
    settings: makeSettings('glossary', {}),
    glossary: GLOSSARY_ENTRIES,
  });
  assert.equal(result.translations.length, 90);
  for (let index = 0; index < texts.length; index += 1) {
    assert.equal(result.translations[index], index % 2 === 0 ? '线程' : '垃圾');
  }
});

test('translateBatch：空数组直接返回空结果', async () => {
  const result = await translateBatch([], {
    settings: makeSettings('glossary', {}),
    glossary: GLOSSARY_ENTRIES,
  });
  assert.deepEqual(result.translations, []);
  assert.deepEqual(result.warnings, []);
});

test('中文空格清理：相邻多组全部折叠，英文-中文空格与换行保留', async () => {
  const settings = makeSettings('glossary', {});
  const cases = [
    ['限流和 反向代理缓存响应', '限流和反向代理缓存响应'],
    ['网关 应用 限流 和 反向代理', '网关应用限流和反向代理'],
    ['API 网关 应用 限流', 'API 网关应用限流'],
    ['网关\u3000应用\u3000限流', '网关应用限流'],
    ['网关  \t 应用', '网关应用'],
    ['第一行\n第二行 中文', '第一行\n第二行中文'],
  ];
  for (const [input, expected] of cases) {
    const result = await translateBatch([input], { settings, glossary: GLOSSARY_ENTRIES });
    assert.equal(result.translations[0], expected, '输入：' + JSON.stringify(input));
  }
});

/* ------------------------------ 连接测试 ------------------------------ */

test('testProvider：未配置的服务商返回 ok:false 而不抛错', async () => {
  const result = await testProvider('deepseek', deepseekSettings({ apiKey: '' }));
  assert.equal(result.ok, false);
  assert.ok(result.message.indexOf('尚未配置') !== -1);
});

test('testProvider：必应连接成功返回示例译文', async () => {
  const fetchImpl = async (url) => (
    String(url) === 'https://cn.bing.com/translator' ? bingPage() : bingTranslation('线程')
  );
  const result = await testProvider('bing-free', makeSettings('bing-free', {}), { fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.sample, '线程');
  assert.ok(result.message.indexOf('连接成功') !== -1);
});

test('testProvider：未知服务商返回 ok:false', async () => {
  const result = await testProvider('unknown-provider', {});
  assert.equal(result.ok, false);
  assert.ok(result.message.length > 0);
});
