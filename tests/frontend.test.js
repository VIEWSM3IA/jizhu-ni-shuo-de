const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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

test('detail reminder grant persists across retry and reject never posts', async () => {
  const apiPath = require.resolve('../miniapp/services/api');
  const detailPath = require.resolve('../miniapp/pages/capsule/detail.js');
  const configPath = require.resolve('../miniapp/config');
  require(apiPath);
  const config = require(configPath);
  const oldApi = require.cache[apiPath].exports;
  const oldTemplate = config.reminderTemplateId;
  const oldPage = global.Page;
  const oldWx = global.wx;
  const store = new Map();
  const calls = [];
  let pageDef, subscribeResult = 'accept', subscribeFailure = false, postCount = 0, failPost = true, throwSet = false, throwRemove = false;

  try {
    require.cache[apiPath].exports = {
      request: async (path, method, data) => {
        calls.push(['post', store.has('reminder_grant:123e4567-e89b-42d3-a456-426614174000'), path, method, data]);
        postCount++;
        if (failPost) throw new Error('timeout');
        return { reminder: { state: 'armed' } };
      },
      track: () => {},
    };
    config.reminderTemplateId = 'test-template';

    global.Page = def => { pageDef = def; };
    global.wx = {
      requestSubscribeMessage({ tmplIds, success, fail }) {
        calls.push(['subscribe', tmplIds]);
        if (subscribeFailure) return fail(new Error('WeChat unavailable'));
        success({ [tmplIds[0]]: subscribeResult });
      },
      getStorageSync: key => store.get(key),
      setStorageSync(key, value) {
        if (throwSet) throw new Error('storage unavailable');
        calls.push(['store', key]);
        store.set(key, value);
      },
      removeStorageSync(key) {
        if (throwRemove) throw new Error('storage unavailable');
        calls.push(['remove', key]);
        store.delete(key);
      },
      showToast() {},
      showModal() {},
    };

    delete require.cache[detailPath];
    require(detailPath);

    const makePage = () => {
      const page = Object.assign({}, pageDef);
      page.data = {
        id: '123e4567-e89b-42d3-a456-426614174000',
        reminderUI: { eligible: true, state: 'none', configured: true },
        reminderBusy: false,
      };
      page.setData = patch => Object.assign(page.data, patch);
      page.load = async () => {
        page.data.reminderUI = { eligible: true, state: 'armed', configured: true };
      };
      return page;
    };

    const page = makePage();
    assert.equal(calls.some(x => x[0] === 'subscribe'), false);

    await page.requestReminder();
    assert.equal(postCount, 1);
    assert.equal(calls.find(x => x[0] === 'post')[1], true);
    assert.equal(store.size, 1);
    assert.equal(page.data.reminderUI.state, 'pending');

    failPost = false;
    const subscribeCalls = calls.filter(x => x[0] === 'subscribe').length;
    await page.retryReminder();
    assert.equal(postCount, 2);
    assert.equal(calls.filter(x => x[0] === 'subscribe').length, subscribeCalls);
    assert.equal(store.size, 0);
    assert.equal(page.data.reminderUI.state, 'armed');

    store.clear();
    subscribeResult = 'reject';
    const rejected = makePage();
    const beforePosts = postCount;
    await rejected.requestReminder();
    assert.equal(postCount, beforePosts);
    assert.equal(store.size, 0);

    for (const permission of ['ban', 'filter']) {
      subscribeResult = permission;
      await makePage().requestReminder();
      assert.equal(postCount, beforePosts);
    }
    subscribeFailure = true;
    await makePage().requestReminder();
    subscribeFailure = false;
    assert.equal(postCount, beforePosts);

    subscribeResult = 'acceptWithAudio';
    throwSet = true;
    const storageFailed = makePage();
    await storageFailed.requestReminder();
    assert.equal(postCount, beforePosts + 1);
    assert.equal(storageFailed.data.reminderUI.state, 'armed');
    throwSet = false;

    throwRemove = true;
    const cleanupFailed = makePage();
    await cleanupFailed.requestReminder();
    assert.equal(postCount, beforePosts + 2);
    assert.equal(cleanupFailed.data.reminderUI.state, 'armed');
    throwRemove = false;
    const grantKey = 'reminder_grant:123e4567-e89b-42d3-a456-426614174000';
    store.set(grantKey, { template_id: 'test-template', granted_at: Date.now() });
    const clockAhead = makePage();
    assert.equal(clockAhead.deriveReminderUI({ opens_at: '2000-01-01T00:00:00.000Z', viewer: { reminder: { eligible: true, state: 'none' } } }).state, 'pending');
    assert.equal(store.has(grantKey), true);
  } finally {
    require.cache[apiPath].exports = oldApi;
    config.reminderTemplateId = oldTemplate;
    delete require.cache[detailPath];
    if (oldPage === undefined) delete global.Page;
    else global.Page = oldPage;
    if (oldWx === undefined) delete global.wx;
    else global.wx = oldWx;
  }
});

