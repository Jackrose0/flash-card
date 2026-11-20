const store = require('../../lib/store');
const {report} = require('../../lib/files');

Page({
  data: {dev: store.dev, names: ['本机店主', '本机访客'], groups: [], roleName: '', distinct: 0, total: 0,
    openId: '', cards: [], nextOffset: 0, loading: false, failed: false},

  async onShow() {
    if (this.cardReturnScroll !== undefined) {
      wx.pageScrollTo({scrollTop: this.cardReturnScroll, duration: 0});
      this.cardReturnScroll = undefined;
      return;
    }
    try {
      const db = await store.readAlbum();
      store.syncNav(this);
      const groups = db.groups.map(group => ({...group, progress: group.total ? Math.round(group.found / group.total * 100) : 0}));
      this.setData({ready: true, who: db.who, roleName: {owner: '店主', maker: '制卡员'}[db.who.role] || '',
        whoIndex: wx.getStorageSync('candy.dev.identity') === 'guest' ? 1 : 0, groups, distinct: db.distinct, total: db.total});
      this.openGroup(groups.find(group => group.id === this.data.openId));
    } catch (error) {
      report(error);
    }
  },

  onPageScroll({scrollTop}) {
    this.scrollTop = scrollTop;
  },

  toggle(event) {
    const group = this.data.groups[event.currentTarget.dataset.index];
    this.openGroup(this.data.openId === group.id ? null : group);
  },

  openGroup(group) {
    this.pageRequest = null;
    this.setData({openId: group ? group.id : '', cards: [], nextOffset: group?.total ? 0 : null, loading: false, failed: false});
    if (group?.total) this.loadPage();
  },

  async loadPage() {
    const {openId, nextOffset, loading, cards} = this.data;
    if (!openId || loading || nextOffset === null) return;
    const page = store.albumPage(openId, nextOffset);
    this.pageRequest = page;
    this.setData({loading: true, failed: false});
    try {
      const result = await page;
      if (this.pageRequest === page) {
        this.setData({cards: cards.concat(result.cards), nextOffset: result.nextOffset, loading: false});
      }
    } catch (_) {
      if (this.pageRequest === page) this.setData({loading: false, failed: true});
    }
  },

  identity(event) {
    this.openGroup(null);
    store.enter(+event.detail.value ? 'guest' : 'owner');
    this.onShow();
  },

  copyId() {
    wx.setClipboardData({data: this.data.who.id});
  },

  packs() {
    wx.switchTab({url: '/pages/packs/index'});
  },

  detail(event) {
    const scrollTop = this.scrollTop || 0;
    wx.navigateTo({
      url: '/pages/card/index?id=' + encodeURIComponent(event.currentTarget.dataset.id),
      success: () => { this.cardReturnScroll = scrollTop; }
    });
  }
});
