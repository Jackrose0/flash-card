Component({
  properties: {card: Object, gallery: Boolean},
  observers: {
    'card.dex'(dex) {
      this.setData({number: dex ? '#' + String(dex).padStart(3, '0') : ''});
    }
  }
});
