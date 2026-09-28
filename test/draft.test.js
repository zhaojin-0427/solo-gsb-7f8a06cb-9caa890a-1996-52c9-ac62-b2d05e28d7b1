'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { merge, MISSING } = require('../lib/merge.js');
const {
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
} = require('../lib/draft.js');

// 简单内存版 Storage（getItem / setItem / removeItem），模拟 localStorage
function memStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

function throwingStorage(onSet, onGet, onRemove) {
  return {
    getItem: () => { if (onGet) throw onGet(); return null; },
    setItem: () => { if (onSet) throw onSet(); },
    removeItem: () => { if (onRemove) throw onRemove(); },
  };
}

const TEXTS = {
  base: JSON.stringify({ a: 1 }),
  mine: JSON.stringify({ a: 2 }),
  theirs: JSON.stringify({ a: 3 }),
};

// 与测试数据匹配的已选冲突条目（/a 选我的）
function chosenEntries(choice) {
  const { conflicts } = merge(JSON.parse(TEXTS.base), JSON.parse(TEXTS.mine), JSON.parse(TEXTS.theirs));
  return { conflicts, entries: [{
    path: conflicts[0].path,
    base: { exists: true, value: 1 },
    mine: { exists: true, value: 2 },
    theirs: { exists: true, value: 3 },
    choice: choice || 'mine',
  }] };
}

test('buildDraft：补全默认值（schema 空串 / merged null / choices 空数组 / 时间戳）', () => {
  const d = buildDraft({ inputs: { base: '{}' } });
  assert.equal(d.version, DRAFT_VERSION);
  assert.ok(Number.isFinite(d.savedAt));
  assert.deepEqual(d.inputs, { base: '{}', mine: '', theirs: '' });
  assert.equal(d.schema, '');
  assert.equal(d.merged, null);
  assert.deepEqual(d.choices, []);
});

test('isEmptyDraft：全空为 true；任一输入 / schema / merged / choices 非空为 false', () => {
  assert.equal(isEmptyDraft(buildDraft({})), true);
  assert.equal(isEmptyDraft(buildDraft({ schema: '{}' })), false);
  assert.equal(isEmptyDraft(buildDraft({ merged: TEXTS })), false);
  assert.equal(isEmptyDraft(buildDraft({ inputs: { base: ' ' } })), false);
  assert.equal(isEmptyDraft(buildDraft({ choices: [{}] })), false);
  assert.equal(isEmptyDraft(null), true);
  assert.equal(isEmptyDraft({}), true);
});

test('validateDraft：合法草稿通过（含 merged 快照与已选条目）', () => {
  const { entries } = chosenEntries();
  const d = buildDraft({ inputs: TEXTS, merged: TEXTS, choices: entries });
  const r = validateDraft(d);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.draft, d);
});

test('validateDraft：空草稿被判为内容为空', () => {
  const r = validateDraft(buildDraft({}));
  assert.equal(r.status, 'error');
  assert.match(r.reason, /内容为空/);
});

test('validateDraft：顶层多余 / 缺少键、version 不符一律拒绝', () => {
  const d = buildDraft({ inputs: TEXTS });
  assert.match(validateDraft({ ...d, extra: 1 }).reason, /顶层只能含/);
  const { version, ...withoutVersion } = d;
  assert.match(validateDraft(withoutVersion).reason, /顶层只能含/);
  assert.match(validateDraft({ ...d, version: 2 }).reason, /version 必须为/);
});

test('validateDraft：savedAt 非法、inputs / merged 非字符串键拒绝', () => {
  const d = buildDraft({ inputs: TEXTS });
  assert.equal(validateDraft({ ...d, savedAt: -1 }).status, 'error');
  assert.equal(validateDraft({ ...d, savedAt: '1' }).status, 'error');
  assert.equal(validateDraft({ ...d, inputs: { base: 1, mine: '', theirs: '' } }).status, 'error');
  assert.equal(validateDraft({ ...d, inputs: { foo: 'x' } }).status, 'error');
  assert.equal(validateDraft({ ...d, merged: { base: 1, mine: '', theirs: '' } }).status, 'error');
  assert.equal(validateDraft({ ...d, merged: { foo: 'x' } }).status, 'error');
});

