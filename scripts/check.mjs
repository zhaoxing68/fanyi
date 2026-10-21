#!/usr/bin/env node
/**
 * 静态校验脚本：在提交 / 打包前检查扩展工程是否满足 MV3 规范与项目约定。
 *
 * 用法：node scripts/check.mjs
 * 任一检查项失败则 exit 1，并打印失败原因；全部通过打印统计摘要。
 *
 * 检查范围：
 *   1. manifest.json 可解析、Manifest V3、基础字段与权限声明完整
 *   2. manifest 引用的全部运行时文件存在
 *   3. 图标为合法 PNG，且 IHDR 宽高与文件名尺寸一致
 *   4. 所有 .js 语法正确（node --check），content.js 必须是经典脚本（无 import/export）
 *   5. HTML 无内联 script / 内联事件属性，HTML 与 CSS 引用的本地资源存在、无远程资源
 *   6. src 下无 TODO / FIXME / 尚未实现等占位
 *   7. content.js 逐字覆盖内容侧消息，content / popup / options 合起来覆盖全部 MSG 值
 *   8. 版本号一致、commands 声明合法、必需文档存在
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.tmp']);
const results = [];

/** 注册并执行一个检查项；抛错视为失败 */
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ ok: true, name, detail: detail || '' });
  } catch (error) {
    results.push({ ok: false, name, message: (error && error.message) || String(error) });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** 递归列出目录下所有文件（跳过构建产物与依赖目录） */
function walkFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** 绝对路径 -> 项目相对路径（/ 分隔） */
function toRel(filePath) {
  return filePath.slice(ROOT.length + 1).split(sep).join('/');
}

function readText(filePath) {
  return readFileSync(filePath, 'utf8');
}

/** 从 manifest.json 收集扩展运行时引用的所有文件 */
function collectManifestFiles(manifest) {
  const files = new Set();
  const add = (value) => {
    if (typeof value === 'string' && value.trim()) files.add(value.trim());
  };
  const addIconSet = (iconSet) => {
    if (typeof iconSet === 'string') add(iconSet);
    else if (iconSet && typeof iconSet === 'object') Object.values(iconSet).forEach(add);
  };
  addIconSet(manifest.icons);
  if (manifest.action) {
    add(manifest.action.default_popup);
    addIconSet(manifest.action.default_icon);
  }
  add(manifest.options_page);
  add(manifest.options_ui && manifest.options_ui.page);
  add(manifest.background && manifest.background.service_worker);
  if (Array.isArray(manifest.content_scripts)) {
    for (const script of manifest.content_scripts) {
      (script.js || []).forEach(add);
      (script.css || []).forEach(add);
    }
  }
  if (Array.isArray(manifest.web_accessible_resources)) {
    for (const group of manifest.web_accessible_resources) {
      (group.resources || []).forEach((pattern) => {
        if (!/[*?]/.test(pattern)) add(pattern);
      });
    }
  }
  return [...files];
}

/** 读取 PNG 的 IHDR 宽高，并校验文件结构 */
function readPngInfo(absPath) {
  const buffer = readFileSync(absPath);
  assert(buffer.length >= 33, '文件过小，不是完整 PNG');
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let index = 0; index < signature.length; index += 1) {
    assert(buffer[index] === signature[index], 'PNG 文件头签名不正确');
  }
  const chunkLength = buffer.readUInt32BE(8);
  const chunkType = buffer.toString('ascii', 12, 16);
  assert(chunkLength === 13 && chunkType === 'IHDR', '首个 chunk 必须为 13 字节的 IHDR');
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const bitDepth = buffer[24];
  const colorType = buffer[25];
  assert([1, 2, 4, 8, 16].includes(bitDepth), 'PNG 位深非法：' + bitDepth);
  assert([0, 2, 3, 4, 6].includes(colorType), 'PNG 颜色类型非法：' + colorType);
  assert(buffer.toString('latin1').includes('IEND'), 'PNG 缺少 IEND 结束块');
  return { width, height };
}

