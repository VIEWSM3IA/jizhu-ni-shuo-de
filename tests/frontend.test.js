const { test } = require('node:test');
const assert = require('node:assert/strict');
const { customIso, canChooseTonight, dueRefreshDelay, graphemeCount } = require('../miniapp/services/time');

function component(path) {
  let definition;
  global.Component = value => { definition = value; };
  delete require.cache[require.resolve(path)];
  require(path);
  delete global.Component;
  const events = [];
  const instance = {
    data: { ...definition.data },
    setData(patch, callback) { Object.assign(this.data, patch); if (callback) callback(); },
    triggerEvent(name, detail) { events.push({ name, detail }); }
  };
  Object.assign(instance, definition.methods);
  return { instance, events };
}

test('create sheet clears previous time and only builds complete custom dates', () => {
  global.wx = { showToast() {} };
  const { instance: sheet, events } = component('../miniapp/components/create-sheet/index.js');
  sheet.choose({ currentTarget: { dataset: { kind: 'week' } } });
  assert.ok(sheet.data.opensAt);
  sheet.choose({ currentTarget: { dataset: { kind: 'custom' } } });
  assert.equal(sheet.data.opensAt, '');
  sheet.onDate({ detail: { value: '2026-10-05' } });
  assert.equal(sheet.data.opensAt, '');
  sheet.submit();
  assert.equal(events.length, 0);
  sheet.onTime({ detail: { value: '12:30' } });
  assert.equal(sheet.data.opensAt, customIso('2026-10-05', '12:30'));
  sheet.reset();
  assert.equal(sheet.data.opensAt, '');
  assert.equal(sheet.data.currentId, '');
  delete global.wx;
});

test('create retry keeps request id until reset', () => {
  global.wx = { showToast() {} };
  const { instance: sheet, events } = component('../miniapp/components/create-sheet/index.js');
  sheet.onStatement({ detail: { value: '明天会下雨' } });
  sheet.onAlias({ detail: { value: '阿杰' } });
  sheet.choose({ currentTarget: { dataset: { kind: 'week' } } });
  sheet.submit(); sheet.submit();
  assert.equal(events.length, 2);
  assert.equal(events[0].detail.client_request_id, events[1].detail.client_request_id);
  sheet.onStatement({ detail: { value: '后天会下雨' } });
  sheet.submit();
  assert.notEqual(events[2].detail.client_request_id, events[1].detail.client_request_id);
  sheet.reset();
  assert.equal(sheet.data.currentId, '');
  delete global.wx;
});

test('time helpers reject invalid dates and protect tonight cutoff', () => {
  assert.equal(customIso('2026-02-30', '12:00'), '');
  assert.equal(customIso('2026-10-05', ''), '');
  assert.equal(customIso('2026-10-05', '25:00'), '');
  assert.equal(canChooseTonight(new Date(2026, 8, 26, 23, 46, 59)), true);
  assert.equal(canChooseTonight(new Date(2026, 8, 26, 23, 47, 1)), false);
  assert.equal(graphemeCount('👨‍👩‍👧‍👦'), 1);
});

test('due scheduler asks server again and clears on hide/unload', () => {
  assert.equal(dueRefreshDelay({ state: 'SEALED', opens_at: new Date(60000).toISOString() }, 1000), 59000);
  assert.equal(dueRefreshDelay({ state: 'JOINABLE', opens_at: new Date(1000).toISOString() }, 1000), 0);
  assert.equal(dueRefreshDelay({ state: 'OPENED', opens_at: new Date(60000).toISOString() }, 1000), null);
  assert.equal(dueRefreshDelay({ state: 'SEALED', opens_at: new Date(2147483647 + 5000).toISOString() }, 0), 2147483647);
  let definition;
  global.Page = value => { definition = value; };
  delete require.cache[require.resolve('../miniapp/pages/capsule/detail.js')];
  require('../miniapp/pages/capsule/detail.js');
  delete global.Page;
  const realSetTimeout = global.setTimeout, realClearTimeout = global.clearTimeout;
  const timers = new Map(); let next = 0, loads = 0;
  global.setTimeout = (callback, delay) => { timers.set(++next, { callback, delay }); return next; };
  global.clearTimeout = id => timers.delete(id);
  try {
    const page = { ...definition, pageVisible: true, data: { capsule: { state: 'SEALED', opens_at: new Date(Date.now() + 60000).toISOString() } }, load() { loads++; } };
    page.scheduleDueRefresh();
    assert.equal(timers.size, 1);
    const [timerId, timer] = [...timers.entries()][0];
    timers.delete(timerId);
    timer.callback();
    assert.equal(loads, 1);
    assert.equal(page.data.capsule.state, 'SEALED');
    page.scheduleDueRefresh();
    page.onHide();
    assert.equal(timers.size, 0);
    page.lastLoaded = Date.now();
    page.onShow();
    assert.equal(timers.size, 1);
    page.data.capsule.opens_at = new Date(Date.now() + 2147483647 + 5000).toISOString();
    page.scheduleDueRefresh();
    assert.equal([...timers.values()][0].delay, 2147483647);
    page.scheduleDueRetry();
    assert.equal([...timers.values()][0].delay, 10000);
    page.onUnload();
    assert.equal(timers.size, 0);
    page.unloaded = false;
    page.data.capsule.opens_at = new Date(Date.now() - 1).toISOString();
    page.onShow();
    assert.equal(loads, 2);
    assert.equal(timers.size, 0);
  } finally { global.setTimeout = realSetTimeout; global.clearTimeout = realClearTimeout; }
});

test('mutation refresh waits for an older detail GET then fetches again', async () => {
  let definition;
  global.Page = value => { definition = value; };
  delete require.cache[require.resolve('../miniapp/pages/capsule/detail.js')];
  require('../miniapp/pages/capsule/detail.js');
  delete global.Page;
  let finishFirst, calls = 0;
  const page = { ...definition, fetchDetail() { calls++; return calls === 1 ? new Promise(resolve => { finishFirst = resolve; }) : Promise.resolve(); } };
  const oldGet = page.load();
  const afterMutation = page.load(true, true);
  assert.equal(calls, 1);
  finishFirst();
  await Promise.all([oldGet, afterMutation]);
  assert.equal(calls, 2);
});