test('validateDraft：choices 复用选择记录严格校验（非法选边 / 缺失标记错误拒绝）', () => {
  const badSide = buildDraft({ inputs: TEXTS, choices: [{
    path: ['a'],
    base: { exists: true, value: 1 },
    mine: { exists: true, value: 2 },
    theirs: { exists: true, value: 3 },
    choice: 'ours',
  }] });
  assert.match(validateDraft(badSide).reason, /choice 只能是/);

  const badMarker = buildDraft({ inputs: TEXTS, choices: [{
    path: ['a'],
    base: { exists: false, value: 1 }, // exists:false 不得带 value
    mine: { exists: true, value: 2 },
    theirs: { exists: true, value: 3 },
    choice: 'mine',
  }] });
  assert.match(validateDraft(badMarker).reason, /不得携带 value/);

  const dup = buildDraft({ inputs: TEXTS, choices: [
    { path: ['a'], base: { exists: true, value: 1 }, mine: { exists: true, value: 2 }, theirs: { exists: true, value: 3 }, choice: 'mine' },
    { path: ['a'], base: { exists: true, value: 1 }, mine: { exists: true, value: 2 }, theirs: { exists: true, value: 3 }, choice: 'theirs' },
  ] });
  assert.match(validateDraft(dup).reason, /重复/);
});

test('parseDraft：空 / JSON 语法错误返回 error', () => {
  assert.equal(parseDraft('').status, 'error');
  assert.match(parseDraft('{bad').reason, /JSON 语法错误/);
});

test('snapshotMatches：三份文本逐字比较；merged 为 null 恒为 false', () => {
  const changed = { ...TEXTS, theirs: TEXTS.theirs + ' ' };
  assert.equal(snapshotMatches(TEXTS, TEXTS), true);
  assert.equal(snapshotMatches(changed, TEXTS), false);
  assert.equal(snapshotMatches(TEXTS, null), false);
});

test('planReplay：快照一致且三值匹配时全部可重放；输入变化导致冲突值变化时跳过', () => {
  const { entries } = chosenEntries();
  const draft = buildDraft({ inputs: TEXTS, merged: TEXTS, choices: entries });
  const fresh = merge(JSON.parse(TEXTS.base), JSON.parse(TEXTS.mine), JSON.parse(TEXTS.theirs));
  const plan = planReplay(draft, fresh.conflicts);
  assert.equal(plan.error, null);
  assert.equal(plan.reusable.length, 1);
  assert.equal(plan.reusable[0].choice, 'mine');
  assert.equal(plan.skipped.length, 0);

  // 对方值改变：三值不再完全一致，只跳过且说明原因，绝不重放
  const changedTheirs = { ...TEXTS, theirs: JSON.stringify({ a: 9 }) };
  const changedMerge = merge(JSON.parse(changedTheirs.base), JSON.parse(changedTheirs.mine), JSON.parse(changedTheirs.theirs));
  const plan2 = planReplay(draft, changedMerge.conflicts);
  assert.equal(plan2.reusable.length, 0);
  assert.equal(plan2.skipped.length, 1);
  assert.match(plan2.skipped[0].reason, /对方版本值已变化|不完全一致/);

  // 冲突已消失：同样只跳过
  const goneMerge = merge(JSON.parse(TEXTS.base), JSON.parse(TEXTS.mine), JSON.parse(TEXTS.mine));
  const plan3 = planReplay(draft, goneMerge.conflicts);
  assert.equal(plan3.reusable.length, 0);
  assert.equal(plan3.skipped.length, 1);
  assert.match(plan3.skipped[0].reason, /不存在该路径的冲突|已消失/);
});

