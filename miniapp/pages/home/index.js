const { request, track } = require('../../services/api');
const { formatDate } = require('../../services/util');
Page({
  data: { items: [], visible: [], filter: 'ALL', loading: true, error: '', creating: false, createBusy: false, createError: '', alias: '', nextCursor: null, moreBusy: false },
  onLoad(options) { if (options.create === '1') this.openCreate(); },
  onShow() { this.setData({ alias: getApp().globalData.lastAlias || '' }); this.load(); track('home_view'); },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  async load() {
    this.setData({ loading: !this.data.items.length, error: '' });
    try {
      const data = await request(`/v1/me/capsules?state=${this.data.filter}`);
      this.setData({ items: data.items.map(this.decorate), nextCursor: data.next_cursor, loading: false });
      this.applyFilter();
    } catch (error) { this.setData({ loading: false, error: error.message || '加载失败，请重试。' }); }
  },
  decorate(item) {
    const names = { DUE: '待开封', SEALED: '进行中', OPENED: '已开封' };
    return { ...item, label: names[item.state], roleText: item.role === 'creator' ? '我发起的' : '我参与的', timeText: formatDate(item.opens_at) };
  },
  applyFilter() {
    const f = this.data.filter;
    this.setData({ visible: this.data.items.filter(x => f === 'ALL' || x.state === (f === 'ACTIVE' ? 'SEALED' : f)) });
  },
  filterTap(e) { this.setData({ filter: e.currentTarget.dataset.filter, items: [], visible: [] }); this.load(); },
  async loadMore() {
    if (!this.data.nextCursor || this.data.moreBusy) return;
    this.setData({ moreBusy: true });
    try {
      const data = await request(`/v1/me/capsules?state=${this.data.filter}&cursor=${encodeURIComponent(this.data.nextCursor)}`);
      this.setData({ items: this.data.items.concat(data.items.map(this.decorate)), nextCursor: data.next_cursor });
      this.applyFilter();
    } catch (error) { this.setData({ error: error.message || '加载失败，请重试。' }); }
    finally { this.setData({ moreBusy: false }); }
  },
  openCard(e) { wx.navigateTo({ url: `/pages/capsule/detail?id=${e.currentTarget.dataset.id}` }); },
  openCreate() { this.setData({ creating: true, createError: '', alias: getApp().globalData.lastAlias || '' }); track('create_sheet_open'); },
  closeCreate() { this.setData({ creating: false }); },
  async submitCreate(e) {
    if (this.data.createBusy) return;
    this.setData({ createBusy: true, createError: '' }); track('create_submit');
    try {
      const capsule = await request('/v1/capsules', 'POST', e.detail);
      getApp().globalData.lastAlias = e.detail.alias.trim();
      wx.setStorageSync('last_alias', getApp().globalData.lastAlias);
      track('create_success', { capsule_id: capsule.id });
      this.selectComponent('#createSheet').reset();
      this.setData({ creating: false, createBusy: false });
      wx.navigateTo({ url: `/pages/capsule/detail?id=${capsule.id}` });
    } catch (error) { this.setData({ createError: error.message || '创建失败，请重试。', createBusy: false }); }
  }
});