test('detail reminder retry distinguishes terminal errors and cancellation survives storage failure', async () => {
  const apiPath = require.resolve('../miniapp/services/api');
  const detailPath = require.resolve('../miniapp/pages/capsule/detail.js');
  const config = require('../miniapp/config');
  require(apiPath);
  const oldApi = require.cache[apiPath].exports;
  const oldTemplate = config.reminderTemplateId;
  const oldPage = global.Page, oldWx = global.wx;
  const grantKey = 'reminder_grant:123e4567-e89b-42d3-a456-426614174000';
  const store = new Map(), toasts = [], tracks = [];
  let pageDef, error, subscribeCalls = 0, postCalls = 0, deleteCalls = 0;
  let removeThrows = false, modalPromise;
  try {
    require.cache[apiPath].exports = {
      request: async (_path, method) => {
        if (method === 'POST') { postCalls++; throw error; }
        if (method === 'DELETE') { deleteCalls++; return {}; }
        throw new Error('unexpected request');
      },
      track: name => tracks.push(name)
    };
    config.reminderTemplateId = 'test-template';
    global.Page = definition => { pageDef = definition; };
    global.wx = {
      requestSubscribeMessage() { subscribeCalls++; },
      getStorageSync: key => store.get(key),
      removeStorageSync(key) {
        if (removeThrows) throw new Error('storage unavailable');
        store.delete(key);
      },
      showToast: value => toasts.push(value.title),
      showModal: ({ success }) => { modalPromise = success({ confirm: true }); }
    };
    delete require.cache[detailPath];
    require(detailPath);
    const makePage = () => {
      const page = Object.assign({}, pageDef);
      page.data = { id: '123e4567-e89b-42d3-a456-426614174000',
        reminderUI: { eligible: true, state: 'pending', configured: true }, reminderBusy: false };
      page.setData = patch => Object.assign(page.data, patch);
      page.loads = 0;
      page.load = async () => { page.loads++; page.data.reminderUI = { eligible: true, state: 'none', configured: true }; };
      return page;
    };
    const cases = [
      { error: new Error('timeout'), retained: true, state: 'pending', loads: 0 },
      { error: Object.assign(new Error('503'), { status: 503 }), retained: true, state: 'pending', loads: 0 },
      { error: Object.assign(new Error('ineligible'), { code: 'REMINDER_NOT_ELIGIBLE' }), retained: false, state: 'none', loads: 1 },
      { error: Object.assign(new Error('mismatch'), { code: 'REMINDER_TEMPLATE_MISMATCH' }), retained: false, state: 'unavailable', loads: 0 },
      { error: Object.assign(new Error('sent'), { code: 'REMINDER_ALREADY_SENT' }), retained: false, state: 'none', loads: 1 },
      { error: Object.assign(new Error('timezone'), { code: 'INVALID_TIMEZONE' }), retained: false, state: 'unavailable', loads: 0 }
    ];
    for (const scenario of cases) {
      store.set(grantKey, { template_id: 'test-template', granted_at: Date.now() });
      error = scenario.error;
      const page = makePage();
      await page.retryReminder();
      assert.equal(store.has(grantKey), scenario.retained, scenario.error.message);
      assert.equal(page.data.reminderUI.state, scenario.state, scenario.error.message);
      assert.equal(page.loads, scenario.loads, scenario.error.message);
      assert.equal(subscribeCalls, 0);
    }
    assert.equal(postCalls, cases.length);
    assert.ok(toasts.includes('提醒配置异常，暂无法设置'));

    const cancelled = makePage();
    cancelled.data.reminderUI.state = 'armed';
    removeThrows = true;
    const previousToasts = toasts.length;
    cancelled.cancelReminder();
    await modalPromise;
    assert.equal(deleteCalls, 1);
    assert.equal(cancelled.loads, 1);
    assert.equal(cancelled.data.reminderUI.state, 'none');
    assert.equal(cancelled.data.reminderBusy, false);
    assert.ok(tracks.includes('reminder_cancel'));
    assert.equal(toasts.length, previousToasts);
  } finally {
    require.cache[apiPath].exports = oldApi;
    config.reminderTemplateId = oldTemplate;
    delete require.cache[detailPath];
    if (oldPage === undefined) delete global.Page; else global.Page = oldPage;
    if (oldWx === undefined) delete global.wx; else global.wx = oldWx;
  }
});

