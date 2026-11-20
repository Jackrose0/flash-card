(function setupMotion(){
  'use strict';
  const {render,revealDuration,dimensions,sources,cardFace,createCardRenderer,inspectCard}=CardEngine;
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
  function pack(root,pool,{api,escape,toast,preview=false,wallet}){
    const drawCost=wallet.drawCost;
    const key=preview?null:'candy.draw.pending.'+wallet.who.id+'.'+pool.id;
    let pending=key?JSON.parse(sessionStorage.getItem(key)||'null'):null;
    const skin=pool.pack||skins.find(s=>s.id===pending?.skin)||skins[Math.floor(Math.random()*skins.length)];
    const m={pack:skin,p:0,dir:1,cards:[],flips:[],openAt:null,targets:[]};
    root.innerHTML=`<section class="stage pack-view" style="--pool:${skin.color}">
      <div class="pack-title"><a class="back" href="#home">‹ 卡池</a><strong>${escape(pool.name)}</strong>${preview?'<span class="test-label">私测</span>':''}</div>
      <canvas class="scene" aria-hidden="true"></canvas>
      <footer class="stage-foot"><p role="status">正在取卡包…</p>
        <div class="pack-wallet" data-wallet hidden><strong data-balance></strong><button class="soft" type="button" data-sign hidden></button></div>
        <div class="row"><a class="pill" hidden href="#album">查看卡组</a><button class="pill" data-open disabled>拆一包</button>
          <button class="soft" data-inspect hidden>逐张查看</button><button class="soft" data-again hidden></button></div>
      </footer>
      <dialog class="pack-inspector" aria-labelledby="pack-inspect-title">
        <div class="inspect-head"><h2 id="pack-inspect-title">逐张查看</h2><button class="soft" data-close autofocus>返回总览</button></div>
        <div class="inspect-art"><canvas aria-hidden="true"></canvas></div>
        <div class="inspect-info" role="status"></div>
        <div class="inspect-buttons"><button class="soft" data-previous>上一张</button><button class="pill" data-flip>看背面</button><button class="soft" data-next>下一张</button></div>
      </dialog>
    </section>`;
    const canvas=root.querySelector('.scene'),hint=root.querySelector('p'),button=root.querySelector('[data-open]'),album=root.querySelector('[href="#album"]');
    const walletBar=root.querySelector('[data-wallet]'),balance=root.querySelector('[data-balance]'),sign=root.querySelector('[data-sign]');
    const again=root.querySelector('[data-again]'),inspect=root.querySelector('[data-inspect]'),dialog=root.querySelector('.pack-inspector');
    const title=root.querySelector('.pack-title');
    let s,bounds,drag,frame,autoTear,response,signing=false,dead=false,busy=false,ready=false,revealed=false;
    const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
    const short=()=>!preview&&wallet.stardust<drawCost;
    const canTear=()=>ready&&!busy&&!revealed&&!pending&&!response&&!short();
    function refreshActions(message){
      walletBar.hidden=preview||revealed;
      if(!preview){
        balance.textContent=`余额 ${wallet.stardust} 星尘`;
        sign.hidden=!short()||!!pending||!!response;
        sign.disabled=wallet.checkedIn||signing;
        sign.textContent=wallet.checkedIn?'今日已签到':`签到 +${wallet.checkinReward}`;
      }
      button.disabled=busy||!ready||(!pending&&!response&&short());
      button.textContent=response?'重试加载':pending?'找回本次结果':preview?'测试拆包':`拆一包 · ${drawCost} 星尘`;
      hint.textContent=message||(pending?'上次拆包结果未确认':short()?`星尘不足 · 每发 ${drawCost} 星尘`:
        preview?`仅自己可见 · ${pool.cardsPerPack} 张/发`:'按住卡包，向一侧撕开');
    }
    function clearPending(){
      if(key)sessionStorage.removeItem(key);
      pending=null;
    }
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
        revealed=true;
        hint.textContent=(preview?'本次试抽 ':'已获得 ')+m.cards.length+' 张';
        button.hidden=true;walletBar.hidden=true;album.hidden=preview;
        inspect.hidden=false;again.hidden=false;again.textContent=preview?'再试一发':'再拆一包';
        if(preview)inspect.className='pill';
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
      if(busy||revealed||!ready||(!pending&&!response&&short()))return;
      const resumeOnly=!!pending;
      const requestId=pending?.requestId||Array.from(crypto.getRandomValues(new Uint32Array(4)),n=>n.toString(16).padStart(8,'0')).join('');
      const requestSkin=pending?.skin||skin.id;
      busy=true;drag=null;button.disabled=true;hint.textContent=resumeOnly?'正在找回结果…':'正在拆包…';
      if(key&&!pending){pending={skin:requestSkin,requestId};sessionStorage.setItem(key,JSON.stringify(pending));}
      try{
        response=response||await api('draws','POST',{pool:pool.id,skin:requestSkin,requestId,thumbnails:true,preview,resumeOnly});
        if(dead)return;
        if(!preview)wallet.stardust=response.stardust;
        await Promise.all(response.cards.flatMap(sources).map(src=>load(src)));
        if(dead)return;
        m.p=1;m.cards=response.cards;
        m.openAt=performance.now()-(reduced?revealDuration(m.cards.length):0);
        hint.textContent='';clearPending();redraw();
      }catch(e){
        if(!response&&e.status>=400&&e.status<500&&e.status!==408)clearPending();
        if(dead)return;
        if(Number.isFinite(e.stardust)){wallet.stardust=e.stardust;wallet.checkedIn=e.checkedIn;}
        busy=false;m.p=0;
        if(response&&!preview)album.hidden=false;
        refreshActions(response&&!preview?'已收入卡组，卡图加载失败':e.code==='insufficient_stardust'?'星尘不足 · 每发 '+drawCost+' 星尘':e.message);
        redraw();
      }
    }
    async function start(){
      try{await load(skin.src||'/assets/'+skin.id+'-pack.png');if(dead)return;
        ready=true;refreshActions();redraw();
      }catch(e){if(dead)return;hint.textContent=e.message;button.disabled=false;button.textContent='重新加载';}
    }
    function finishTear(){
      if(!canTear())return;
      if(reduced||m.p===1){m.p=1;open();return;}
      drag=null;button.disabled=true;hint.textContent='';
      autoTear={at:performance.now(),from:m.p,duration:m.p?180:430};redraw();
    }
    button.onclick=()=>{
      if(!ready){start();return;}
      if(pending||response)open();else finishTear();
    };
    again.onclick=()=>window.dispatchEvent(new HashChangeEvent('hashchange'));
    sign.onclick=async()=>{
      signing=true;refreshActions();
      try{const next=await api('checkin','POST');if(!dead)Object.assign(wallet,next);}
      catch(e){if(!dead)toast(e.message);}
      finally{signing=false;if(!dead)refreshActions();}
    };
    function point(e){const r=canvas.getBoundingClientRect();return {x:e.clientX-r.left,y:e.clientY-r.top};}
    canvas.onpointerdown=e=>{
      if(e.button!==0||!bounds||drag||autoTear||(!revealed&&!canTear()))return;
      const {x,y}=point(e),b=bounds;
      if(!revealed&&(x<b.bx-8||x>b.bx+b.bw+8||y<b.by-8||y>b.by+b.bh+8))return;
      canvas.setPointerCapture(e.pointerId);drag={x,y,p:m.p,id:e.pointerId};
    };
    canvas.onpointermove=e=>{
      if(!drag||drag.id!==e.pointerId||revealed)return;
      const pt=point(e),dx=pt.x-drag.x;
      if(!m.p){if(Math.abs(dx)<6||Math.abs(dx)<Math.abs(pt.y-drag.y)*.55)return;m.dir=Math.sign(dx);}
      m.p=Math.max(m.p,Math.min(1,drag.p+dx*m.dir/(bounds.sealRight-bounds.sealLeft)));
      if(m.p>=1){drag=null;open();}
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
    const inspectBox=dialog.querySelector('.inspect-art'),inspectCanvas=inspectBox.firstElementChild,meta=dialog.querySelector('.inspect-info');
    const previous=dialog.querySelector('[data-previous]'),next=dialog.querySelector('[data-next]'),flip=dialog.querySelector('[data-flip]');
    let look,lookCard,lookIndex,front,revision=0;
    function paint(){
      if(look&&lookCard)inspectCard(look,lookCard,front);
    }
    const lookResize=new ResizeObserver(()=>{
      if(!dialog.open)return;
      look=surface(inspectCanvas,inspectBox.clientWidth,inspectBox.clientHeight);paint();
    });
    lookResize.observe(inspectBox);
    async function choose(index){
      const current=++revision;
      lookIndex=(index+m.cards.length)%m.cards.length;
      lookCard=m.cards[lookIndex];front=true;flip.textContent='看背面';
      meta.textContent=`${lookIndex+1} / ${m.cards.length} · ${lookCard.name}${lookCard.tierName?' · '+lookCard.tierName:''}`;
      paint();
      const full={...lookCard};
      for(const field of ['subject','frame','background','back']){
        if(full[field]?.startsWith('/thumb/'))full[field]=full[field].slice(6);
      }
      try{
        await Promise.all(sources(full).map(src=>load(src)));
        if(current===revision&&dialog.open){lookCard=full;paint();}
      }catch(_){/* The current thumbnail remains available. */}
    }
    inspect.onclick=()=>{
      previous.disabled=next.disabled=m.cards.length<2;
      dialog.showModal();choose(0);
    };
    previous.onclick=()=>choose(lookIndex-1);
    next.onclick=()=>choose(lookIndex+1);
    flip.onclick=()=>{
      front=!front;flip.textContent=front?'看背面':'看正面';paint();
    };
    inspectCanvas.onclick=flip.onclick;
    dialog.querySelector('[data-close]').onclick=()=>dialog.close();
    dialog.onclose=()=>{revision++;look=null;inspect.focus();};
    dialog.onkeydown=e=>{
      if(m.cards.length<2||e.key!=='ArrowLeft'&&e.key!=='ArrowRight')return;
      e.preventDefault();choose(lookIndex+(e.key==='ArrowLeft'?-1:1));
    };
    function cleanup(){dead=true;revision++;resize.disconnect();lookResize.disconnect();cancelAnimationFrame(frame);}
    start();return cleanup;
  }
  function viewer(box,initial,{preview=false,settings=()=>[0,.15],onReady=()=>{},onError=()=>{}}={}){
    const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
    const cache=preview?new Map():images,pending=preview?new Map():loading;
    let canvas=box.querySelector('canvas'),c=initial,ratio=dimensions(c.ratio);
    let renderer,flat,cardWidth,dead=false,frame,drag,ready=false,revision=0;
    const initialPitch=preview?-9:c.dex?-5:-4,initialYaw=preview?-16:-9;
    let x=initialPitch,y=initialYaw,tx=x,ty=y;
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
    function resetPose(){x=tx=initialPitch;y=ty=initialYaw;redraw();}
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
      if(!drag.moved)flip();
      else if(!preview){tx=0;ty=180*Math.round(ty/180);redraw();}
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
    return {begin,flip,resetPose,redraw,update,dispose};
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
