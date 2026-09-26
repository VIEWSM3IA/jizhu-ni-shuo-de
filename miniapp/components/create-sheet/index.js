const { requestId } = require('../../services/util');
Component({
  properties: { show: Boolean, defaultAlias: String, busy: Boolean, error: String },
  data: { visible: false, statement: '', alias: '', selected: '', date: '', time: '', displayTime: '', currentId: '' },
  observers: {
    'defaultAlias': function(value) { if (value && !this.data.alias) this.setData({ alias: value }); },
    'show': function(value) {
      clearTimeout(this.closeTimer);
      if (value) this.setData({ visible: true });
      else this.closeTimer = setTimeout(() => this.setData({ visible: false }), 210);
    }
  },
  methods: {
    close() { if (!this.data.busy) this.triggerEvent('close'); },
    noop() {},
    onStatement(e) { this.setData({ statement: e.detail.value, currentId: '' }); },
    onAlias(e) { this.setData({ alias: e.detail.value, currentId: '' }); },
    choose(e) {
      const kind = e.currentTarget.dataset.kind;
      const d = new Date();
      if (kind === 'tonight') d.setHours(23,59,0,0);
      if (kind === 'day') d.setDate(d.getDate()+1);
      if (kind === 'week') d.setDate(d.getDate()+7);
      if (kind === 'custom') { this.setData({ selected: kind }); return; }
      this.setData({ selected: kind, displayTime: `${d.getMonth()+1} 月 ${d.getDate()} 日 ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`, opensAt: d.toISOString(), currentId: '' });
    },
    onDate(e) { this.setData({ date: e.detail.value, currentId: '' }); this.updateCustom(); },
    onTime(e) { this.setData({ time: e.detail.value, currentId: '' }); this.updateCustom(); },
    updateCustom() {
      if (!this.data.date || !this.data.time) return;
      const d = new Date(`${this.data.date}T${this.data.time}:00`);
      this.setData({ selected: 'custom', opensAt: d.toISOString(), displayTime: `${this.data.date} ${this.data.time}` });
    },
    submit() {
      if (this.data.busy) return;
      const id = this.data.currentId || requestId();
      this.setData({ currentId: id });
      this.triggerEvent('submit', { statement: this.data.statement, alias: this.data.alias, opens_at: this.data.opensAt, client_request_id: id });
    },
    reset() { this.setData({ statement: '', selected: '', date: '', time: '', displayTime: '', currentId: '' }); }
  }
});
