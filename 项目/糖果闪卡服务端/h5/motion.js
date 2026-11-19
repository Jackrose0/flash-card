(function setupMotion(){
  'use strict';
  const {render,revealDuration,dimensions,sources,cardFace,createCardRenderer}=CardEngine;
  const images=new Map(),loading=new Map();
  function load(src,cache=images,pending=loading){
    if(cache.has(src))return Promise.resolve();
    if(!pending.has(src)){
      const promise=new Promise((resolve,reject)=>{
        const img=new Image();img.onload=()=>{cache.set(src,img);resolve();};
        img.onerror=()=>reject(Error('卡图加载失败，请重试'));img.src=src;
      }).finally(()=>pending.delete(src));
      pending.set(src,promise);
    }
    return pending.get(src);
  }
  function surface(canvas,w,h,cache=images){
    const scale=Math.min(devicePixelRatio||1,2);
    canvas.width=Math.max(1,Math.round(w*scale));canvas.height=Math.max(1,Math.round(h*scale));
    const ctx=canvas.getContext('2d');ctx.setTransform(scale,0,0,scale,0,0);
    return {canvas,ctx,images:cache,w,h};
  }
  const skins=[{id:'peach',color:'#f7dce4'},{id:'pudding',color:'#dbece2'},{id:'whale',color:'#e4dff3'}];
  function pack(root,pool,{api,escape,toast}){
    const key='candy.pending.'+pool.id;
    const stored=JSON.parse(sessionStorage.getItem(key)||'null');
    const skin=pool.pack||skins.find(s=>s.id===stored?.skin)||skins[Math.floor(Math.random()*skins.length)];
    const bytes=crypto.getRandomValues(new Uint32Array(4));
    const requestId=stored?.requestId||Array.from(bytes,n=>n.toString(16).padStart(8,'0')).join('');
    const m={pack:skin,p:0,dir:1,born:[],cards:[],flips:[],openAt:null,targets:[]};
    root.innerHTML=`<section class="stage pack-view" style="--pool:${skin.color}"><div class="pack-title"><a class="back" href="#home">‹ 卡池</a><strong>${escape(pool.name)}</strong></div><canvas class="scene" aria-label="拆包画布"></canvas><footer class="stage-foot"><p role="status">正在取卡包…</p><div class="row"><button class="pill" disabled>一键拆包</button><a class="soft" hidden href="#album">查看卡组</a></div></footer></section>`;
    const canvas=root.querySelector('canvas'),hint=root.querySelector('p'),button=root.querySelector('button'),album=root.querySelector('[href="#album"]');
    const title=root.querySelector('.pack-title');
    let s,bounds,drag,frame,autoTear,dead=false,busy=false,ready=false,revealed=false;
    const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
    function draw(){
      frame=0;if(dead||!s||!ready)return;
      const now=performance.now();
      if(autoTear){
        const u=Math.min(1,(now-autoTear.at)/autoTear.duration);
        m.p=autoTear.from+(1-autoTear.from)*u*u*(3-2*u);
        if(u===1){autoTear=null;open();}
      }
      bounds=render(s,m,now);
      if(m.openAt!==null&&now-m.openAt>=revealDuration(m.cards.length)&&!revealed){
        revealed=true;hint.textContent='已获得 '+m.cards.length+' 张';canvas.setAttribute('aria-label','点卡片翻面');
        button.disabled=false;button.textContent='再拆一包';album.hidden=false;
      }
      if(!revealed||m.flips.some(f=>f&&now-f.at<450))frame=requestAnimationFrame(draw);
    }
    function redraw(){if(!frame&&!dead)frame=requestAnimationFrame(draw);}
    const resize=new ResizeObserver(()=>{
      const box=canvas.getBoundingClientRect();
      m.resultTop=title.getBoundingClientRect().bottom-box.top+14;
      s=surface(canvas,box.width,box.height);redraw();
    });resize.observe(canvas);
    async function open(){
      if(busy||revealed)return;
      busy=true;drag=null;button.disabled=true;hint.textContent='正在拆包…';
      try{
        sessionStorage.setItem(key,JSON.stringify({skin:skin.id,requestId}));
        const res=await api('draws','POST',{pool:pool.id,skin:skin.id,requestId,thumbnails:true});
        if(dead)return;
        await Promise.all(res.cards.flatMap(sources).map(src=>load(src)));
        if(dead)return;
        m.p=1;m.cards=res.cards;
        m.openAt=performance.now()-(reduced?revealDuration(m.cards.length):0);
        hint.textContent='';sessionStorage.removeItem(key);redraw();
      }catch(e){if(dead)return;busy=false;button.disabled=false;button.textContent='重试拆包';hint.textContent=e.message;redraw();}
    }
    async function start(){
      try{await load(skin.src||'/assets/'+skin.id+'-pack.png');if(dead)return;
        ready=true;button.disabled=false;hint.textContent='按住卡包，向一侧撕开';redraw();
        if(stored)open();
      }catch(e){if(dead)return;hint.textContent=e.message;button.disabled=false;button.textContent='重新加载';}
    }
    function finishTear(){
      if(reduced||m.p===1){m.p=1;open();return;}
      drag=null;button.disabled=true;hint.textContent='';
      autoTear={at:performance.now(),from:m.p,duration:m.p?180:430};redraw();
    }
    button.onclick=()=>{
      if(revealed){cleanup();window.dispatchEvent(new HashChangeEvent('hashchange'));return;}
      if(!ready){start();return;}
      finishTear();
    };
    function point(e){const r=canvas.getBoundingClientRect();return {x:e.clientX-r.left,y:e.clientY-r.top};}
    canvas.onpointerdown=e=>{
      if(e.button!==0||!bounds||drag||autoTear||(!revealed&&busy))return;
      const {x,y}=point(e),b=bounds;
      if(!revealed&&(x<b.bx-8||x>b.bx+b.bw+8||y<b.by-8||y>b.by+b.bh+8))return;
      canvas.setPointerCapture(e.pointerId);drag={x,y,p:m.p,id:e.pointerId};
    };
    canvas.onpointermove=e=>{
      if(!drag||drag.id!==e.pointerId||revealed)return;
      const pt=point(e),dx=pt.x-drag.x;
      if(!m.p){if(Math.abs(dx)<6||Math.abs(dx)<Math.abs(pt.y-drag.y)*.55)return;m.dir=Math.sign(dx);}
      m.p=Math.max(m.p,Math.min(1,drag.p+dx*m.dir/(bounds.sealRight-bounds.sealLeft)));
      if(m.p>=1)open();
    };
    canvas.onpointerup=e=>{
      if(!drag||drag.id!==e.pointerId)return;
      const pt=point(e),g=drag;drag=null;
      if(!revealed){
        if(m.p>=.55)finishTear();
        else if(m.p>0)hint.textContent='继续横向撕开';
        return;
      }
      if(Math.hypot(pt.x-g.x,pt.y-g.y)>16)return;
      const hit=m.targets.slice().reverse().find(o=>{
        const dx=pt.x-o.x,dy=pt.y-o.y,c=Math.cos(o.angle),s=Math.sin(o.angle);
        return Math.abs(dx*c+dy*s)<o.w/2&&Math.abs(dy*c-dx*s)<o.h/2;
      });
      if(hit){const last=m.flips[hit.i],now=performance.now();if(last&&now-last.at<420)return;
        const from=last?last.to:1;m.flips[hit.i]={from,to:1-from,at:now-(reduced?420:0)};redraw();}
    };
    canvas.onpointercancel=()=>{drag=null;};
    function cleanup(){dead=true;resize.disconnect();cancelAnimationFrame(frame);}
    start();return cleanup;
  }
  function viewer(box,initial,{preview=false,settings=()=>[0,.15],onReady=()=>{},onError=()=>{}}={}){
    const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
    const cache=preview?new Map():images,pending=preview?new Map():loading;
    let canvas=box.querySelector('canvas'),c=initial,ratio=dimensions(c.ratio);
    let renderer,flat,cardWidth,dead=false,frame,drag,ready=false,revision=0;
    let x=c.dex?-5:-4,y=-9,tx=x,ty=y;
    function tick(){
      frame=0;if(dead||!ready)return;
      if(reduced){x=tx;y=ty;}
      else{x+=(tx-x)*.22;y+=(ty-y)*.22;}
      if(renderer)renderer.draw(x,y,c.dex ? .96 : .95,...settings());
      else{
        const {ctx,w,h}=flat;
        ctx.clearRect(0,0,w,h);ctx.save();ctx.translate(w/2,h/2);
        cardFace(ctx,cache,c,cardWidth,cardWidth/ratio,Math.cos(y*Math.PI/180)>=0);ctx.restore();
      }
      if(Math.abs(tx-x)+Math.abs(ty-y)>.08)frame=requestAnimationFrame(tick);
    }
    function redraw(){if(!frame&&!dead)frame=requestAnimationFrame(tick);}
    function flip(){tx=0;ty=180*Math.round(ty/180)+180;redraw();}
    function begin(e){
      if(drag||e.button!==0||(!preview&&(!ready||e.target!==canvas)))return;
      box.setPointerCapture(e.pointerId);
      drag={id:e.pointerId,x:e.clientX,y:e.clientY,rx:x,ry:y,moved:false};
    }
    box.onpointerdown=begin;
    box.onpointermove=e=>{
      if(!drag||drag.id!==e.pointerId)return;
      const dx=e.clientX-drag.x,dy=e.clientY-drag.y;
      if(Math.hypot(dx,dy)>4)drag.moved=true;
      if(drag.moved){tx=Math.min(48,Math.max(-48,drag.rx-dy*.33));ty=drag.ry+dx*.62;redraw();}
    };
    box.onpointerup=e=>{
      if(!drag||drag.id!==e.pointerId)return;
      if(!drag.moved)flip();else{tx=0;ty=180*Math.round(ty/180);redraw();}
      drag=null;
    };
    box.onpointercancel=()=>{drag=null;};
    function fit(){
      const w=Math.min(box.clientWidth,760),h=Math.min(box.clientHeight,860);
      if(!w||!h)return;
      cardWidth=Math.min(w*.88,h*.88*ratio,500);
      canvas.style.width=w+'px';canvas.style.height=h+'px';
      if(!ready)return;
      if(renderer){
        const scale=Math.min(devicePixelRatio||1,2);
        renderer.resize(Math.round(w*scale),Math.round(h*scale),cardWidth*scale);
      }else flat=surface(canvas,w,h,cache);
      redraw();
    }
    const size=new ResizeObserver(fit);size.observe(box);fit();
    async function update(next){
      const current=++revision;
      try{
        await Promise.all(sources(next).map(src=>load(src,cache,pending)));
        if(dead||current!==revision)return;
        c=next;ratio=dimensions(c.ratio);
        if(!flat){
          renderer?.dispose();renderer=null;
          const tex=document.createElement('canvas'),w=preview?360:600,h=Math.round(w/ratio);
          try{renderer=createCardRenderer(canvas,surface(tex,w,h,cache),c);}
          catch(_){
            const replacement=document.createElement('canvas');
            replacement.setAttribute('aria-label',canvas.getAttribute('aria-label'));
            canvas.replaceWith(replacement);canvas=replacement;
          }
        }
        ready=true;fit();onReady(!renderer);
      }catch(err){if(!dead&&current===revision)onError(err);}
    }
    update(initial);
    function dispose(){
      dead=true;size.disconnect();cancelAnimationFrame(frame);
      box.onpointerdown=box.onpointermove=box.onpointerup=box.onpointercancel=null;
      if(renderer){renderer.dispose();canvas.getContext('webgl')?.getExtension('WEBGL_lose_context')?.loseContext();}
    }
    return {begin,flip,redraw,update,dispose};
  }
  function card(root,c,{toast,download,standalone=false}){
    root.innerHTML=`<section class="stage"><header class="stage-head"><div class="stage-title">${standalone?'':'<a class="back" href="#album">‹ 卡组</a>'}<strong></strong></div></header><div class="viewer"><canvas aria-label="闪卡"></canvas></div><div class="stage-foot"><div class="settings"><label>景深 <input type="range" min="-30" max="30" step="1"><output></output></label><label>轮廓光 <input type="range" min="0" max="20" step="1"><output></output></label></div><div class="row"><button class="soft flip-card" disabled>翻面</button>${download?'<button class="soft download-card">下载互动卡</button>':''}</div></div></section>`;
    root.querySelector('.stage-title strong').textContent=c.name;
    const box=root.querySelector('.viewer'),inputs=root.querySelectorAll('input'),outputs=root.querySelectorAll('output');
    const flipButton=root.querySelector('.flip-card'),downloadButton=root.querySelector('.download-card');
    if(downloadButton)downloadButton.onclick=()=>download(downloadButton);
    const lightKey=c.dex?'timecard.light.kanto':'timecard.light';
    if(c.dex){
      inputs[0].min=-300;inputs[0].max=300;inputs[1].max=100;
      box.closest('.stage').style.setProperty('--pool','#e9e8d8');
    }
    const defaults=c.dex?[54,23]:[0,3];
    const prefs=standalone?defaults:JSON.parse(localStorage.getItem(lightKey))||defaults;
    inputs.forEach((el,i)=>{el.value=prefs[i];});
    function settings(){return [Number(inputs[0].value)/(c.dex?100:10),Number(inputs[1].value)/(c.dex?100:20)];}
    const display=viewer(box,c,{settings,onReady(flat){
      root.querySelector('.settings').hidden=flat;flipButton.disabled=false;
    },onError:err=>toast(err.message)});
    function adjust(){settings().forEach((n,i)=>outputs[i].textContent=String(n));display.redraw();}
    inputs.forEach(el=>{
      el.oninput=adjust;
      if(!standalone)el.onchange=()=>localStorage.setItem(lightKey,JSON.stringify([...inputs].map(i=>Number(i.value))));
    });adjust();
    flipButton.onclick=display.flip;
    return display.dispose;
  }
  window.motion={pack,card,viewer};
})();
