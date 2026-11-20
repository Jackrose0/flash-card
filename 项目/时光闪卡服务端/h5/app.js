(function app(){
  'use strict';
  const root=document.querySelector('#app'),
    topActions=document.querySelector('#top-actions'),
    dotNav=document.querySelector('#dot-nav'),notice=document.querySelector('#notice');
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let loginTask,token='',development=false,dispose=()=>{},generation=0,timer;
  let albumView,albumReturn;
  const devIdentity=()=>localStorage.getItem('candy.dev.identity')||'owner';
  function toast(message){clearTimeout(timer);notice.textContent=message;notice.hidden=false;timer=setTimeout(()=>notice.hidden=true,3300);}
  async function request(path,method,data,auth,asFile){
    const file=data instanceof FormData,headers={};
    if(auth)headers.Authorization='Bearer '+auth;
    if(data&&!file)headers['Content-Type']='application/json';
    const response=await fetch('/api/'+path,{method,headers,body:file?data:data?JSON.stringify(data):undefined,cache:'no-store'});
    if(asFile&&response.ok)return response.blob();
    const payload=await response.json().catch(()=>({}));
    if(!response.ok){
      const missingFileRoute=asFile&&response.status===404&&(!payload.error||payload.error.startsWith('The requested URL'));
      const message=missingFileRoute?'当前服务器需要更新后才能下载互动卡':payload.error;
      throw Object.assign(Error(message||'请求失败，请稍后重试'),{...payload,status:response.status});
    }
    return payload;
  }
  async function login(){
    if(!loginTask)loginTask=request('web/login','POST',{dev:devIdentity()}).then(r=>{
      development=r.dev;
      return token=r.token;
    }).finally(()=>loginTask=null);
    return loginTask;
  }
  async function api(path,method='GET',data,asFile=false){
    const current=token||await login();
    try{return await request(path,method,data,current,asFile);}
    catch(e){if(e.status!==401)throw e;return request(path,method,data,await login(),asFile);}
  }
  async function encodePreviewSubject(subject){
    const image=await createImageBitmap(subject).catch(()=>null);
    if(!image)return null;
    const scale=Math.min(1,1600/Math.max(image.width,image.height));
    const canvas=document.createElement('canvas');
    canvas.width=Math.max(1,Math.round(image.width*scale));
    canvas.height=Math.max(1,Math.round(image.height*scale));
    const context=canvas.getContext('2d');
    context.imageSmoothingQuality='high';
    context.drawImage(image,0,0,canvas.width,canvas.height);
    image.close();
    return new Promise(resolve=>canvas.toBlob(resolve,'image/webp',.95));
  }
  async function downloadCard(button,card,subject){
    button.disabled=true;button.textContent='正在生成…';
    try{
      let file;
      if(subject){
        const preview=await encodePreviewSubject(subject);
        if(!preview){
          if(button.isConnected)toast('无法生成卡片图片，请重新选图');
          return;
        }
        const data=new FormData();
        data.append('file',preview);
        for(const key of ['name','ratio','color','special','frame','background','back'])data.append(key,card[key]);
        file=await api('cards/preview-file','POST',data,true);
      }else file=await api(`cards/${encodeURIComponent(card.id)}/file`,'GET',undefined,true);
      const url=URL.createObjectURL(file),link=document.createElement('a');
      link.href=url;link.download=card.name+'-互动闪卡.html';
      document.body.append(link);link.click();link.remove();
      setTimeout(()=>URL.revokeObjectURL(url),30000);
    }catch(e){if(button.isConnected)toast(e.status?e.message:'下载失败，请重试');}
    finally{button.disabled=false;button.textContent='下载互动卡';}
  }
  function face(c,thumbnail=false){
    if(!c)return '';
    const image=(s,cls)=>s?`<img src="${escape(thumbnail?'/thumb'+s:s)}" class="${cls}" alt="" loading="lazy" decoding="async" draggable="false">`:'';
    const print=c.dex?`<svg class="dex-print" viewBox="0 0 500 700" aria-hidden="true"><text x="437" y="46" text-anchor="middle" font-family="monospace" font-size="21" font-weight="bold">#${String(c.dex).padStart(3,'0')}</text><text x="395" y="677" text-anchor="end" font-family="Georgia,serif" font-size="16" font-style="italic">${escape(c.english)}</text><text x="50" y="637" font-family="sans-serif" font-size="47.5" font-weight="bold">${escape(c.name)}</text></svg>`:'';
    return `<span class="card-face" style="--ratio:${escape(c.ratio.replace('x','/'))};--color:${escape(c.color)}">${image(c.background,'bg')}${image(c.subject,'subject')}${image(c.frame,'frame')}${print}</span>`;
  }
  const navNames={home:'抽奖',album:'我的卡组',studio:'管理'};
  function navItem(id,name,page){return `<a href="#${id}" class="${id===page?'active':''}" ${id===page?'aria-current="page"':''}>${name}</a>`;}
  function renderTopActions(who={}){
    const badge=who.role==='owner'?'店主':who.role==='maker'?'制卡员':'';
    return `${badge?`<span class="role-badge ${who.role}"><span class="dot"></span>${badge}</span>`:''}
      ${development?`<button class="icon-btn" id="dev-switch" title="切换本机身份"><svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16"/><circle cx="9" cy="7" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="9" cy="17" r="2"/></svg></button>`:''}`;
  }

  function showUsername(){
    root.innerHTML=`<div class="page-head"><h1>设置用户名</h1></div>
      <div class="studio studio-card studio-body username-panel">
        <form><label>用户名<input name="name" required maxlength="24" autocomplete="username" aria-describedby="username-error"></label>
          <p id="username-error" role="alert" hidden></p><button class="pill" type="submit">进入时光闪卡</button>
        </form>
      </div>`;
    const form=root.querySelector('form');
    const {name}=form.elements,button=form.querySelector('button'),error=root.querySelector('#username-error');
    name.focus();
    name.oninput=()=>{error.hidden=true;name.removeAttribute('aria-invalid');};
    form.onsubmit=async event=>{
      event.preventDefault();
      if(button.disabled)return;
      button.disabled=true;
      try{
        await api('profile/username','POST',{name:name.value});
        if(form.isConnected)route();
      }catch(err){
        if(!form.isConnected)return;
        if(err.status===403){route();return;}
        error.textContent=err.message;error.hidden=false;
        name.setAttribute('aria-invalid','true');name.focus();
      }finally{button.disabled=false;}
    };
  }
  function wireTopActions(){
    const sw=topActions.querySelector('#dev-switch');
    if(sw)sw.onclick=()=>{
      const next=devIdentity()==='owner'?'guest':'owner';
      localStorage.setItem('candy.dev.identity',next);
      token='';loginTask=null;
      albumReturn=null;
      toast(next==='owner'?'已切换为本机店主':'已切换为本机访客');
      route();
    };
  }

  // ---------- 首页：卡池卡包展示 ----------
  const packSkins=['/assets/peach-pack.png','/assets/pudding-pack.png','/assets/whale-pack.png'];
  function homePacks(db){
    return db.pools.map((p,i)=>({...p,src:'/thumb'+(p.pack?.src||packSkins[i%packSkins.length])}));
  }
  function home(items,db){
    return `<div class="page-head draw-head"><h1>抽卡中心</h1><div class="draw-wallet"><strong data-dust aria-live="polite">✦ ${db.stardust} 星尘</strong><button class="soft" type="button" data-checkin ${db.checkedIn?'disabled':''}>${db.checkedIn?'今日已签到':`签到 +${db.checkinReward}`}</button><span data-dust-warning ${db.stardust>=db.drawCost?'hidden':''}>星尘不足</span></div></div>
    ${db.privatePools.length?`<details class="private-pools"><summary>我的测试卡池</summary><div>${db.privatePools.map(p=>`<a class="soft" href="#test/${encodeURIComponent(p.id)}">${escape(p.name)}</a>`).join('')}</div></details>`:''}
    ${!items.length?'<div class="empty"><p>暂无公开卡池</p></div>':`<div class="pack-carousel">
      <div class="pack-stage" id="pack-stage">${items.map(it=>`<button class="pack-item" aria-label="${escape(it.name)}"><span class="pack-art"></span></button>`).join('')}</div>
      <div class="pack-dots" id="pack-dots" role="group" aria-label="选择卡池">${items.map(it=>`<button aria-label="${escape(it.name)}"></button>`).join('')}</div>
      <div class="pack-foot" id="pack-foot" aria-live="polite"></div>
    </div>`}`;
  }
  function wireCarousel(items,drawCost){
    if(!items.length)return ()=>{};
    const stage=root.querySelector('#pack-stage'),foot=root.querySelector('#pack-foot'),dots=root.querySelector('#pack-dots');
    const packEls=[...stage.querySelectorAll('.pack-item')];
    const artSlots=[...stage.querySelectorAll('.pack-art')];
    const dotEls=[...dots.querySelectorAll('button')];
    const total=items.length;
    const visibleLimit=Math.min(5,Math.max(1.5,total/2));
    const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
    const wrap=n=>(n%total+total)%total;
    const distance=n=>{const offset=wrap(n);return offset>total/2?offset-total:offset;};
    const unit=n=>Math.max(0,Math.min(1,n));
    let idx=-1,position=0,target=0,frame=0,lastFrame=0,wheelEnd,drag,suppressClick=false;
    let fanRadius,angleStep,packHeight,stageWidth,dragStep;

    function render(){
      const nearest=Math.round(position);
      packEls.forEach((el,i)=>{
        const off=distance(i-position);
        const a=Math.abs(off);
        const art=artSlots[i];
        if(a<=2.5&&!art.firstElementChild){
          const img=new Image();
          img.alt='';img.decoding='async';img.draggable=false;img.src=items[i].src;
          art.append(img);
        }
        const angle=off*angleStep;
        const lateral=Math.sin(angle);
        const x=fanRadius*lateral;
        const y=fanRadius*(1-Math.cos(angle));
        const centerX=(fanRadius+packHeight/2)*lateral;
        const edge=unit((Math.abs(centerX)/stageWidth-.27)/.34);
        const wrapFade=unit((visibleLimit-a)/.5);
        el.style.transform=`translate(calc(-50% + ${x}px), ${y}px) rotate(${angle}rad)`;
        el.style.opacity=art.firstElementChild?String(Math.max(0,1-a*.1)*(1-edge*edge*(3-2*edge))*wrapFade):'0';
        el.style.zIndex=String(1000-Math.round(a*100));
      });
      const next=wrap(nearest);
      if(next===idx)return;
      idx=next;
      packEls.forEach((el,i)=>{
        el.classList.toggle('active',i===idx);
        el.classList.toggle('adjacent',Math.abs(distance(i-idx))===1);
        el.tabIndex=i===idx?0:-1;
      });
      const cur=items[idx];
      foot.innerHTML=`<div class="pack-name">${escape(cur.name)}</div><div class="pack-meta">${cur.count} 款卡片 · 每发 ${cur.cardsPerPack} 张 · ${drawCost} 星尘</div>${cur.count?`<a class="pack-cta" href="#pack/${encodeURIComponent(cur.id)}">查看卡包</a>`:`<span class="pack-cta" style="opacity:.5">暂不可拆</span>`}`;
      dotEls.forEach((b,i)=>{b.setAttribute('aria-pressed',i===idx);b.tabIndex=i===idx?0:-1;});
    }

    function measure(){
      const bottom=parseFloat(getComputedStyle(packEls[0]).bottom);
      stage.style.setProperty('--pack-limit',(stage.clientHeight-bottom)*5/7+'px');
      const packWidth=packEls[0].offsetWidth;
      packHeight=packEls[0].offsetHeight;
      stageWidth=stage.clientWidth;
      fanRadius=Math.max(stageWidth*.86,packWidth*2.25);
      angleStep=Math.asin(Math.min(stageWidth*.15,packWidth*.68)/fanRadius);
      dragStep=Math.min(120,stage.parentElement.clientWidth*.29);
      render();
    }
    function tick(now){
      frame=0;
      const dt=lastFrame?Math.min(32,now-lastFrame):1000/60;
      const delta=target-position;
      lastFrame=now;
      if(drag?.moving||reduced||Math.abs(delta)<.004)position=target;
      else position+=Math.sign(delta)*Math.min(Math.abs(delta)*(1-Math.exp(-dt/62)),dt/35);
      render();
      if(position!==target)frame=requestAnimationFrame(tick);
      else lastFrame=0;
    }
    function moveTo(next){
      target=next;
      if(!frame)frame=requestAnimationFrame(tick);
    }
    function select(i){
      clearTimeout(wheelEnd);
      moveTo(Math.round(position+distance(i-position)));
    }
    stage.addEventListener('wheel',e=>{
      if(e.ctrlKey||total<2||drag?.moving)return;
      const delta=Math.abs(e.deltaX)>Math.abs(e.deltaY)?e.deltaX:e.deltaY;
      if(!delta)return;
      e.preventDefault();
      const unit=e.deltaMode===1?32:e.deltaMode===2?stage.clientWidth:1;
      moveTo(target+delta*unit/105);
      clearTimeout(wheelEnd);
      wheelEnd=setTimeout(()=>moveTo(Math.round(target)),100);
    },{passive:false});
    stage.addEventListener('pointerdown',e=>{
      if(!e.isPrimary||e.button!==0)return;
      suppressClick=false;
      if(total<2)return;
      drag={id:e.pointerId,x:e.clientX,y:e.clientY,lastX:e.clientX,lastAt:e.timeStamp,velocity:0};
      e.target.setPointerCapture(e.pointerId);
    });
    stage.addEventListener('pointermove',e=>{
      if(drag?.id!==e.pointerId)return;
      const dx=e.clientX-drag.x;
      if(!drag.moving){
        if(Math.abs(dx)<7||Math.abs(dx)<Math.abs(e.clientY-drag.y))return;
        clearTimeout(wheelEnd);
        drag.origin=position;
        drag.moving=true;
        stage.setPointerCapture(e.pointerId);
      }
      const elapsed=Math.max(8,e.timeStamp-drag.lastAt);
      const speed=(drag.lastX-e.clientX)/elapsed;
      drag.velocity=drag.velocity*.35+speed*.65;
      drag.lastX=e.clientX;
      drag.lastAt=e.timeStamp;
      moveTo(drag.origin-dx/dragStep);
    });
    function endDrag(e){
      if(drag?.id!==e.pointerId)return;
      if(drag.moving){
        suppressClick=true;
        const quick=e.type==='pointerup'&&e.timeStamp-drag.lastAt<80;
        const coast=quick?Math.max(-1.25,Math.min(1.25,drag.velocity*95/dragStep)):0;
        moveTo(Math.round(target+coast));
      }
      drag=null;
    }
    stage.addEventListener('pointerup',endDrag);
    stage.addEventListener('pointercancel',endDrag);
    packEls.forEach((el,i)=>{
      el.addEventListener('click',e=>{
        if(suppressClick&&e.detail)return;
        if(i!==idx){select(i);return;}
        const cur=items[idx];
        if(cur.count)location.hash='#pack/'+encodeURIComponent(cur.id);
      });
    });
    dotEls.forEach((b,i)=>b.addEventListener('click',()=>select(i)));
    dots.onkeydown=e=>{
      if(e.key!=='ArrowLeft'&&e.key!=='ArrowRight')return;
      e.preventDefault();
      const next=wrap(dotEls.indexOf(e.target)+(e.key==='ArrowLeft'?-1:1));
      select(next);dotEls[next].focus();
    };
    const size=new ResizeObserver(measure);
    size.observe(stage);
    measure();
    return ()=>{size.disconnect();clearTimeout(wheelEnd);cancelAnimationFrame(frame);};
  }

  // ---------- 我的卡组：按卡池分组 ----------
  function album(db){
    const head=`<div class="page-head"><div><h1>我的卡组</h1><div class="sub">共 ${db.distinct} 款 · ${db.total} 张</div></div></div>`;
    if(!db.groups.length){
      root.innerHTML=head+'<div class="empty"><p>暂无收藏</p><a class="pill primary" href="#home">去抽卡</a></div>';
      return;
    }
    root.innerHTML=head+`<div class="pool-groups">${db.groups.map(({id,name,total,found})=>{
      const pct=total?Math.round(found/total*100):0;
      return `<details class="pool-group" data-pool="${escape(id)}">
        <summary class="pool-group-head" aria-label="${escape(name)}，已拥有 ${found} 款，共 ${total} 款">
          <span class="g-thumb" aria-hidden="true"></span>
          <span class="g-info"><strong>${escape(name)}</strong><span class="progress-track" aria-hidden="true"><i style="width:${pct}%"></i></span></span>
          <span class="g-count">${found} / ${total}${total&&found===total?'<small>已集齐</small>':''}</span>
          <span class="chev" aria-hidden="true">›</span>
        </summary>
        <div class="pool-group-body">
          ${total?'<div class="grid"></div><button type="button" class="soft album-more" data-offset="0" hidden>查看更多</button>':'<p class="album-empty">暂无卡片</p>'}
        </div>
      </details>`;
    }).join('')}</div>`;

    async function loadPage(button){
      if(button.disabled)return;
      const group=button.closest('.pool-group'),grid=group.querySelector('.grid');
      button.hidden=false;
      button.disabled=true;
      button.textContent='加载中…';
      try{
        const page=await api(`album/${encodeURIComponent(group.dataset.pool)}/cards?offset=${button.dataset.offset}`);
        grid.insertAdjacentHTML('beforeend',page.cards.map(c=>{
          const art=`<span class="tile-art">${face(c)}</span><b>${c.special?'✦ ':''}${escape(c.name)}</b><small>${c.tierName?escape(c.tierName)+' · ':''}${c.count?c.count+' 张':'未获得'}</small>`;
          return c.count?`<a class="tile" href="#card/${encodeURIComponent(c.id)}">${art}</a>`:`<article class="tile owned-none">${art}</article>`;
        }).join(''));
        button.dataset.offset=page.nextOffset??'';
        button.hidden=page.nextOffset===null;
        button.textContent='查看更多';
        if(!grid.childElementCount)grid.outerHTML='<p class="album-empty">暂无卡片</p>';
      }catch(err){
        button.textContent='重试';
        if(group.isConnected)toast(err.status?err.message:'卡片加载失败，请重试');
      }finally{button.disabled=false;}
    }
    function openGroup(event){
      const group=event.target;
      if(!group.matches('.pool-group[open]'))return;
      const button=group.querySelector('.album-more[data-offset="0"]');
      if(button)loadPage(button);
    }
    function loadMore(event){
      const button=event.target.closest('.album-more');
      if(button)loadPage(button);
    }
    const groups=root.querySelector('.pool-groups');
    groups.addEventListener('toggle',openGroup,true);
    groups.addEventListener('click',loadMore);
  }

  async function route(){
    const current=++generation;dispose();dispose=()=>{};
    const [page='home',id]=(location.hash.slice(1)||'home').split('/');
    if(page==='card'&&albumView)albumReturn={...albumView,scrollTop:root.scrollTop};
    albumView=null;
    const returning=page==='album'?albumReturn:null;
    if(page!=='card')albumReturn=null;
    const preview=page==='test';
    const immersive=page==='pack'||page==='card'||preview;
    document.body.classList.toggle('immersive',immersive);
    root.classList.remove('home-view');
    root.setAttribute('aria-busy','true');root.innerHTML='<div class="empty"><p>正在加载…</p></div>';dotNav.innerHTML='';topActions.innerHTML='';
    try{
      if(page==='card'&&!id)throw Error('卡册里还没有这张卡');
      const endpoint=preview?`pools/${id}/preview`:page==='card'?'cards/'+id:page==='studio'?'studio':page==='album'?'album':'home';
      const db=returning?.db??await api(endpoint);if(current!==generation)return;
      dotNav.innerHTML=Object.entries(navNames).map(([id,name])=>navItem(id,name,page)).join('');
      topActions.innerHTML=renderTopActions(db.who);
      wireTopActions();
      if(page==='pack'||preview){
        const pool=preview?db.pool:db.pools.find(p=>p.id===id);if(!pool?.count)throw Error('这个卡池暂时没有可抽的卡');
        dispose=window.motion.pack(root,pool,{api,escape,toast,preview,wallet:db});
      }else if(page==='card'){
        const c=db.card;
        const download=db.who.canDownloadCards?button=>downloadCard(button,c):undefined;
        dispose=window.motion.card(root,c,{toast,download});
      }else if(page==='studio')dispose=window.studio(root,db,{section:id,api,escape,toast,route,face,downloadCard});
      else if(page==='album'){
        if(returning)root.replaceChildren(...returning.nodes);
        else album(db);
        albumView={db,nodes:[...root.childNodes]};
      }
      else{
        const items=homePacks(db);
        root.innerHTML=home(items,db);
        root.classList.add('home-view');
        const checkin=root.querySelector('[data-checkin]');
        checkin.onclick=async()=>{
          checkin.disabled=true;
          try{
            const {stardust}=await api('checkin','POST');
            if(!checkin.isConnected)return;
            root.querySelector('[data-dust]').textContent=`✦ ${stardust} 星尘`;
            root.querySelector('[data-dust-warning]').hidden=stardust>=db.drawCost;
            checkin.textContent='今日已签到';
          }catch(error){checkin.disabled=false;toast(error.message);}
        };
        dispose=wireCarousel(items,db.drawCost);
      }
      root.setAttribute('aria-busy','false');
      if(!immersive)root.scrollTop=returning?.scrollTop??0;
    }catch(e){
      if(current!==generation)return;
      document.body.classList.remove('immersive');root.setAttribute('aria-busy','false');
      topActions.innerHTML=renderTopActions();
      wireTopActions();
      if(e.status===428){showUsername();return;}
      root.innerHTML=`<div class="err"><p>${escape(e.message)}</p><div class="actions"><button class="soft">重试</button><a class="pill" href="#home">返回卡池</a></div></div>`;
      root.querySelector('button').onclick=route;
    }
  }

  window.addEventListener('hashchange',route);route();
})();
