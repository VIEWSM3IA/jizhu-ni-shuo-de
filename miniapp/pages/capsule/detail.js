const { request, track } = require('../../services/api');
const { formatDate, shareTitle } = require('../../services/util');
const { dueRefreshDelay } = require('../../services/time');
Page({
  data: { id: '', capsule: null, loading: true, busy: false, error: '', aliasOpen: false, aliasError: '', pendingStance: '', entry: 'direct', canGoBack: false },
  onLoad(options) {
    this.pageVisible = true;
    this.setData({ id: options.id || '', entry: getCurrentPages().length === 1 ? 'share' : 'home', canGoBack: getCurrentPages().length > 1 });
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
      if (c.results) c.results = c.results.map(r => ({ ...r, avatar: [...r.alias][0], label: r.stance === 'agree' ? '同意' : '反对' }));
      this.lastLoaded = Date.now();
      this.setData({ capsule: c, loading: false });
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
  createAgain() { wx.reLaunch({ url: '/pages/home/index?create=1' }); },
  onShareAppMessage() {
    const c = this.data.capsule;
    if (!c?.id) return { title: '记住你说的', path: '/pages/home/index' };
    track(c.state === 'OPENED' ? 'opened_share_intent' : 'share_intent', { capsule_id: c.id });
    return { title: shareTitle(c), path: `/pages/capsule/detail?id=${c.id}` };
  }
});