test('planReplay：缺失（exists:false）与 null 严格区分，不匹配时跳过', () => {
  // /o：对方删除（MISSING），我的改为对象
  const base = { a: 1, o: { x: 1 } };
  const mine = { a: 1, o: { x: 2 } };
  const theirs = { a: 1 };
  const { conflicts } = merge(base, mine, theirs);
  assert.equal(conflicts[0].theirs, MISSING);
  const draft = buildDraft({
    inputs: { base: JSON.stringify(base), mine: JSON.stringify(mine), theirs: JSON.stringify(theirs) },
    choices: [{
      path: ['o'],
      base: { exists: true, value: { x: 1 } },
      mine: { exists: true, value: { x: 2 } },
      theirs: { exists: false },
      choice: 'mine',
    }],
  });
  const plan = planReplay(draft, conflicts);
  assert.equal(plan.reusable.length, 1);

  // 当前冲突的对方值变为 null（而非缺失）：必须不匹配
  const theirsNull = { a: 1, o: null };
  const mergeNull = merge(base, mine, theirsNull);
  const planNull = planReplay(draft, mergeNull.conflicts);
  assert.equal(planNull.reusable.length, 0);
  assert.equal(planNull.skipped.length, 1);
});

test('writeDraft / readDraft 往返：非空草稿写入后可读出并校验', () => {
  const storage = memStorage();
  const { entries } = chosenEntries();
  const draft = buildDraft({ inputs: TEXTS, schema: '{"type":"object"}', merged: TEXTS, choices: entries });
  assert.equal(writeDraft(storage, draft).status, 'ok');
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).version, 1);
  const r = readDraft(storage);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.draft, draft);
});

test('writeDraft：空白草稿等价于删除（清空 / 丢弃路径）', () => {
  const storage = memStorage();
  writeDraft(storage, buildDraft({ inputs: TEXTS }));
  assert.equal(readDraft(storage).status, 'ok');
  const r = writeDraft(storage, buildDraft({}));
  assert.equal(r.status, 'ok');
  assert.equal(readDraft(storage).status, 'empty');
  // removeDraft 同样删除
  writeDraft(storage, buildDraft({ inputs: TEXTS }));
  assert.equal(removeDraft(storage).status, 'ok');
  assert.equal(readDraft(storage).status, 'empty');
});

test('readDraft：无草稿为 empty；JSON 损坏为 corrupt 并自动删除', () => {
  const storage = memStorage();
  assert.equal(readDraft(storage).status, 'empty');

  const broken = memStorage({ [STORAGE_KEY]: '{不是 JSON' });
  const r = readDraft(broken);
  assert.equal(r.status, 'corrupt');
  assert.match(r.reason, /JSON 语法错误/);
  // 损坏项已被清理，再次读取不再重复提示
  assert.equal(readDraft(broken).status, 'empty');

  // 结构损坏同样判定 corrupt
  const valid = buildDraft({ inputs: TEXTS });
  const badStruct = memStorage({ [STORAGE_KEY]: JSON.stringify({ ...valid, version: 9 }) });
  const r2 = readDraft(badStruct);
  assert.equal(r2.status, 'corrupt');
  assert.match(r2.reason, /version 必须为/);
  assert.equal(readDraft(badStruct).status, 'empty');

  // 多余键先在顶层键校验处拒绝
  const extraKey = memStorage({ [STORAGE_KEY]: JSON.stringify({ ...valid, foo: 1 }) });
  assert.equal(readDraft(extraKey).status, 'corrupt');
});

test('存储不可用 / 被拒绝：返回中文原因，不抛异常（正常合并仍可用）', () => {
  assert.equal(readDraft(null).status, 'unavailable');
  assert.equal(readDraft(undefined).status, 'unavailable');
  assert.equal(readDraft({}).status, 'unavailable');

  const quota = throwingStorage(() => {
    const err = new Error('over quota');
    err.name = 'QuotaExceededError';
    return err;
  });
  const w = writeDraft(quota, buildDraft({ inputs: TEXTS }));
  assert.equal(w.status, 'error');
  assert.match(w.reason, /存储空间已满/);

  const security = throwingStorage(null, () => {
    const err = new Error('blocked');
    err.name = 'SecurityError';
    return err;
  });
  const r = readDraft(security);
  assert.equal(r.status, 'unavailable');
  assert.match(r.reason, /拒绝访问本地存储/);

  // 删除同样返回错误原因
  const delErr = throwingStorage(null, null, () => {
    const err = new Error('blocked');
    err.name = 'SecurityError';
    return err;
  });
  assert.match(removeDraft(delErr).reason, /拒绝访问本地存储/);
});
