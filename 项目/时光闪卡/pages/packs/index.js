const store = require('../../lib/store');

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const fallbackPacks = store.packs.map(pack => '/assets/' + pack.id + '-pack.png');

Page({
  data: {pools: [], poses: [], active: 0, loading: true, roleName: ''},

  onLoad() {
    this.position = this.target = 0;
  },

  async onShow() {
    try {
      const db = await store.read();
      store.syncNav(this);
      const cards = new Set(db.cards.map(card => card.id));
      const pools = [...db.pools].sort((a, b) => Number(b.id === 'kanto') - Number(a.id === 'kanto'))
        .map((pool, index) => ({
          id: pool.id,
          name: pool.name,
          count: pool.entries.filter(entry => entry.chance > 0 && cards.has(entry.id)).length,
          src: pool.pack?.src || fallbackPacks[index % fallbackPacks.length]
        }));
      const previous = pools.findIndex(pool => pool.id === this.data.pools[this.data.active]?.id);
      this.position = this.target = Math.max(0, previous);
      const roleName = {owner: '店主', maker: '制卡员'}[db.who.role] || '';
      this.setData({pools, roleName, cardsPerPack: db.cardsPerPack ?? 3, loading: false, error: ''}, () => this.measure());
    } catch (error) {
      this.setData({error: error.message, loading: false});
    }
  },

  onResize() {
    this.measure();
  },

  onHide() {
    clearTimeout(this.frame);
    this.frame = null;
    this.gesture = null;
    this.swiped = false;
  },

  onUnload() {
    this.onHide();
  },

  measure() {
    if (!this.data.pools.length) return;
    wx.createSelectorQuery().in(this).select('.fan-stage').boundingClientRect(stage => {
      if (!stage?.width || !stage.height) return;
      const packWidth = Math.floor(Math.min(stage.width * .54, stage.height * .67, 280));
      this.stageWidth = stage.width;
      this.packHeight = packWidth * 1.4;
      this.radius = Math.max(stage.width * .86, packWidth * 2.25);
      this.step = Math.asin(Math.min(stage.width * .16, packWidth * .68) / this.radius);
      this.dragStep = Math.min(108, stage.width * .24);
      this.setData({packWidth, packHeight: this.packHeight});
      this.paint();
    }).exec();
  },

  wrap(value) {
    const total = this.data.pools.length;
    return (value % total + total) % total;
  },

  distance(value) {
    const total = this.data.pools.length;
    const offset = this.wrap(value);
    return offset > total / 2 ? offset - total : offset;
  },

  paint() {
    const {pools, active} = this.data;
    const visibleLimit = Math.min(5, Math.max(1.5, pools.length / 2));
    const poses = pools.map((_, index) => {
      const offset = this.distance(index - this.position);
      const distance = Math.abs(offset);
      const angle = offset * this.step;
      const lateral = Math.sin(angle);
      const x = this.radius * lateral;
      const y = this.radius * (1 - Math.cos(angle));
      const centerX = (this.radius + this.packHeight / 2) * lateral;
      const edge = clamp((Math.abs(centerX) / this.stageWidth - .27) / .34, 0, 1);
      const seam = clamp((visibleLimit - distance) / .5, 0, 1);
      const opacity = Math.max(0, 1 - distance * .10) * (1 - edge * edge * (3 - 2 * edge)) * seam;
      return {
        style: 'transform:translate3d(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px,0) rotate(' +
          angle.toFixed(4) + 'rad);opacity:' + opacity.toFixed(3) + ';z-index:' + (1000 - Math.round(distance * 100)),
        hidden: opacity < .01
      };
    });
    const next = this.wrap(Math.round(this.position));
    this.setData(next === active ? {poses} : {poses, active: next});
  },

  moveTo(next) {
    this.target = next;
    if (this.frame != null) return;
    this.lastFrame = Date.now();
    const tick = () => {
      this.frame = null;
      const now = Date.now();
      const elapsed = clamp(now - this.lastFrame, 1, 32);
      const delta = this.target - this.position;
      this.lastFrame = now;
      if (this.gesture?.moving || Math.abs(delta) < .004) this.position = this.target;
      else this.position += Math.sign(delta) * Math.min(Math.abs(delta) * (1 - Math.exp(-elapsed / 62)), elapsed / 35);
      this.paint();
      if (this.position !== this.target) this.frame = setTimeout(tick, 16);
    };
    this.frame = setTimeout(tick, 16);
  },

  start(event) {
    if (this.gesture) return;
    this.swiped = false;
    if (this.data.pools.length < 2 || !this.dragStep) return;
    const touch = event.changedTouches[0];
    this.gesture = {id: touch.identifier, x: touch.clientX, y: touch.clientY,
      lastX: touch.clientX, lastAt: event.timeStamp, velocity: 0};
  },

  move(event) {
    const touch = event.changedTouches[0];
    const drag = this.gesture;
    if (!drag || touch.identifier !== drag.id) return;
    const dx = touch.clientX - drag.x;
    if (!drag.moving) {
      if (Math.abs(dx) < 7 || Math.abs(dx) < Math.abs(touch.clientY - drag.y)) return;
      drag.origin = this.position;
      drag.moving = this.swiped = true;
    }
    const elapsed = Math.max(8, event.timeStamp - drag.lastAt);
    drag.velocity = drag.velocity * .35 + (drag.lastX - touch.clientX) / elapsed * .65;
    drag.lastAt = event.timeStamp;
    drag.lastX = touch.clientX;
    this.moveTo(drag.origin - dx / this.dragStep);
  },

  end(event) {
    const drag = this.gesture;
    if (!drag || event.changedTouches[0].identifier !== drag.id) return;
    this.gesture = null;
    if (drag.moving) {
      const quick = event.type === 'touchend' && event.timeStamp - drag.lastAt < 80;
      const coast = quick ? clamp(drag.velocity * 95 / this.dragStep, -1.25, 1.25) : 0;
      this.moveTo(Math.round(this.target + coast));
    }
  },

  select(event) {
    const index = event.currentTarget.dataset.index;
    this.moveTo(Math.round(this.position + this.distance(index - this.position)));
  },

  tapPack(event) {
    if (this.swiped) return;
    if (event.currentTarget.dataset.index === this.data.active) this.open();
    else this.select(event);
  },

  open() {
    const pool = this.data.pools[this.data.active];
    if (pool?.count) wx.navigateTo({url: '/pages/open/index?pool=' + encodeURIComponent(pool.id)});
  }
});