test('detail reminder deep link recovery and home due banner', async () => {
  const apiId = require.resolve('../miniapp/services/api');
  const detailId = require.resolve('../miniapp/pages/capsule/detail');
  const homeId = require.resolve('../miniapp/pages/home/index');
  const configId = require.resolve('../miniapp/config');
  require(apiId);
  const oldApi = require.cache[apiId].exports;
  const oldDetail = require.cache[detailId];
  const oldHome = require.cache[homeId];
  const config = require(configId);
  const hadTpl = Object.prototype.hasOwnProperty.call(config, 'reminderTemplateId');
  const oldTpl = config.reminderTemplateId;
  const oldPage = global.Page, oldWx = global.wx, oldPages = global.getCurrentPages;
  const tracks = [], saved = { template_id: 'test-template', granted_at: Date.now() };
  let subscribed = 0, def;
  try {
    require.cache[apiId].exports = {
      request: async () => ({
        id: 'valid',
        opens_at: new Date(Date.now() + 3600000).toISOString(),
        state: 'SEALED',
        viewer: { reminder: { eligible: true, state: 'none' } }
      }),
      track: name => tracks.push(name)
    };
    config.reminderTemplateId = 'test-template';
    global.Page = x => { def = x; };
    global.getCurrentPages = () => [{}];
    global.wx = {
      getStorageSync: () => saved,
      setStorageSync() {},
      removeStorageSync() {},
      requestSubscribeMessage() { subscribed++; },
      showToast() {},
      showModal() {}
    };

    delete require.cache[detailId];
    require(detailId);
    const detail = Object.assign({}, def, {
      data: JSON.parse(JSON.stringify(def.data)),
      setData(v, cb) { Object.assign(this.data, v); if (cb) cb(); }
    });
    detail.onLoad({ id: 'valid', src: 'reminder' });
    if (detail.loadPromise) await detail.loadPromise;
    assert.equal(detail.data.entry, 'reminder');
    assert.equal(detail.data.reminderUI.state, 'pending');
    assert.ok(tracks.includes('reminder_entry_view'));
    assert.equal(subscribed, 0);
    if (detail.onUnload) detail.onUnload();

    def = null;
    delete require.cache[homeId];
    require(homeId);
    const home = Object.assign({}, def, {
      data: { ...def.data, summary: { due_count: 2, upcoming_24h_count: 0 } },
      setData(v, cb) { Object.assign(this.data, v); if (cb) cb(); }
    });
    let loadedFilter;
    home.load = function () { loadedFilter = this.data.filter; };
    home.dueBannerTap();
    assert.equal(home.data.filter, 'DUE');
    assert.deepEqual(home.data.items, []);
    assert.deepEqual(home.data.visible, []);
    assert.equal(loadedFilter, 'DUE');
  } finally {
    require.cache[apiId].exports = oldApi;
    delete require.cache[detailId];
    delete require.cache[homeId];
    if (oldDetail) require.cache[detailId] = oldDetail;
    if (oldHome) require.cache[homeId] = oldHome;
    if (hadTpl) config.reminderTemplateId = oldTpl;
    else delete config.reminderTemplateId;
    global.Page = oldPage;
    global.wx = oldWx;
    global.getCurrentPages = oldPages;
  }
});

