const { request, track } = require('../../services/api');
const { formatDate, shareTitle, resultShareTitle } = require('../../services/util');
const { dueRefreshDelay } = require('../../services/time');
const { reminderTemplateId } = require('../../config');
Page({
  data: { id: '', capsule: null, loading: true, busy: false, error: '', aliasOpen: false, aliasError: '', pendingStance: '', entry: 'direct', canGoBack: false, reminderBusy: false, reminderUI: null },
  onLoad(options) {
    this.pageVisible = true;
    const entry = options.src === 'reminder' ? 'reminder' : options.src === 'result_share' ? 'result_share' : getCurrentPages().length === 1 ? 'share' : 'home';
    this.setData({ id: options.id || '', entry, canGoBack: getCurrentPages().length > 1 });
    if (entry === 'reminder') track('reminder_entry_view', { capsule_id: this.data.id, entry_source: 'reminder' });
    if (entry === 'result_share') track('result_share_entry', { capsule_id: this.data.id, entry_source: 'result_share' });
    this.load();
  },
  onShow() {
    this.pageVisible = true;
    const delay = dueRefreshDelay(this.data.capsule);
    if (delay === 0 || (this.data.capsule && Date.now() - (this.lastLoaded || 0) > 30000)) this.load(true);
    else this.scheduleDueRefresh();
  },
  onHide() { this.pageVisible = false; this.clearDueRefresh(); },
  onUnload() { this.pageVisible = false; this.unloaded = true; this.clearDueRefresh(); },
  onPullDownRefresh() { this.load(true).finally(() => wx.stopPullDownRefresh()); },
  clearDueRefresh() { clearTimeout(this.dueTimer); this.dueTimer = null; },
  scheduleDueRefresh() {
    this.clearDueRefresh();
    if (!this.pageVisible || this.unloaded) return;
    const delay = dueRefreshDelay(this.data.capsule);
    if (delay === null) return;
    // If the device clock is ahead, retry without a tight request loop; the server owns state.
    this.dueTimer = setTimeout(() => { this.dueTimer = null; this.load(true); }, delay === 0 ? 30000 : Math.min(delay + 50, 2147483647));
  },
  scheduleDueRetry() {
    this.clearDueRefresh();
    if (!this.pageVisible || this.unloaded || dueRefreshDelay(this.data.capsule) === null) return;
    this.dueTimer = setTimeout(() => { this.dueTimer = null; this.load(true); }, 10000);
  },
  async load(silent = false, fresh = false) {
    if (fresh && this.loadPromise) await this.loadPromise;
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.fetchDetail(silent).finally(() => { this.loadPromise = null; });
    return this.loadPromise;
  },
  async fetchDetail(silent = false) {
    if (!silent) this.setData({ loading: true });
    this.setData({ error: '' });
    try {
      const c = await request(`/v1/capsules/${encodeURIComponent(this.data.id)}`);
      if (this.unloaded) return;
      c.timeText = c.opens_at ? formatDate(c.opens_at) : '';
      c.openedTimeText = c.opened_at ? formatDate(c.opened_at) : '';
      if (c.results) c.results = c.results.map(r => ({ ...r, avatar: [...r.alias][0], label: r.stance === 'agree' ? '同意' : '反对' }));
      this.lastLoaded = Date.now();
      this.setData({ capsule: c, reminderUI: this.deriveReminderUI(c), loading: false });
      this.scheduleDueRefresh();
      track('capsule_view', { capsule_id: c.id, capsule_state: c.state, entry_source: this.data.entry });
      if (c.state === 'DUE') track('due_view', { capsule_id: c.id });
      if (c.state === 'OPENED') track('opened_view', { capsule_id: c.id });
    } catch (error) {
      if (!this.unloaded) {
        this.setData({ loading: false, error: error.message || '加载失败，请重试。' });
        this.scheduleDueRetry();
      }
    }
  },
  deriveReminderUI(c) {
    const r = c?.viewer?.reminder || {};
    const key = 'reminder_grant:' + this.data.id;
    const grant = wx.getStorageSync(key);
    const serverState = r.state || 'none';
    if (!r.eligible || serverState === 'armed' || serverState === 'sent') {
      if (grant) { try { wx.removeStorageSync(key); } catch {} }
      return { eligible: !!r.eligible, state: serverState, configured: !!reminderTemplateId };
    }
    const validGrant = serverState === 'none' && r.eligible === true && grant &&
      grant.template_id === reminderTemplateId && Number.isFinite(grant.granted_at);
    if (grant && !validGrant) { try { wx.removeStorageSync(key); } catch {} }
    if (r.eligible && !validGrant && reminderTemplateId && !this._reminderCtaViewed) {
      this._reminderCtaViewed = true;
      track('reminder_cta_view', { capsule_id: this.data.id });
    }
    return { eligible: true, state: validGrant ? 'pending' : serverState, configured: !!reminderTemplateId };
  },
  async requestReminder() {
    if (this.data.reminderBusy || !reminderTemplateId || !this.data.reminderUI?.eligible || this.data.reminderUI.state !== 'none') return;
    this.setData({ reminderBusy: true });
    track('reminder_cta_tap', { capsule_id: this.data.id });
    let result;
    try {
      result = await new Promise((resolve, reject) => wx.requestSubscribeMessage({ tmplIds: [reminderTemplateId], success: resolve, fail: reject }));
    } catch {
      track('reminder_permission_result', { capsule_id: this.data.id, permission_result: 'error' });
      wx.showToast({ title: '订阅请求失败，请稍后重试', icon: 'none' });
      this.setData({ reminderBusy: false });
      return;
    }
    const permission = result?.[reminderTemplateId] || 'error';
    track('reminder_permission_result', { capsule_id: this.data.id, permission_result: ['accept', 'acceptWithAudio', 'reject', 'ban', 'filter'].includes(permission) ? permission : 'error' });
    if (permission !== 'accept' && permission !== 'acceptWithAudio') {
      const messages = { reject: '没关系，到期后也可以从首页回来开封', ban: '请在微信设置中开启订阅消息权限', filter: '该提醒暂时不可订阅' };
      wx.showToast({ title: messages[permission] || '未能开启提醒', icon: 'none' });
      this.setData({ reminderBusy: false });
      return;
    }
    try { wx.setStorageSync('reminder_grant:' + this.data.id, { template_id: reminderTemplateId, granted_at: Date.now() }); }
    catch { /* Permission was accepted; still use it for this server request. */ }
    this.setData({ reminderUI: { eligible: true, state: 'pending', configured: true } });
    await this.retryReminder(true);
    this.setData({ reminderBusy: false });
  },
  async retryReminder(fromGrant) {
    const inheritedBusy = fromGrant === true;
    if (!reminderTemplateId || !this.data.reminderUI?.eligible || this.data.reminderUI.state !== 'pending') return;
    if (!inheritedBusy) {
      if (this.data.reminderBusy) return;
      this.setData({ reminderBusy: true });
      track('reminder_arm_retry', { capsule_id: this.data.id });
    }
    const timezone = Math.max(-720, Math.min(840, -new Date().getTimezoneOffset()));
    try {
      await request('/v1/capsules/' + this.data.id + '/reminder', 'POST', { template_id: reminderTemplateId, timezone_offset_minutes: timezone });
      try { wx.removeStorageSync('reminder_grant:' + this.data.id); } catch {}
      track('reminder_arm_success', { capsule_id: this.data.id });
      await this.load(true, true);
      wx.showToast({ title: '到期时会提醒你', icon: 'none' });
    } catch (error) {
      const code = error?.code;
      if (code === 'REMINDER_NOT_ELIGIBLE' || code === 'REMINDER_ALREADY_SENT') {
        try { wx.removeStorageSync('reminder_grant:' + this.data.id); } catch {}
        await this.load(true, true);
      } else if (code === 'REMINDER_TEMPLATE_MISMATCH' || code === 'INVALID_TIMEZONE') {
        try { wx.removeStorageSync('reminder_grant:' + this.data.id); } catch {}
        this.setData({ reminderUI: { eligible: false, state: 'unavailable', configured: true } });
        wx.showToast({ title: '提醒配置异常，暂无法设置', icon: 'none' });
      } else {
        this.setData({ reminderUI: { eligible: true, state: 'pending', configured: true } });
        wx.showToast({ title: '提醒保存失败，可点击重试', icon: 'none' });
      }
    } finally { if (!inheritedBusy) this.setData({ reminderBusy: false }); }
  },
  cancelReminder() {
    if (this.data.reminderBusy) return;
    wx.showModal({ title: '取消这次到期提醒？', success: async ({ confirm }) => {
      if (!confirm) return;
      this.setData({ reminderBusy: true });
      try {
        await request('/v1/capsules/' + this.data.id + '/reminder', 'DELETE');
        try { wx.removeStorageSync('reminder_grant:' + this.data.id); } catch {}
        track('reminder_cancel', { capsule_id: this.data.id });
        await this.load(true, true);
      } catch { wx.showToast({ title: '取消失败，请稍后重试', icon: 'none' }); }
      finally { this.setData({ reminderBusy: false }); }
    } });
  },
  async choose(e) {
    if (this.data.busy) return;
    const stance = e.currentTarget.dataset.stance;
    track('stance_tap', { capsule_id: this.data.id });
    if (!getApp().globalData.lastAlias) {
      this.setData({ pendingStance: stance, aliasOpen: true, aliasError: '' });
      track('alias_sheet_view', { capsule_id: this.data.id });
      return;
    }
    await this.submitStance(stance, getApp().globalData.lastAlias);
  },
  async aliasSubmit(e) {
    track('alias_submit', { capsule_id: this.data.id });
    await this.submitStance(this.data.pendingStance, e.detail.alias);
  },
  async submitStance(stance, alias) {
    if (this.data.busy) return;
    this.setData({ busy: true, error: '', aliasError: '' });
    try {
      await request(`/v1/capsules/${this.data.id}/stances`, 'POST', { stance, alias });
      getApp().globalData.lastAlias = alias.trim();
      wx.setStorageSync('last_alias', getApp().globalData.lastAlias);
      this.setData({ aliasOpen: false, busy: false });
      track('stance_success', { capsule_id: this.data.id });
      await this.load(true, true);
    } catch (error) {
      this.setData({ busy: false, [this.data.aliasOpen ? 'aliasError' : 'error']: error.message || '押话失败，请重试。' });
      if (error.code === 'NOT_JOINABLE') { this.setData({ aliasOpen: false }); await this.load(true); }
    }
  },
  closeAlias() { this.setData({ aliasOpen: false }); },
  async openCapsule() {
    if (this.data.busy) return;
    this.setData({ busy: true, error: '' }); track('open_tap', { capsule_id: this.data.id });
    try {
      await request(`/v1/capsules/${this.data.id}/open`, 'POST');
      track('open_success', { capsule_id: this.data.id });
      await this.load(true, true);
    } catch (error) {
      const message = error.message || '开封失败，请重试。';
      await this.load(true, true);
      if (this.data.capsule?.state !== 'OPENED') this.setData({ error: message });
    }
    finally { this.setData({ busy: false }); }
  },
  menu() {
    const c = this.data.capsule;
    const options = c.viewer?.is_creator && c.state === 'SEALED' && c.participant_count === 1 ? ['举报内容', '撤销这句话'] : ['举报内容'];
    wx.showActionSheet({ itemList: options, success: e => options[e.tapIndex] === '举报内容' ? this.report() : this.cancel() });
  },
  async report() {
    try { await request(`/v1/capsules/${this.data.id}/reports`, 'POST'); wx.showToast({ title: '已收到举报', icon: 'none' }); }
    catch (e) { this.setData({ error: e.message }); }
  },
  cancel() {
    wx.showModal({ title: '撤销这句话？', content: '撤销后，分享链接将失效。', success: async result => {
      if (!result.confirm) return;
      try { await request(`/v1/capsules/${this.data.id}`, 'DELETE'); track('capsule_cancel', { capsule_id: this.data.id }); await this.load(true, true); }
      catch (e) { this.setData({ error: e.message }); }
    } });
  },
  goHome() { wx.reLaunch({ url: '/pages/home/index' }); },
  createAgain() { track('create_from_opened', { capsule_id: this.data.id, entry_source: this.data.entry }); wx.reLaunch({ url: '/pages/home/index?create=1' }); },
  onShareAppMessage() {
    const c = this.data.capsule;
    if (!c?.id) return { title: '记住你说的', path: '/pages/home/index' };
    track(c.state === 'OPENED' ? 'opened_share_intent' : 'share_intent', { capsule_id: c.id });
    if (c.state === 'OPENED') return { title: resultShareTitle(c), path: `/pages/capsule/detail?id=${c.id}&src=result_share` };
    return { title: shareTitle(c), path: `/pages/capsule/detail?id=${c.id}` };
  }
});
