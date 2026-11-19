Component({
  properties: {roleName: String},
  lifetimes: {
    attached() {
      const capsule = wx.getMenuButtonBoundingClientRect();
      const window = wx.getWindowInfo();
      const status = window.statusBarHeight || 0;
      const top = capsule.top || status + 4;
      this.setData({
        top,
        height: capsule.height || 32,
        end: capsule.left > 0 ? window.windowWidth - capsule.left + 8 : 104
      });
    }
  }
});