test('V0.3 result-share entry, OPENED share and create CTA preserve visitor privacy', async () => {
  const apiPath = require.resolve('../miniapp/services/api');
  const detailPath = require.resolve('../miniapp/pages/capsule/detail.js');
  require(apiPath);
  const oldApi = require.cache[apiPath].exports;
  const oldPage = global.Page, oldWx = global.wx, oldPages = global.getCurrentPages;
  const id = '123e4567-e89b-42d3-a456-426614174000';
  const tracks = [], launches = [];
  let definition, dto;
  try {
    require.cache[apiPath].exports = {
      request: async path => { assert.equal(path, `/v1/capsules/${id}`); return structuredClone(dto); },
      track: (name, props) => tracks.push({ name, props })
    };
    global.Page = value => { definition = value; };
    global.getCurrentPages = () => [{}];
    global.wx = { getStorageSync() {}, removeStorageSync() {}, reLaunch(value) { launches.push(value); } };
    delete require.cache[detailPath];
    require(detailPath);
    const makePage = () => Object.assign({}, definition, {
      data: structuredClone(definition.data),
      setData(patch, callback) { Object.assign(this.data, patch); if (callback) callback(); }
    });
    dto = {
      id, statement: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890TAIL', creator_alias: '阿杰',
      opens_at: '2026-09-26T11:00:00.000Z', opened_at: '2026-09-26T11:02:03.000Z', state: 'OPENED',
      viewer: { is_creator: true, is_participant: true, reminder: { eligible: false, state: 'none' } },
      results: [
        { id: 'a', alias: '阿杰', stance: 'agree', is_creator: true },
        { id: 'b', alias: '小明', stance: 'disagree', is_creator: false }
      ]
    };
    const opened = makePage();
    opened.onLoad({ id, src: 'result_share' });
    await opened.loadPromise;
    assert.equal(opened.data.entry, 'result_share');
    assert.equal(opened.data.capsule.openedTimeText, require('../miniapp/services/util').formatDate(dto.opened_at));
    assert.deepEqual(opened.data.capsule.results.map(r => r.label), ['同意', '反对']);
    assert.deepEqual(tracks.find(x => x.name === 'result_share_entry'), {
      name: 'result_share_entry', props: { capsule_id: id, entry_source: 'result_share' }
    });
    assert.equal(tracks.find(x => x.name === 'capsule_view').props.entry_source, 'result_share');
    const share = opened.onShareAppMessage();
    assert.equal(share.path, `/pages/capsule/detail?id=${id}&src=result_share`);
    assert.equal(share.title, '「ABCDEFGHIJKLMNOPQR…」——那天大家是这么说的');
    assert.ok([...share.title].length <= 32);
    assert.equal(tracks.filter(x => x.name === 'opened_share_intent').length, 1);
    opened.createAgain();
    assert.deepEqual(launches.at(-1), { url: '/pages/home/index?create=1' });
    assert.deepEqual(tracks.find(x => x.name === 'create_from_opened'), {
      name: 'create_from_opened', props: { capsule_id: id, entry_source: 'result_share' }
    });
    const familyTitle = require('../miniapp/services/util').resultShareTitle({ statement: '123456789012345👨‍👩‍👧‍👦后面的文字足够长触发截断' });
    assert.ok((familyTitle.includes('👨‍👩‍👧‍👦') || !familyTitle.includes('👨')) && [...familyTitle].length <= 32);

    dto = { ...dto, viewer: { is_creator: false, is_participant: false, reminder: { eligible: false, state: 'none' } } };
    delete dto.results;
    const visitor = makePage();
    visitor.onLoad({ id, src: 'result_share' });
    await visitor.loadPromise;
    assert.equal(visitor.data.capsule.results, undefined);
    assert.equal(visitor.data.capsule.openedTimeText, require('../miniapp/services/util').formatDate(dto.opened_at));
    opened.onUnload(); visitor.onUnload();

    global.getCurrentPages = () => [{}, {}];
    const homeOpened = makePage();
    homeOpened.onLoad({ id });
    await homeOpened.loadPromise;
    homeOpened.createAgain();
    assert.deepEqual(tracks.filter(x => x.name === 'create_from_opened').at(-1).props, { capsule_id: id, entry_source: 'home' });
    homeOpened.onUnload();

    dto = { ...dto, state: 'SEALED' };
    const sealed = makePage();
    sealed.onLoad({ id, src: 'reminder' });
    await sealed.loadPromise;
    assert.equal(sealed.data.entry, 'reminder');
    assert.ok(tracks.some(x => x.name === 'reminder_entry_view' && x.props.entry_source === 'reminder'));
    const sealedShare = sealed.onShareAppMessage();
    assert.equal(sealedShare.title, require('../miniapp/services/util').shareTitle(dto));
    assert.equal(sealedShare.path, `/pages/capsule/detail?id=${id}`);
    sealed.onUnload();
  } finally {
    require.cache[apiPath].exports = oldApi;
    delete require.cache[detailPath];
    if (oldPage === undefined) delete global.Page; else global.Page = oldPage;
    if (oldWx === undefined) delete global.wx; else global.wx = oldWx;
    if (oldPages === undefined) delete global.getCurrentPages; else global.getCurrentPages = oldPages;
  }
});

