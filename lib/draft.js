/*
 * 浏览器本地「合并草稿」（浏览器 / Node.js 通用，依赖 lib/choices.js）。
 *
 * 用途：编辑三方输入、选边或填写 Schema 时，把当前工作现场自动存入
 * window.localStorage（仅当前浏览器、当前站点可见，不经过任何服务端）；
 * 刷新或重新打开页面时提示「恢复 / 丢弃」。
 *
 * 草稿内容（DRAFT_VERSION = 1）：
 *   {
 *     "version": 1,
 *     "savedAt": 1700000000000,          // 保存时间（毫秒时间戳）
 *     "inputs": {                        // 输入框中当前编辑的三方文本（可能未合并 / 非法 JSON）
 *       "base":   "...",
 *       "mine":   "...",
 *       "theirs": "..."
 *     },
 *     "schema": "",                      // 可选 Schema 文本（留空为不校验）
 *     "merged": {                        // 最近一次「开始合并」所用的三方文本；从未合并为 null
 *       "base":   "...",
 *       "mine":   "...",
 *       "theirs": "..."
 *     },
 *     "choices": [ ... ]                 // 最近一次合并本轮已选冲突（ChoicesLib 条目格式，仅路径 / 三值 / 选边）
 *   }
 *
 * 恢复规则（页面层据此执行，本库提供判定原语）：
 *  - inputs 与 merged 三份文本逐字一致时，才可重新解析并合并，
 *    并用 planReplay 逐条重放 choices：只有冲突路径仍存在、
 *    且基线 / 我的 / 对方三值与当前冲突完全一致时才重放该选边；
 *  - inputs 与 merged 不一致（输入已改动）或从未合并时，只恢复编辑文本与 Schema，
 *    要求重新点击「开始合并」；旧合并结果与旧校验状态一律不恢复、不放行导出。
 *
 * 存储异常：
 *  - 浏览器拒绝存储（隐私模式 / 站点存储被禁用，SecurityError）
 *    或配额不足（QuotaExceededError）时返回中文原因，调用方提示后仍可正常合并；
 *  - 读取到损坏（JSON 语法错误 / 结构非法）的草稿时返回 corrupt，
 *    并尽量删除损坏项，避免每次打开都重复提示。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./choices.js'));
  } else {
    root.DraftLib = factory(root.ChoicesLib);
  }
})(typeof self !== 'undefined' ? self : globalThis, function (ChoicesLib) {
  'use strict';

  const STORAGE_KEY = 'json-three-way-merge:draft:v1';
  const DRAFT_VERSION = 1;
  const ROOT_KEYS = new Set(['version', 'savedAt', 'inputs', 'schema', 'merged', 'choices']);
  const INPUT_KEYS = new Set(['base', 'mine', 'theirs']);

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function isStorage(storage) {
    return storage !== null
      && typeof storage === 'object'
      && typeof storage.getItem === 'function'
      && typeof storage.setItem === 'function'
      && typeof storage.removeItem === 'function';
  }

  // 自有键集合必须与 keys 完全一致（多键 / 缺键都算格式错误）
  function hasExactKeys(obj, keys) {
    if (!isPlainObject(obj)) return false;
    const actual = Object.keys(obj);
    if (actual.length !== keys.size) return false;
    for (const k of actual) {
      if (!keys.has(k)) return false;
    }
    return true;
  }

  // 把存储异常名翻译为中文说明；合并功能始终不受影响
  function storageErrorReason(err, action) {
    const name = err && err.name ? err.name : (err && err.code) || 'Error';
    if (name === 'QuotaExceededError'
      || name === 'NS_ERROR_DOM_QUOTA_REACHED'
      || (err && err.code) === 22) {
      return `浏览器本地存储空间已满（${name}），草稿${action}失败；可清理浏览器存储后重试。`;
    }
    if (name === 'SecurityError'
      || name === 'AccessDeniedError'
      || name === 'NS_ERROR_DOM_SECURITY_ERR') {
      return `浏览器拒绝访问本地存储（${name}）：可能处于隐私模式，或站点存储权限被禁用，草稿${action}失败。`;
    }
    return `浏览器本地存储不可用（${name}），草稿${action}失败。`;
  }

  /* ---------- 构造与校验 ---------- */

  /**
   * 由当前页面状态构造草稿对象（不在此处做存储）。
   * @param {{inputs?: {base?:string,mine?:string,theirs?:string},
   *          schema?: string,
   *          merged?: null|{base:string,mine:string,theirs:string},
   *          choices?: Array,
   *          savedAt?: number}} opts
   */
  function buildDraft(opts) {
    opts = opts || {};
    const inputs = isPlainObject(opts.inputs) ? opts.inputs : {};
    return {
      version: DRAFT_VERSION,
      savedAt: Number.isFinite(opts.savedAt) ? opts.savedAt : Date.now(),
      inputs: {
        base: typeof inputs.base === 'string' ? inputs.base : '',
        mine: typeof inputs.mine === 'string' ? inputs.mine : '',
        theirs: typeof inputs.theirs === 'string' ? inputs.theirs : '',
      },
      schema: typeof opts.schema === 'string' ? opts.schema : '',
      merged: isPlainObject(opts.merged)
        && typeof opts.merged.base === 'string'
        && typeof opts.merged.mine === 'string'
        && typeof opts.merged.theirs === 'string'
        ? { base: opts.merged.base, mine: opts.merged.mine, theirs: opts.merged.theirs }
        : null,
      choices: Array.isArray(opts.choices) ? opts.choices : [],
    };
  }

  // 空白草稿：三方输入全空、无 Schema、从未合并、无选边（此时不写入存储，
  // 而是删除已有草稿，等价于「清空」）
  function isEmptyDraft(draft) {
    if (!isPlainObject(draft) || !hasExactKeys(draft, ROOT_KEYS)) return true;
    return draft.inputs.base === ''
      && draft.inputs.mine === ''
      && draft.inputs.theirs === ''
      && draft.schema === ''
      && draft.merged === null
      && draft.choices.length === 0;
  }

  /**
   * 严格校验 JSON.parse 后的草稿对象。
   * @returns {{status:'ok', draft: object} | {status:'error', reason: string}}
   */
  function validateDraft(data) {
    const fail = (reason) => ({ status: 'error', reason });

    if (!isPlainObject(data)) return fail('草稿格式错误：顶层必须是 JSON 对象');
    if (!hasExactKeys(data, ROOT_KEYS)) {
      return fail('草稿格式错误：顶层只能含 version、savedAt、inputs、schema、merged、choices 六个键');
    }
    if (data.version !== DRAFT_VERSION) {
      return fail(`草稿格式错误：version 必须为 ${DRAFT_VERSION}（当前：${JSON.stringify(data.version)}）`);
    }
    if (typeof data.savedAt !== 'number' || !Number.isFinite(data.savedAt) || data.savedAt < 0) {
      return fail('草稿格式错误：savedAt 必须为非负数字时间戳');
    }
    if (!hasExactKeys(data.inputs, INPUT_KEYS)) {
      return fail('草稿格式错误：inputs 只能含 base、mine、theirs 三个键');
    }
    for (const k of ['base', 'mine', 'theirs']) {
      if (typeof data.inputs[k] !== 'string') return fail(`草稿格式错误：inputs.${k} 必须是字符串`);
    }
    if (typeof data.schema !== 'string') return fail('草稿格式错误：schema 必须是字符串');
    if (data.merged !== null) {
      if (!hasExactKeys(data.merged, INPUT_KEYS)) {
        return fail('草稿格式错误：merged 只能为 null 或含 base、mine、theirs 三个键的对象');
      }
      for (const k of ['base', 'mine', 'theirs']) {
        if (typeof data.merged[k] !== 'string') return fail(`草稿格式错误：merged.${k} 必须是字符串`);
      }
    }
    if (!Array.isArray(data.choices)) return fail('草稿格式错误：choices 必须是数组');
    if (data.choices.length > 0) {
      // 选边条目复用选择记录的严格校验（结构 / 存在标记 / 重复路径 / 非法选边）
      const checked = ChoicesLib.validateChoicesRecord({
        version: ChoicesLib.VERSION,
        choices: data.choices,
      });
      if (checked.status === 'error') return fail(checked.reason);
    }
    if (isEmptyDraft(data)) return fail('草稿内容为空');
    return { status: 'ok', draft: data };
  }

  /**
   * 解析并严格校验草稿文本。
   * @returns {{status:'ok', draft: object} | {status:'error', reason: string}}
   */
  function parseDraft(text) {
    if (typeof text !== 'string' || text.trim() === '') {
      return { status: 'error', reason: '草稿为空' };
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      return { status: 'error', reason: '草稿 JSON 语法错误：' + (err && err.message ? err.message : String(err)) };
    }
    return validateDraft(data);
  }

  /* ---------- 恢复判定 ---------- */

  /**
   * 当前编辑中的三方文本是否与最近一次合并所用文本逐字一致。
   * 只有一致时才允许直接重新合并并重放选边。
   */
  function snapshotMatches(inputs, merged) {
    if (!isPlainObject(inputs) || !isPlainObject(merged)) return false;
    return inputs.base === merged.base
      && inputs.mine === merged.mine
      && inputs.theirs === merged.theirs;
  }

  /**
   * 规划草稿选边重放：先把草稿中的原始 choices（存在标记）严格解码为条目，
   * 再复用 ChoicesLib.planReuse 的严格匹配（路径存在 + 基线 / 我的 / 对方
   * 三值完全一致；缺失与 null 不混同）。恢复时当前轮没有任何手动选择，
   * 故条目要么可重放、要么跳过。
   * @param {object} draft      validateDraft 通过后的草稿
   * @param {Array} conflicts   重新合并得到的全部冲突
   */
  function planReplay(draft, conflicts) {
    const checked = ChoicesLib.validateChoicesRecord({
      version: ChoicesLib.VERSION,
      choices: isPlainObject(draft) && Array.isArray(draft.choices) ? draft.choices : [],
    });
    // 空 choices 不构成可重放条目；非法草稿本应在 validateDraft 阶段被拒绝
    if (checked.status === 'error') {
      return { reusable: [], skipped: [], error: checked.reason };
    }
    const plan = ChoicesLib.planReuse(checked.entries, conflicts || [], new Map());
    return { reusable: plan.reusable, skipped: plan.skipped, error: null };
  }

  /* ---------- localStorage 读写 ---------- */

  /**
   * 读取草稿。
   * @param {Storage|object|null|undefined} storage  window.localStorage（或测试用内存实现）
   * @returns {{status:'empty'}
   *          |{status:'ok', draft: object}
   *          |{status:'corrupt', reason: string}
   *          |{status:'unavailable', reason: string}}
   */
  function readDraft(storage) {
    if (!isStorage(storage)) {
      return { status: 'unavailable', reason: '浏览器本地存储（localStorage）不可用。' };
    }
    let raw;
    try {
      raw = storage.getItem(STORAGE_KEY);
    } catch (err) {
      return { status: 'unavailable', reason: storageErrorReason(err, '读取') };
    }
    if (raw === null || raw === undefined) return { status: 'empty' };

    const parsed = parseDraft(typeof raw === 'string' ? raw : String(raw));
    if (parsed.status === 'error') {
      // 损坏草稿尽量删除，避免每次打开都重复同一条损坏提示
      try {
        storage.removeItem(STORAGE_KEY);
      } catch {
        // 删除失败不影响返回损坏原因
      }
      return { status: 'corrupt', reason: parsed.reason };
    }
    return { status: 'ok', draft: parsed.draft };
  }

  /**
   * 写入草稿；空白草稿等价于删除。
   * @returns {{status:'ok'} | {status:'unavailable', reason: string} | {status:'error', reason: string}}
   */
  function writeDraft(storage, draft) {
    if (!isStorage(storage)) {
      return { status: 'unavailable', reason: '浏览器本地存储（localStorage）不可用。' };
    }
    if (isEmptyDraft(draft)) return removeDraft(storage);
    let text;
    try {
      text = JSON.stringify(draft);
    } catch (err) {
      return { status: 'error', reason: '草稿无法序列化为 JSON：' + (err && err.message ? err.message : String(err)) };
    }
    try {
      storage.setItem(STORAGE_KEY, text);
    } catch (err) {
      return { status: 'error', reason: storageErrorReason(err, '保存') };
    }
    return { status: 'ok' };
  }

  /**
   * 删除草稿（清空 / 丢弃时调用）。
   * @returns {{status:'ok'} | {status:'unavailable', reason: string} | {status:'error', reason: string}}
   */
  function removeDraft(storage) {
    if (!isStorage(storage)) {
      return { status: 'unavailable', reason: '浏览器本地存储（localStorage）不可用。' };
    }
    try {
      storage.removeItem(STORAGE_KEY);
    } catch (err) {
      return { status: 'error', reason: storageErrorReason(err, '删除') };
    }
    return { status: 'ok' };
  }

  return {
    STORAGE_KEY,
    DRAFT_VERSION,
    buildDraft,
    isEmptyDraft,
    validateDraft,
    parseDraft,
    snapshotMatches,
    planReplay,
    readDraft,
    writeDraft,
    removeDraft,
  };
});
