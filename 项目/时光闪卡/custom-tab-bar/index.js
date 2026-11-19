const store=require('../lib/store');
const tabs=[
  {name:'抽奖',path:'pages/packs/index'},
  {name:'我的卡组',path:'pages/album/index'},
  {name:'管理',path:'pages/studio/index'}
];
Component({
  data:{tabs:[],route:''},
  lifetimes:{attached(){this.refresh();}},
  methods:{
    refresh(route){
      const pages=getCurrentPages(),active=route || (pages.length && pages[pages.length-1].route);
      const canManage=store.role()!=='user';
      this.setData({tabs:canManage?tabs:tabs.slice(0,2),route:active});
    },
    go(e){const route=e.currentTarget.dataset.path;if(route!==this.data.route)wx.switchTab({url:'/'+route});}
  }
});