const { requestId } = require('../../services/util');
const { MIN_OPEN_DELAY_MS, customIso, canChooseTonight, graphemeCount } = require('../../services/time');
Component({
  properties: { show: Boolean, defaultAlias: String, busy: Boolean, error: String },
  data: { visible: false, statement: '', statementCount: 0, alias: '', selected: '', date: '', time: '', displayTime: '', opensAt: '', tonightAvailable: canChooseTonight(), currentId: '' },
  observers: {
    'defaultAlias': function(value) { if (value && !this.data.alias) this.setData({ alias: value }); },
    'show': function(value) {
      clearTimeout(this.closeTimer);
      if (value) this.setData({ visible: true, tonightAvailable: canChooseTonight() });
      else this.closeTimer = setTimeout(() => this.setData({ visible: false }), 210);
    }
  },
  methods: {
    close() { if (!this.data.busy) this.triggerEvent('close'); },
    noop() {},
    onStatement(e) { this.setData({ statement: e.detail.value, statementCount: graphemeCount(e.detail.value), currentId: '' }); },
    onAlias(e) { this.setData({ alias: e.detail.value, currentId: '' }); },
    choose(e) {
      if (this.data.busy) return;
      const kind = e.currentTarget.dataset.kind;
      const d = new Date();
      if (kind === 'tonight' && !canChooseTonight(d)) {
        this.setData({ tonightAvailable: false });
        wx.showToast({ title: '今晚时间太近，请选择其他时间', icon: 'none' });
        return;
      }
      if (kind === 'tonight') d.setHours(23,59,0,0);
      if (kind === 'day') d.setDate(d.getDate()+1);
      if (kind === 'week') d.setDate(d.getDate()+7);
      if (kind === 'custom') { this.setData({ selected: kind, date: '', time: '', displayTime: '', opensAt: '', currentId: '' }); return; }
      this.setData({ selected: kind, displayTime: `${d.getMonth()+1} 月 ${d.getDate()} 日 ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`, opensAt: d.toISOString(), currentId: '' });
    },
    onDate(e) { this.setData({ date: e.detail.value, opensAt: '', displayTime: '', currentId: '' }, () => this.updateCustom()); },
    onTime(e) { this.setData({ time: e.detail.value, opensAt: '', displayTime: '', currentId: '' }, () => this.updateCustom()); },
    updateCustom() {
      const opensAt = customIso(this.data.date, this.data.time);
      this.setData({ selected: 'custom', opensAt, displayTime: opensAt ? `${this.data.date} ${this.data.time}` : '' });
    },
    submit() {
      if (this.data.busy) return;
      const statement = this.data.statement.trim(), alias = this.data.alias.trim();
      if (graphemeCount(statement) < 2 || graphemeCount(statement) > 80 || !/[\p{L}\p{N}]/u.test(statement)) return wx.showToast({ title: '这句话需要 2–80 个字', icon: 'none' });
      if (!alias || graphemeCount(alias) > 12) return wx.showToast({ title: '称呼需要 1–12 个字', icon: 'none' });
      if (!this.data.opensAt || Date.parse(this.data.opensAt) < Date.now() + MIN_OPEN_DELAY_MS) return wx.showToast({ title: '开封时间须在 10 分钟后', icon: 'none' });
      const id = this.data.currentId || requestId();
      this.setData({ currentId: id });
      this.triggerEvent('submit', { statement, alias, opens_at: this.data.opensAt, client_request_id: id });
    },
    reset() { this.setData({ statement: '', statementCount: 0, selected: '', date: '', time: '', displayTime: '', opensAt: '', currentId: '' }); }
  }
});
