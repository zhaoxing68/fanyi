#!/usr/bin/env node
/**
 * 打包脚本：生成可直接上传到 Microsoft Edge 加载项商店的 zip 包。
 *
 * 用法：node scripts/package.mjs
 * 产物：dist/edge-terms-translator-v<version>.zip
 *
 * 设计约束：只使用 Node 内置模块 + 系统自带 zip / unzip 命令，无第三方依赖。
 * 只打包运行扩展必需的文件（manifest.json、src/**、README.md、LICENSE），
 * 排除 tests / scripts / package.json / package-lock.json / dist / .git / .DS_Store 等。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST_DIR = join(ROOT, 'dist');
const INCLUDE_ITEMS = ['manifest.json', 'src', 'docs', 'README.md', 'LICENSE'];
const ROOT_FILES = ['manifest.json', 'README.md', 'LICENSE'];
const EXCLUDE_PATTERNS = ['*.DS_Store', '__MACOSX/*'];
const BANNED_TOP_LEVEL = new Set(['tests', 'scripts', 'node_modules', 'dist', '.git', '.tmp', '.idea', '.vscode', '.github']);

/** 打包失败时输出原因并以非 0 退出 */
function fail(message) {
  console.error('\n[打包失败] ' + message);
  process.exit(1);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

/** 递归列出一个目录下的所有文件（绝对路径） */
function walkFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** 把绝对路径转成 zip 内使用的项目相对路径（统一用 / 分隔） */
function toPosixRelative(filePath) {
  return filePath.slice(ROOT.length + 1).split(sep).join('/');
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
  add(manifest.devtools_page);
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

/** 调用 unzip -Z1 列出 zip 内条目（目录条目以 / 结尾） */
function listZipEntries(zipPath) {
  const raw = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' });
  return raw.split('\n').map((line) => line.trim()).filter(Boolean);
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function main() {
  console.log('[打包] 项目目录：' + ROOT);

  // 1. 环境检查：确保系统有 zip / unzip 命令
  try {
    execFileSync('zip', ['-v'], { stdio: 'pipe' });
    execFileSync('unzip', ['-v'], { stdio: 'pipe' });
  } catch {
    fail('未找到系统 zip / unzip 命令，请先安装（macOS 自带；Linux 可安装 zip 软件包）。');
  }

  // 2. 读取并校验 manifest.json
  const manifestPath = join(ROOT, 'manifest.json');
  if (!existsSync(manifestPath)) fail('缺少 manifest.json');
  let manifest;
  try {
    manifest = readJson(manifestPath);
  } catch (error) {
    fail('manifest.json 不是合法 JSON：' + error.message);
  }
  if (manifest.manifest_version !== 3) fail('manifest_version 必须为 3');
  const version = String(manifest.version || '');
  if (!/^\d+(\.\d+){0,3}$/.test(version)) fail('manifest.version 不合法：' + version);

  // 3. 预检：manifest 引用的运行时文件必须全部存在，避免打出坏包
  const referenced = collectManifestFiles(manifest);
  const missingReferenced = referenced.filter((rel) => !existsSync(join(ROOT, rel)));
  if (missingReferenced.length > 0) {
    fail('manifest.json 引用的文件缺失：\n  - ' + missingReferenced.join('\n  - '));
  }

  // 3.5 README 引用的本地图片必须存在（docs/ 会一并打包，保证发布包中 README 图片不失效）
  const readmePath = join(ROOT, 'README.md');
  if (!existsSync(readmePath)) fail('缺少 README.md');
  const readmeText = readFileSync(readmePath, 'utf8');
  const imageRefs = [...readmeText.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((match) => match[1]);
  const localImageRefs = imageRefs.filter((ref) => !/^[a-z][a-z0-9+.-]*:\/\//i.test(ref));
  const missingImages = localImageRefs.filter((ref) => {
    const cleaned = ref.split('#')[0].split('?')[0];
    return cleaned && !existsSync(join(ROOT, cleaned));
  });
  if (missingImages.length > 0) {
    fail('README.md 引用的本地图片缺失：\n  - ' + missingImages.join('\n  - '));
  }
  const docsDir = join(ROOT, 'docs');
  if (localImageRefs.some((ref) => ref.startsWith('docs/')) && !existsSync(docsDir)) {
    fail('README.md 引用了 docs/ 下的图片，但 docs 目录不存在');
  }

  // 4. 计算预期打包清单（与 zip 结果做交叉校验）
  const expectedFiles = new Set([...ROOT_FILES]);
  for (const file of walkFiles(join(ROOT, 'src'))) expectedFiles.add(toPosixRelative(file));
  if (existsSync(docsDir)) {
    for (const file of walkFiles(docsDir)) expectedFiles.add(toPosixRelative(file));
  }
  const expectedSorted = [...expectedFiles].sort();

  // 5. 清理旧产物并创建 dist 目录
  mkdirSync(DIST_DIR, { recursive: true });
  const zipName = 'edge-terms-translator-v' + version + '.zip';
  const zipPath = join(DIST_DIR, zipName);
  if (existsSync(zipPath)) rmSync(zipPath);

  // 6. 调用系统 zip 打包（cwd 为项目根目录，保证 manifest.json 位于压缩包根目录）
  const zipArgs = ['-r', '-9', '-X', '-D', '-q', zipPath, ...INCLUDE_ITEMS, '-x', ...EXCLUDE_PATTERNS];
  try {
    execFileSync('zip', zipArgs, { cwd: ROOT, stdio: 'pipe' });
  } catch (error) {
    if (existsSync(zipPath)) rmSync(zipPath);
    fail('zip 命令执行失败：' + (error.stderr ? String(error.stderr) : error.message));
  }

  // 7. 校验产物：文件清单、manifest 版本、大小
  const entries = listZipEntries(zipPath).filter((entry) => !entry.endsWith('/'));
  const actual = new Set(entries);
  const missingInZip = expectedSorted.filter((file) => !actual.has(file));
  const unexpectedInZip = entries.filter((file) => !expectedFiles.has(file));
  const bannedInZip = entries.filter((file) => BANNED_TOP_LEVEL.has(file.split('/')[0]));

  const problems = [];
  if (missingInZip.length > 0) problems.push('zip 缺少文件：' + missingInZip.join(', '));
  if (unexpectedInZip.length > 0) problems.push('zip 含多余文件：' + unexpectedInZip.join(', '));
  if (bannedInZip.length > 0) problems.push('zip 含禁止目录：' + bannedInZip.join(', '));
  if (actual.size !== expectedSorted.length) {
    problems.push('文件数不一致：预期 ' + expectedSorted.length + '，实际 ' + actual.size);
  }

  // manifest 版本必须与 manifest.json 一致，格式必须能在压缩包中解析
  let zipManifest;
  try {
    zipManifest = JSON.parse(execFileSync('unzip', ['-p', zipPath, 'manifest.json'], { encoding: 'utf8' }));
  } catch (error) {
    problems.push('压缩包内 manifest.json 无法解析：' + error.message);
  }
  if (zipManifest) {
    if (zipManifest.version !== version) {
      problems.push('压缩包内版本 ' + zipManifest.version + ' 与源文件版本 ' + version + ' 不一致');
    }
    if (zipManifest.manifest_version !== 3) problems.push('压缩包内 manifest_version 不是 3');
    if (!actual.has('README.md')) problems.push('压缩包缺少 README.md');
    if (!actual.has('LICENSE')) problems.push('压缩包缺少 LICENSE');
  }

  if (problems.length > 0) {
    if (existsSync(zipPath)) rmSync(zipPath);
    fail(problems.join('\n'));
  }

  const size = statSync(zipPath).size;
  console.log('');
  console.log('========== 打包摘要 ==========');
  console.log('产物路径：' + zipPath);
  console.log('扩展版本：v' + version);
  console.log('文件数量：' + actual.size + ' 个');
  console.log('压缩包大小：' + formatSize(size) + '（' + size + ' 字节）');
  console.log('包含内容：' + INCLUDE_ITEMS.join('、'));
  const docsCount = [...actual].filter((file) => file.startsWith('docs/')).length;
  console.log('界面截图：' + docsCount + ' 张（docs/，供 README 界面预览引用）');
  console.log('排除内容：tests/、scripts/、package.json、package-lock.json、dist/、.git/、.DS_Store');
  console.log('校验结果：文件清单完整、manifest 版本一致、无多余文件');
  console.log('==============================');
  console.log('[打包成功] 可前往 https://partner.microsoft.com/dashboard/microsoftedge 上传该 zip。');
}

try {
  main();
} catch (error) {
  fail(error && error.stack ? error.stack : String(error));
}
