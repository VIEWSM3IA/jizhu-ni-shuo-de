App({
  globalData: { token: '', lastAlias: '' },
  onLaunch() {
    this.globalData.token = wx.getStorageSync('session_token') || '';
    this.globalData.lastAlias = wx.getStorageSync('last_alias') || '';
  },
  login(force = false) {
    if (this.loginPromise && !force) return this.loginPromise;
    this.loginPromise = new Promise((resolve, reject) => wx.login({ success: resolve, fail: reject }))
      .then(({ code }) => {
        if (!code) throw new Error('微信登录失败');
        const { apiBaseUrl } = require('./config');
        return new Promise((resolve, reject) => wx.request({
          url: `${apiBaseUrl}/v1/auth/wechat`, method: 'POST', data: { code },
          success: r => r.statusCode === 200 ? resolve(r.data) : reject(new Error(r.data?.error?.message || '登录失败')),
          fail: reject
        }));
      }).then(result => {
        this.globalData.token = result.token;
        this.globalData.lastAlias = result.profile.last_alias || '';
        wx.setStorageSync('session_token', result.token);
        wx.setStorageSync('last_alias', this.globalData.lastAlias);
        return result;
      }).finally(() => { this.loginPromise = null; });
    return this.loginPromise;
  }
});
