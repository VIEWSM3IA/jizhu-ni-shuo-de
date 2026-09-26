Component({
  properties: { show: Boolean, busy: Boolean, error: String },
  data: { alias: '', visible: false },
  observers: { 'show': function(value) {
    clearTimeout(this.closeTimer);
    if (value) this.setData({ visible: true });
    else this.closeTimer = setTimeout(() => this.setData({ visible: false }), 210);
  } },
  methods: {
    close() { if (!this.data.busy) this.triggerEvent('close'); },
    noop() {},
    input(e) { this.setData({ alias: e.detail.value }); },
    submit() { if (!this.data.busy) this.triggerEvent('submit', { alias: this.data.alias }); }
  }
});
