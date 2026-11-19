const {serverOrigin,previewKey}=require('./config');
const dev=!serverOrigin;
const origin=(serverOrigin||'http://127.0.0.1:8765').replace(/\/$/,'');
const sessionKey='candy.api.session.'+origin;
const packs=[
  {id:'peach',name:'桃桃兔',color:'#f4dfdf',ink:'#af426c'},
  {id:'pudding',name:'布丁蛙',color:'#dcece2',ink:'#397e69'},
  {id:'whale',name:'泡泡鲸',color:'#e7e1f3',ink:'#7661a7'}
];
const ratios=['5x7','1x1','7x5'];
let handshake=null, snapshot=null;
function id(){return Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10);}
function request(path,method,data,token,file){
  return new Promise((resolve,reject)=>{
    const options={url:origin+'/api'+path,header:token?{Authorization:'Bearer '+token}:{},
      fail:()=>reject(Error('连接不到闪卡服务器，请检查网络后重试')),
      success:r=>{
        let payload=r.data;
        if(typeof payload==='string'){try{payload=JSON.parse(payload);}catch(_){payload={};}}
        if(r.statusCode>=200 && r.statusCode<300)resolve(payload);
        else {const error=Error(payload.error||'服务器请求失败');error.status=r.statusCode;reject(error);}
      }};
    if(file)wx.uploadFile({...options,filePath:file,name:'file'});
    else wx.request({...options,method,data});
  });
}
async function signIn(){
  if(dev && wx.getDeviceInfo().platform!=='devtools')throw Error('当前版本连接电脑上的开发服务，请在微信开发者工具中打开');
  const credentials=previewKey?{previewKey}:dev?{dev:wx.getStorageSync('candy.dev.identity')||'owner'}:
    {code:await new Promise((ok,fail)=>wx.login({success:r=>r.code?ok(r.code):fail(Error('微信登录失败')),fail:()=>fail(Error('微信登录失败'))}))};
  const {token}=await request('/login','POST',credentials);
  wx.setStorageSync(sessionKey,token);return token;
}
function login(){
  if(!handshake)handshake=signIn().finally(()=>{handshake=null;});
  return handshake;
}
async function authorized(send){
  const token=wx.getStorageSync(sessionKey)||await login();
  try{return await send(token);}
  catch(e){
    if(e.status!==401)throw e;
    if(wx.getStorageSync(sessionKey)===token)wx.removeStorageSync(sessionKey);
    return send(wx.getStorageSync(sessionKey)||await login());
  }
}
function api(path,method='GET',data,file){
  return authorized(token=>request(path,method,data,token,file));
}
function downloadCard(cardId){
  return authorized(token=>new Promise((resolve,reject)=>wx.downloadFile({
    url:`${origin}/api/cards/${encodeURIComponent(cardId)}/file`,
    header:{Authorization:'Bearer '+token},
    success(r){
      if(r.statusCode===200){resolve(r.tempFilePath);return;}
      const error=Error(r.statusCode===403?'当前账号没有下载互动卡权限':'无法生成互动卡文件，请重试');
      error.status=r.statusCode;reject(error);
    },
    fail:()=>reject(Error('互动卡文件下载失败，请检查网络后重试'))
  })));
}
function displaySrc(path){return path.startsWith('/media/')||path.startsWith('/h5/')||path.startsWith('/thumb/')?origin+path:path;}
function wireSrc(path){return path.startsWith(origin+'/')?path.slice(origin.length):path;}
function cardURLs(c){return {...c,subject:displaySrc(c.subject),frame:displaySrc(c.frame),background:displaySrc(c.background),back:displaySrc(c.back||''),special:!!c.special};}
async function read(){
  const db=await api('/state');
  db.cards=db.cards.map(cardURLs);
  for(const pool of db.pools)if(pool.pack)pool.pack.src=displaySrc(pool.pack.src);
  for(const item of [...db.frames,...db.backgrounds])item.src=displaySrc(item.src);
  snapshot=db;return db;
}
async function readAlbum(){
  const album=await api('/album');
  snapshot=album;return album;
}
async function albumPage(pool,offset){
  const page=await api('/album/'+encodeURIComponent(pool)+'/cards?offset='+offset);
  return {...page,cards:page.cards.map(cardURLs)};
}
function role(){return snapshot?snapshot.who.role:'user';}
function syncNav(page){const bar=page.getTabBar && page.getTabBar();if(bar&&bar.refresh)bar.refresh(page.route);}
function enter(who){if(!dev)return;wx.setStorageSync('candy.dev.identity',who);wx.removeStorageSync(sessionKey);snapshot=null;}
function randomPack(){return packs[Math.floor(Math.random()*packs.length)];}
async function draw(pool,skin,requestId){const r=await api('/draws','POST',{pool,skin,requestId,thumbnails:true});return r.cards.map(cardURLs);}
module.exports={packs,ratios,id,dev,api,read,readAlbum,albumPage,role,syncNav,enter,randomPack,draw,wireSrc,downloadCard};