test('V0.3 result and Home copy stays behind the OPENED conditions', () => {
  const detail = fs.readFileSync('miniapp/pages/capsule/detail.wxml', 'utf8');
  const home = fs.readFileSync('miniapp/pages/home/index.wxml', 'utf8');
  assert.match(detail, /那天大家是这么说的/);
  assert.match(detail, /这句话已经开封/);
  assert.match(detail, /只有当时参与押话的人能看到完整结果/);
  assert.match(detail, /分享给朋友看看/);
  assert.match(detail, /我也记一句/);
  assert.match(detail, /wx:if="\{\{capsule.viewer.is_participant\}\}"/);
  assert.match(detail, /wx:for="\{\{capsule.results\}\}"/);
  assert.match(home, /wx:if="\{\{item.state==='OPENED'\}\}" class="opened-hint">那天大家是这么说的 →/);
});

test('result share title fallback keeps composed characters whole', () => {
  const { resultShareTitle } = require('../miniapp/services/util');
  const originalSegmenter = Intl.Segmenter;
  try {
    Intl.Segmenter = undefined;
    for (const [grapheme, fragment] of [
      ['👍🏽', '👍'], ['é', 'e'], ['👨‍👩‍👧‍👦', '👨'], ['🇨🇳', '🇨'], ['कि', 'क']
    ]) {
      const title = resultShareTitle({ statement: 'A'.repeat(17) + grapheme + '后面的字足够长触发截断' });
      assert.equal(title.includes(fragment), false);
      assert.ok([...title].length <= 32);
    }
  } finally { Intl.Segmenter = originalSegmenter; }
});