function collectLocalRefs(htmlText) {
  const refs = [];
  const tagPattern = /<(script|link|img)\b[^>]*?\b(src|href)\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = tagPattern.exec(htmlText)) !== null) {
    refs.push({ tag: match[1].toLowerCase(), attribute: match[2].toLowerCase(), value: match[3].trim() });
  }
  return refs;
}

function isRemoteUrl(value) {
  return /^(?:https?:)?\/\//i.test(value);
}

const INLINE_EVENT_PATTERN = /\s(on(?:click|dblclick|load|error|change|input|submit|reset|mouseover|mouseout|mousedown|mouseup|mousemove|focus|blur|keydown|keyup|keypress|contextmenu|scroll|wheel|drag|dragstart|dragend|drop|animationend|transitionend|touchstart|touchend))\s*=/gi;

/** ============================ 主流程 ============================ */
async function main() {
  console.log('[静态校验] 项目目录：' + ROOT);
  console.log('');

  // 预先加载 constants.js（纯模块，无副作用），供消息协议一致性检查使用
  const constantsPath = join(ROOT, 'src/lib/constants.js');
  let constants = null;
  if (existsSync(constantsPath)) {
    try {
      constants = await import(pathToFileURL(constantsPath).href);
    } catch (error) {
      constants = null;
    }
  }

  // ---------- 1. manifest.json ----------
  const manifestPath = join(ROOT, 'manifest.json');
  let manifest = null;

  check('manifest.json 存在且为合法 JSON', () => {
    assert(existsSync(manifestPath), '缺少 manifest.json');
    try {
      manifest = JSON.parse(readText(manifestPath));
    } catch (error) {
      throw new Error('JSON 解析失败：' + error.message);
    }
    assert(manifest && typeof manifest === 'object', 'manifest.json 必须是对象');
    return '版本 ' + manifest.version;
  });

  check('Manifest V3 与基础字段齐全', () => {
    assert(manifest, 'manifest.json 不可用');
    assert(manifest.manifest_version === 3, 'manifest_version 必须为 3');
    for (const field of ['name', 'version', 'description', 'icons', 'action', 'background', 'permissions', 'content_scripts']) {
      assert(manifest[field] !== undefined && manifest[field] !== null, '缺少必需字段：' + field);
    }
    assert(/^\d+(\.\d+){0,3}$/.test(String(manifest.version)), 'version 格式不合法：' + manifest.version);
    assert(String(manifest.name).trim().length > 0, 'name 不能为空');
    assert(String(manifest.name).length <= 45, 'name 超过 Edge 商店 45 字符限制');
    assert(String(manifest.description || '').length > 0, 'description 不能为空');
    assert(String(manifest.description || '').length <= 132, 'description 超过 Edge 商店 132 字符限制');
    assert(manifest.background && manifest.background.service_worker, 'background.service_worker 缺失');
    assert(manifest.action && manifest.action.default_popup, 'action.default_popup 缺失');
    assert(typeof manifest.options_page === 'string' && manifest.options_page.length > 0, 'options_page 缺失');
    return 'name=' + manifest.name + '，version=' + manifest.version;
  });

  check('权限、host_permissions 与 content_scripts 声明合法', () => {
    assert(manifest, 'manifest.json 不可用');
    assert(Array.isArray(manifest.permissions), 'permissions 必须是数组');
    for (const permission of ['storage', 'contextMenus', 'activeTab', 'scripting']) {
      assert(manifest.permissions.includes(permission), 'permissions 缺少：' + permission);
    }
    assert(Array.isArray(manifest.host_permissions) && manifest.host_permissions.length > 0, 'host_permissions 不能为空');
    assert(manifest.host_permissions.some((item) => String(item).startsWith('http')), 'host_permissions 需覆盖 http(s) 页面');
    assert(Array.isArray(manifest.content_scripts) && manifest.content_scripts.length > 0, 'content_scripts 不能为空');
    for (const script of manifest.content_scripts) {
      assert(Array.isArray(script.matches) && script.matches.length > 0, 'content_scripts.matches 不能为空');
      assert(Array.isArray(script.js) && script.js.length > 0, 'content_scripts.js 不能为空');
      assert(Array.isArray(script.css) && script.css.length > 0, 'content_scripts.css 不能为空');
      assert(script.matches.some((item) => String(item).startsWith('http')), 'content_scripts.matches 需覆盖 http(s) 页面');
    }
    return manifest.permissions.length + ' 项权限，' + manifest.host_permissions.length + ' 项宿主权限';
  });

  check('commands 快捷键声明合法', () => {
    assert(manifest, 'manifest.json 不可用');
    assert(manifest.commands && typeof manifest.commands === 'object', '缺少 commands 声明');
    const commandKeys = Object.keys(manifest.commands);
    assert(commandKeys.length >= 1, 'commands 至少需要 1 个命令');
    const shortcutPattern = /^(?:(?:Ctrl|Alt|Shift|Command|MacCtrl)\+)+(?:[A-Z]|[0-9]|F(?:[1-9]|1[0-2])|Comma|Period|Home|End|PageUp|PageDown|Space|Insert|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight)$/;
    for (const key of commandKeys) {
      assert(/^[a-z][a-z0-9-]*$/.test(key), 'command 名称不合法：' + key);
      const command = manifest.commands[key];
      assert(command && typeof command.description === 'string' && command.description.trim().length > 0, 'command ' + key + ' 缺少 description');
      const suggested = command.suggested_key;
      if (suggested) {
        for (const platform of Object.keys(suggested)) {
          assert(shortcutPattern.test(String(suggested[platform])), 'command ' + key + ' 快捷键不合法：' + suggested[platform]);
        }
      }
    }
    return commandKeys.join('、');
  });

  // ---------- 2. manifest 引用文件 ----------
  check('manifest 引用的运行时文件全部存在', () => {
    assert(manifest, 'manifest.json 不可用');
    const referenced = collectManifestFiles(manifest);
    assert(referenced.length > 0, 'manifest 未引用任何运行时文件');
    const missing = referenced.filter((rel) => !existsSync(join(ROOT, rel)));
    assert(missing.length === 0, '缺失文件：\n  - ' + missing.join('\n  - '));
    return referenced.length + ' 个引用文件';
  });

  // ---------- 3. 图标 PNG ----------
  check('图标为合法 PNG 且尺寸与文件名一致', () => {
    assert(manifest, 'manifest.json 不可用');
    const iconPaths = new Set();
    const collectIcons = (iconSet) => {
      if (typeof iconSet === 'string') iconPaths.add(iconSet);
      else if (iconSet && typeof iconSet === 'object') Object.values(iconSet).forEach((value) => iconPaths.add(value));
    };
    collectIcons(manifest.icons);
    if (manifest.action) collectIcons(manifest.action.default_icon);
    assert(iconPaths.size > 0, 'manifest 未声明任何图标');
    const checked = [];
    for (const rel of iconPaths) {
      const absPath = join(ROOT, rel);
      assert(existsSync(absPath), '图标文件不存在：' + rel);
      const match = /(\d+)\.png$/i.exec(rel);
      assert(match, '图标文件名需包含尺寸数字：' + rel);
      const expectedSize = Number(match[1]);
      const info = readPngInfo(absPath);
      assert(info.width === expectedSize && info.height === expectedSize, rel + ' 实际尺寸 ' + info.width + 'x' + info.height + '，与文件名 ' + expectedSize + ' 不一致');
      checked.push(expectedSize + 'px');
    }
    return checked.join(' / ');
  });

  // ---------- 4. JS 语法与 content script 形态 ----------
  const jsFiles = walkFiles(ROOT).filter((file) => ['.js', '.mjs'].includes(extname(file)));

  check('所有 .js / .mjs 通过 node --check 语法检查', () => {
    assert(jsFiles.length > 0, '未找到任何 .js 文件');
    const failures = [];
    for (const file of jsFiles) {
      try {
        execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
      } catch (error) {
        const stderr = error && error.stderr ? String(error.stderr).trim() : String(error.message || error);
        failures.push(toRel(file) + '\n    ' + stderr.split('\n').filter(Boolean).slice(0, 3).join('\n    '));
      }
    }
    assert(failures.length === 0, '语法错误：\n  - ' + failures.join('\n  - '));
    return jsFiles.length + ' 个文件';
  });

  check('content.js 为经典脚本（不含 import/export）', () => {
    const contentPath = join(ROOT, 'src/content/content.js');
    assert(existsSync(contentPath), '缺少 src/content/content.js');
    const text = readText(contentPath);
    const lines = text.split('\n');
    const offenders = [];
    lines.forEach((line, index) => {
      if (/^\s*(?:import|export)\b/.test(line) || /\bimport\s*\(/.test(line)) {
        offenders.push('第 ' + (index + 1) + ' 行：' + line.trim().slice(0, 80));
      }
    });
    assert(offenders.length === 0, 'content script 必须为经典脚本，发现模块语法：\n  - ' + offenders.join('\n  - '));
    return '经典脚本，' + lines.length + ' 行';
  });

  // ---------- 5. HTML / CSS ----------
  const htmlFiles = walkFiles(ROOT).filter((file) => extname(file) === '.html');

  check('HTML 无内联 script 与内联事件属性', () => {
    assert(htmlFiles.length >= 2, '扩展页面 HTML 数量不足（popup / options）');
    const issues = [];
    for (const file of htmlFiles) {
      const text = readText(file);
      const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
      let match;
      while ((match = scriptPattern.exec(text)) !== null) {
        if (!/\bsrc\s*=/.test(match[1])) {
          issues.push(toRel(file) + ' 存在内联 <script>（MV3 CSP 禁止）');
        }
      }
      const eventPattern = new RegExp(INLINE_EVENT_PATTERN.source, 'gi');
      while ((match = eventPattern.exec(text)) !== null) {
        issues.push(toRel(file) + ' 存在内联事件属性：' + match[1]);
      }
      if (/(?:href|src|action)\s*=\s*["']\s*javascript:/i.test(text)) {
        issues.push(toRel(file) + ' 存在 javascript: 协议链接');
      }
    }
    assert(issues.length === 0, issues.join('\n  - '));
    return htmlFiles.length + ' 个页面';
  });

  check('HTML / CSS 本地资源存在且无远程资源', () => {
    const issues = [];
    const localFiles = new Set();

    for (const file of htmlFiles) {
      const htmlDir = dirname(file);
      for (const ref of collectLocalRefs(readText(file))) {
        const value = ref.value;
        if (isRemoteUrl(value)) {
          issues.push(toRel(file) + ' 引用了远程资源（禁止使用 CDN / 远程字体）：' + value);
          continue;
        }
        if (/^(?:data:|#|mailto:|chrome-extension:|about:)/i.test(value)) continue;
        const cleaned = value.split('#')[0].split('?')[0];
        if (!cleaned) continue;
        const absolute = cleaned.startsWith('/') ? join(ROOT, cleaned.slice(1)) : resolve(htmlDir, cleaned);
        if (!existsSync(absolute)) issues.push(toRel(file) + ' 引用的本地资源不存在：' + value);
        else localFiles.add(toRel(absolute));
      }
    }

    const cssFiles = walkFiles(ROOT).filter((file) => extname(file) === '.css');
    for (const file of cssFiles) {
      const text = readText(file);
      if (/@import\s+(?:url\()?\s*["']?\s*(?:https?:)?\/\//i.test(text)) {
        issues.push(toRel(file) + ' 使用了远程 @import');
      }
      const remoteUrlPattern = /url\(\s*["']?\s*(?:https?:)?\/\//gi;
      if (remoteUrlPattern.test(text)) issues.push(toRel(file) + ' 引用了远程 url() 资源');
      const localUrlPattern = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;
      let match;
      while ((match = localUrlPattern.exec(text)) !== null) {
        const value = match[1].trim();
        if (!value || /^(?:data:|#|https?:|\/\/)/i.test(value)) continue;
        const cleaned = value.split('#')[0].split('?')[0];
        const absolute = cleaned.startsWith('/') ? join(ROOT, cleaned.slice(1)) : resolve(dirname(file), cleaned);
        if (!existsSync(absolute)) issues.push(toRel(file) + ' 引用的本地资源不存在：' + value);
        else localFiles.add(toRel(absolute));
      }
    }

    assert(issues.length === 0, issues.join('\n  - '));
    return '校验 ' + htmlFiles.length + ' 个页面、' + cssFiles.length + ' 个样式表';
  });

  // ---------- 6. src 占位检查 ----------
  check('src 下无 TODO / FIXME / 尚未实现等占位', () => {
    const placeholderPattern = /(?:\bTODO\b|\bFIXME\b|尚未实现|待实现|占位实现|coming\s+soon)/i;
    const srcFiles = walkFiles(join(ROOT, 'src')).filter((file) => ['.js', '.css', '.html', '.json'].includes(extname(file)));
    assert(srcFiles.length > 0, 'src 目录为空');
    const issues = [];
    for (const file of srcFiles) {
      readText(file).split('\n').forEach((line, index) => {
        if (placeholderPattern.test(line)) issues.push(toRel(file) + ':' + (index + 1) + ' ' + line.trim().slice(0, 100));
      });
    }
    assert(issues.length === 0, '发现占位内容：\n  - ' + issues.join('\n  - '));
    return srcFiles.length + ' 个文件';
  });

  // ---------- 7. 消息协议一致性 ----------
  check('content.js 与扩展 UI 覆盖 constants.js 中全部 MSG 消息值', () => {
    assert(constants, '缺少或无法加载 src/lib/constants.js');
    const msg = (constants && constants.MSG) || {};
    const messageKeys = Object.keys(msg);
    assert(messageKeys.length > 0, 'constants.js 未导出 MSG');

    const contentPath = join(ROOT, 'src/content/content.js');
    assert(existsSync(contentPath), '缺少 src/content/content.js');
    const contentText = readText(contentPath);

    // content.js 是经典脚本（不能 import），它自己处理的内容侧消息必须逐字出现
    const CONTENT_MSG_KEYS = [
      'PING',
      'GET_SETTINGS',
      'GET_GLOSSARY',
      'TRANSLATE_BATCH',
      'TRANSLATE_SELECTION',
      'OPEN_OPTIONS',
      'PAGE_STATUS',
      'PAGE_TRANSLATE',
      'PAGE_RESTORE',
      'PAGE_SET_MODE',
      'SELECTION_TRANSLATE',
    ];
    const contentMissing = CONTENT_MSG_KEYS.filter((key) => !contentText.includes(msg[key]));
    assert(
      contentMissing.length === 0,
      'content.js 缺少内容侧消息常量：' + contentMissing.map((key) => key + '（' + msg[key] + '）').join('、'),
    );

    // popup / options 是 ES Module，通过 import { MSG } 引用常量；三者合起来覆盖全部消息
    const uiFiles = [{ rel: 'src/content/content.js', module: false, text: contentText }];
    for (const rel of ['src/popup/popup.js', 'src/options/options.js']) {
      const absolute = join(ROOT, rel);
      if (existsSync(absolute)) uiFiles.push({ rel, module: true, text: readText(absolute) });
    }
    const optionsReady = existsSync(join(ROOT, 'src/options/options.js'));
    const missing = [];
    const pending = [];
    for (const key of messageKeys) {
      const value = msg[key];
      const literalHit = uiFiles.some((file) => file.text.includes(value));
      const referenced = uiFiles.some(
        (file) => file.module && new RegExp('\\bMSG\\s*\\.\\s*' + key + '\\b').test(file.text),
      );
      if (literalHit || referenced) continue;
      if (optionsReady) missing.push(key + '（' + value + '）');
      else pending.push(key + '（' + value + '）');
    }
    assert(missing.length === 0, '以下消息常量未出现在 content.js / popup.js / options.js 中：' + missing.join('、'));
    return (
      messageKeys.length + ' 个消息类型（content.js 逐字包含 ' + CONTENT_MSG_KEYS.length + ' 个内容侧消息）' +
      (pending.length > 0 ? '；options.js 未就绪，待复核：' + pending.join('、') : '')
    );
  });

  // ---------- 8. 版本与文档 ----------
  check('package.json 版本与 manifest 一致', () => {
    const packagePath = join(ROOT, 'package.json');
    assert(existsSync(packagePath), '缺少 package.json');
    let packageJson;
    try {
      packageJson = JSON.parse(readText(packagePath));
    } catch (error) {
      throw new Error('package.json 不是合法 JSON：' + error.message);
    }
    assert(manifest, 'manifest.json 不可用');
    assert(packageJson.version === manifest.version, 'package.json 版本 ' + packageJson.version + ' 与 manifest 版本 ' + manifest.version + ' 不一致');
    if (packageJson.type) assert(packageJson.type === 'module', 'package.json type 应为 module');
    return 'v' + packageJson.version;
  });

  check('必需文档文件存在且非空', () => {
    for (const name of ['README.md', 'LICENSE', '.gitignore']) {
      const filePath = join(ROOT, name);
      assert(existsSync(filePath), '缺少 ' + name);
      assert(readText(filePath).trim().length > 0, name + ' 内容为空');
    }
    const readme = readText(join(ROOT, 'README.md'));
    assert(readme.length >= 1500, 'README.md 篇幅过短，需覆盖安装 / 服务商 / 隐私 / 开发等章节');
    assert(readme.includes('License') || readme.includes('许可证'), 'README.md 缺少许可证说明');
    // README 引用的本地图片必须存在（打包时会把 docs/ 一并放进发布包）
    const imageRefs = [...readme.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((match) => match[1]);
    const localImages = imageRefs.filter((ref) => !/^[a-z][a-z0-9+.-]*:\/\//i.test(ref));
    const missingImages = localImages.filter((ref) => {
      const cleaned = ref.split('#')[0].split('?')[0];
      return cleaned && !existsSync(join(ROOT, cleaned));
    });
    assert(missingImages.length === 0, 'README.md 引用的本地图片缺失：' + missingImages.join('、'));
    return 'README.md ' + readme.length + ' 字符，本地配图 ' + localImages.length + ' 张';
  });

  // ---------- 输出结果 ----------
  const passed = results.filter((item) => item.ok).length;
  const failed = results.length - passed;
  console.log('');
  results.forEach((item, index) => {
    const prefix = item.ok ? '\u2713' : '\u2717';
    const number = String(index + 1).padStart(2, '0');
    let line = prefix + ' ' + number + ' ' + item.name;
    if (item.ok && item.detail) line += ' —— ' + item.detail;
    console.log(line);
    if (!item.ok) {
      for (const row of String(item.message).split('\n')) console.log('     ' + row);
    }
  });
  console.log('');
  console.log('----------------------------------------');
  console.log('检查结果：通过 ' + passed + ' / ' + results.length + ' 项，失败 ' + failed + ' 项');
  if (failed > 0) {
    console.log('[校验失败] 请修复上述问题后再打包。');
    process.exitCode = 1;
  } else {
    console.log('[校验通过] 扩展工程满足 MV3 与项目约定，可以打包。');
  }
}

main().catch((error) => {
  console.error('[校验异常] ' + ((error && error.stack) || error));
  process.exitCode = 1;
});
