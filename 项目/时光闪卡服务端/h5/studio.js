window.studio=function studio(root,db,{section,api,escape:e,toast,route,face,downloadCard}){
  const owner=db.who.role==='owner';
  const statusLabels={draft:'草稿',pending:'待审核',approved:'已通过',returned:'已退回'};
  const poolEditable=p=>p.status!=='pending'&&(owner||p.status!=='approved');
  const ratesText=(pool,actual=false)=>pool.types.map(t=>`${t.name} ${Number(((actual?pool.actualRates[t.id]??0:t.rate)/100).toFixed(2))}%`).join(' · ');
  const actualRatesText=pool=>Object.keys(pool.actualRates).length?'实际 · '+ratesText(pool,true):'当前不可抽卡';
  const pages=[
    {id:'make',name:'合成闪卡',icon:'M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3z'},
    {id:'resources',name:'卡片素材',icon:'M4 5h16v14H4z M4 15l4-4 4 4 3-3 5 5 M15 9h.01'},
    {id:'pools',name:'卡池与概率',icon:'M4 5h16v14H4z M8 15v-2 M12 15v-5 M16 15V8'},
    {id:'review',name:'投稿审核',icon:'M5 5h14v14H5z M8 12l3 3 5-6'},
    {id:'roles',name:'用户权限',icon:'M12 3l7 3v5c0 4-2.7 7.2-7 10-4.3-2.8-7-6-7-10V6l7-3z M9 12l2 2 4-4'}
  ].slice(0,owner?5:3);
  const page=pages.find(item=>item.id===section);
  const head=(name,back=false)=>`<div class="page-head studio-head"><div>${back?'<a class="studio-back" href="#studio">‹ 管理</a>':''}<h1>${name}</h1></div></div>`;
  if(!page){
    root.innerHTML=head('管理')+`<nav class="studio-menu" aria-label="管理功能">${pages.map(item=>`<a class="studio-entry" href="#studio/${item.id}"><span class="studio-entry-icon ${item.id}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${item.icon}"/></svg></span><span>${item.name}</span><span class="studio-entry-arrow" aria-hidden="true">›</span></a>`).join('')}</nav>`;
    return ()=>{};
  }

  const options=(xs,key='id')=>xs.map(x=>`<option value="${e(x[key])}">${e(x.name)}</option>`).join('');
  const field=(label,content)=>`<label>${label}${content}</label>`;
  const input=(name,attrs='')=>`<input name="${name}" ${attrs}>`;
  const select=(name,html)=>`<select name="${name}">${html}</select>`;
  const typeOptions=(types,id)=>types.map(t=>`<option value="${e(t.id)}" ${t.id===id?'selected':''}>${e(t.name)}</option>`).join('');
  const typeRow=t=>`<div class="type-row" data-tier="${e(t.id)}"><input aria-label="类型名称" name="tierName" maxlength="18" required value="${e(t.name)}"><input aria-label="概率（%）" name="tierRate" type="number" min="0" max="100" step=".01" required value="${t.rate/100}"><span>%</span><button type="button" class="soft tiny" data-remove-tier>移除</button></div>`;
  const submit=(name,attrs='')=>`<button type="submit" class="pill" ${attrs}>${name}</button>`;
  const ratios='<option value="5x7">竖版 5:7</option><option value="7x5">横版 7:5</option><option value="1x1">方形 1:1</option>';
  const imageFile='type="file" accept="image/png,image/jpeg,image/webp"';
  const backs=db.backs||[];
  const packs=db.packs||[];
  const defaultBack={name:'默认渐变',src:'/h5/back-default.webp'};
  const layerNames={back:'卡背',background:'卡片背景',subject:'中层图片',frame:'上层卡框'};
  const statusBadge=status=>`<span class="submission-status ${status}">${statusLabels[status]}</span>`;

  function makePage(){
    const layerControl=(key,label)=>{
      const art=`<img data-layer="${key}" alt="" hidden><span class="layer-empty" aria-hidden="true"></span>`;
      return key==='subject'
        ?`<label class="layer-image layer-subject" title="添加中层图片">${art}${input('items',imageFile+' multiple form="make-form" aria-label="添加中层图片"')}</label>`
        :`<button type="button" class="layer-image layer-${key}" data-pick-layer="${key}" aria-label="选择${label}" aria-haspopup="dialog">${art}</button>`;
    };
    const slider=(id,name,value,range)=>`<label class="preview-slider"><span>${name}<output for="${id}">${value}</output></span><input id="${id}" type="range" value="${value}" ${range}></label>`;
    return `<div class="make-workbench">
      <section class="composition-pane" aria-labelledby="composition-heading">
        <div class="composition-head"><h2 id="composition-heading">预览</h2><button type="button" class="pill" data-compose-toggle aria-expanded="false" aria-controls="composition-controls">合成预览</button></div>
        <div class="composition-stage">
          <div class="composition-layers">${Object.entries(layerNames).map(([key,label],index)=>`<figure class="layer-sample" style="--offset:${index-1.5}">
            ${layerControl(key,label)}
            <figcaption>${label}</figcaption>
          </figure>`).join('')}</div>
          <div class="composition-viewport viewer" aria-hidden="true"><canvas aria-label="可拖动的合成闪卡"></canvas></div>
        </div>
        <div class="composition-controls" id="composition-controls" hidden>
          ${slider('subject-depth','主体景深',0,'min="-3" max="3" step=".1"')}
          ${slider('background-depth','背景景深',1,'min="-3" max="3" step=".1"')}
          ${slider('contour-light','轮廓光',15,'min="0" max="100" step="1"')}
          <button type="button" class="soft composition-flip" disabled>翻面</button>
        </div>
        <div class="composition-subjects" id="make-previews" hidden></div>
      </section>
      <form id="make-form" class="make-fields" data-act="make">
        ${['back','background','frame'].map(key=>input(key,'type="hidden" value=""')).join('')}
        <div class="form-row">${field('卡片比例',select('ratio',ratios))}${field('加入卡池',select('pool','<option value="">暂不分配</option>'+options(db.submissionPools)))}</div>
        <label hidden>闪卡类型<select name="tier"></select></label>
        <label class="studio-check"><input type="checkbox" name="special">闪光外观</label>
        ${submit(owner?'合成闪卡':'合成并提交审核','disabled')}
      </form>
      <dialog class="layer-picker" aria-labelledby="layer-picker-title">
        <header><h2 id="layer-picker-title"></h2><button type="button" class="soft tiny" data-picker-close autofocus>完成</button></header>
        <div class="layer-picker-tools">
          <div class="layer-picker-color">
            ${input('color','type="color" value="#dfcbef" form="make-form" aria-label="底色"')}
            <button type="button" class="soft tiny" data-picker-color>使用底色</button>
          </div>
          <button type="button" class="soft tiny" data-picker-clear>清除选择</button>
        </div>
        <div class="grid material-grid layer-picker-grid"></div>
      </dialog>
    </div>${owner?'':ownCards()}`;
  }
  function ownCards(){
    const rows=db.cards.filter(c=>c.author===db.who.id);
    if(!rows.length)return '';
    return `<section class="studio-card studio-body own-cards"><h2>我的闪卡</h2>
      ${rows.map(c=>`<div class="listrow review-listrow">
        <div class="review-card-thumb">${face(c,true)}</div><span>${e(c.name)}</span>${statusBadge(c.status)}
        ${c.status==='returned'?`<form data-act="resubmit" data-id="${e(c.id)}">
          ${c.review_reason?`<p class="review-reason">退回原因 · ${e(c.review_reason)}</p>`:''}
          ${field('卡名',input('name',`required maxlength="18" value="${e(c.name)}"`))}${submit('再次提交')}
        </form>`:''}
      </div>`).join('')}
    </section>`;
  }
  function resourcesPage(){
    const materials=(key,title,rows)=>`<details class="pool-group" data-key="resource-${key}">
      <summary class="pool-group-head"><span class="g-info"><strong>${title}</strong></span><span class="g-count">${rows.length} 件</span><span class="chev" aria-hidden="true">›</span></summary>
      <div class="pool-group-body">${rows.length?`<div class="grid material-grid">${rows.map(r=>`<article class="tile material-tile">
        <div class="material-art"><img loading="lazy" decoding="async" src="${e('/thumb'+r.src)}" alt=""></div>
        <b title="${e(r.name)}">${e(r.name)}</b>${r.ratio?`<small>${e(r.ratio.replace('x',':'))}</small>`:''}
        ${r.editable?`<button type="button" class="soft tiny danger" data-remove="${e(r.id)}" aria-label="删除 ${e(r.name)}">删除</button>`:''}
      </article>`).join('')}</div>`:'<p class="album-empty">暂无素材</p>'}</div>
    </details>`;
    return `<div class="studio-resource-layout"><div class="studio-card studio-body">
      <form data-act="resource">${field('类型',select('kind','<option value="frames">上层卡框</option><option value="backgrounds">背景图</option><option value="backs">卡背</option><option value="packs">卡包</option>'))}${field('名称',input('name','required maxlength="80"'))}${field('素材比例',select('ratio',ratios))}${field('图片',input('file',imageFile+' required'))}${submit('添加素材')}</form>
      </div><div class="pool-groups studio-materials">${materials('packs','卡包',packs)}${materials('backs','卡背',[defaultBack,...backs])}${materials('backgrounds','背景图',db.backgrounds)}${materials('frames','上层卡框',db.frames)}</div></div>`;
  }
  function poolsPage(){
    const cardsById=new Map(db.cards.map(card=>[card.id,card]));
    return `<div class="studio-card studio-body"><form data-act="pool">${field('新卡池名称',input('name','required maxlength="80"'))}${submit('创建卡池')}</form></div>
      ${db.pools.filter(p=>!owner||p.status!=='pending').map(p=>{
        const packOptions=[{src:'',name:'默认卡包'},...packs];
        if(p.pack_src&&!packs.some(item=>item.src===p.pack_src))packOptions.push({src:p.pack_src,name:'当前卡包'});
        const packSelect=packOptions.map(item=>`<option value="${e(item.src)}" ${item.src===p.pack_src?'selected':''}>${e(item.name)}</option>`).join('');
        return `<details class="studio-card" data-key="pool-${e(p.id)}"><summary>${e(p.name)}${statusBadge(p.status)}<span class="chev" aria-hidden="true">›</span></summary><div class="studio-body">
        ${p.pack?`<img class="submission-pack" src="${e('/thumb'+p.pack.src)}" alt="卡包封面">`:''}
        ${p.review_reason?`<p class="review-reason">退回原因 · ${e(p.review_reason)}</p>`:''}
        <p class="studio-status" data-actual-rates>${e(actualRatesText(p))}</p>
        ${p.author===db.who.id?`<a class="soft" href="#test/${e(p.id)}">私测抽卡</a>`:''}
        ${poolEditable(p)?`
        <form data-act="rename" data-id="${e(p.id)}">${field('卡池名称',input('name',`value="${e(p.name)}" required maxlength="80"`))}${submit('保存名称')}</form>
        <form data-act="config" data-id="${e(p.id)}">${field('每发张数',input('cardsPerPack',`type="number" required min="1" max="30" value="${p.cardsPerPack}"`))}
          <div class="type-fields"><strong>闪卡类型与概率</strong>${p.types.map(typeRow).join('')}<button type="button" class="soft tiny" data-add-tier>新增类型</button></div>${submit('保存配置')}</form>
        <form data-act="pack" data-id="${e(p.id)}">${field('卡包封面',`<select name="src" aria-label="卡包封面">${packSelect}</select>`)}${field('或上传封面',input('cover',imageFile))}${submit('保存封面')}</form>
        <details class="studio-card" data-key="members-${e(p.id)}" data-members="${e(p.id)}"><summary>分配卡片<span class="count-pill">${p.entries.length} 张</span><span class="chev" aria-hidden="true">›</span></summary><div class="studio-body"></div></details>`:`
        <ul class="submission-card-names">${p.entries.map(entry=>`<li>${e(cardsById.get(entry.id)?.name)}</li>`).join('')}</ul>`}
        <div class="submission-actions">
          ${p.status==='draft'||p.status==='returned'?`<button type="button" class="pill" data-pool-action="submit" data-id="${e(p.id)}">提交审核</button>`:''}
          ${p.status==='pending'||!owner&&p.status==='approved'?`<button type="button" class="soft" data-pool-action="withdraw" data-id="${e(p.id)}">撤回修改</button>`:''}
          ${poolEditable(p)?`<button type="button" class="soft danger" data-delete-pool="${e(p.id)}">删除卡池</button>`:''}
        </div>
      </div></details>`;
      }).join('')}`;
  }
  const cardsById=new Map(db.cards.map(c=>[c.id,c]));
  const canAssign=(pool,card)=>(owner||card.author===db.who.id)&&
    (card.status==='approved'||pool.status!=='approved'&&card.author===pool.author);
  const listingButton=(id,listed,card)=>`<button type="button" class="soft ${listed?'danger':''}" data-listing="${e(id)}"
    ${card?`data-listing-card="${e(card)}"`:''}>${listed?'下架':'上架'}</button>`;
  const listingBadge=listed=>`<span class="submission-status ${listed?'approved':'draft'}">${listed?'已上架':'已下架'}</span>`;
  function reviewPage(){
    const pendingPools=db.pools.filter(p=>p.status==='pending');
    const grouped=new Set(pendingPools.flatMap(p=>p.entries.map(entry=>entry.id)));
    const authors=new Map(db.profiles.map(profile=>[profile.id,profile.name]));
    const cards=db.cards.filter(c=>db.reviewableCards.includes(c.id)&&!grouped.has(c.id));
    const targets=new Map();
    for(const pool of db.pools){
      for(const entry of pool.entries){
        if(cardsById.get(entry.id).status==='pending'){
          if(!targets.has(entry.id))targets.set(entry.id,[]);
          targets.get(entry.id).push(pool.name+' / '+pool.types.find(t=>t.id===entry.tier).name);
        }
      }
    }
    const actions=(kind,id)=>`<div class="submission-actions">
      <button type="button" class="pill" data-review="${kind}" data-id="${e(id)}" data-approved="true">通过</button>
      <button type="button" class="soft" data-review="${kind}" data-id="${e(id)}" data-approved="false">退回</button></div>`;
    const cardButton=(c,tier)=>`<button type="button" class="review-card-button" data-card-preview="${e(c.id)}">${face(c,true)}<span>${c.special?'✦ ':''}${e(c.name)}</span>${tier?`<small>${e(tier)}</small>`:''}</button>`;
    return `<h2 class="moderation-heading">待审核</h2>${pendingPools.map(p=>{
      return `<section class="studio-card studio-body review-record">
        <h2>${e(p.name)}</h2><p class="studio-status">${e(authors.get(p.author)||'')} · ${p.cardsPerPack} 张/发 · ${e(ratesText(p))}</p>
        ${p.pack?`<img class="submission-pack" src="${e('/thumb'+p.pack.src)}" alt="卡包封面">`:''}
        <div class="review-grid">${p.entries.map(entry=>cardButton(cardsById.get(entry.id),p.types.find(t=>t.id===entry.tier).name)).join('')}</div>${actions('pools',p.id)}</section>`;
    }).join('')}
    ${cards.map(c=>`<section class="studio-card studio-body review-record"><div class="review-single">${cardButton(c)}
      <p class="studio-status">${e([authors.get(c.author),...(targets.get(c.id)||[])].filter(Boolean).join(' · '))}</p></div>${actions('cards',c.id)}</section>`).join('')}
    ${!pendingPools.length&&!cards.length?'<p class="studio-status moderation-empty">暂无待审核投稿</p>':''}
    <h2 class="moderation-heading">卡池上下架</h2>
    <div class="moderation-list">${db.pools.filter(p=>p.status==='approved').map(p=>`<section class="studio-card studio-body moderation-pool">
      <div class="moderation-row"><h3>${e(p.name)}</h3>${listingBadge(p.listed)}${listingButton(p.id,p.listed)}</div>
      <p class="studio-status" data-actual-rates>${e(actualRatesText(p))}</p>
      <details data-key="review-pool-${e(p.id)}" data-review-members="${e(p.id)}"><summary>管理池内卡片 <span class="chev" aria-hidden="true">›</span></summary><div class="moderation-members"></div></details>
    </section>`).join('')||'<p class="studio-status moderation-empty">暂无已通过的卡池</p>'}</div>
    <h2 class="moderation-heading">用户封禁</h2>
    <section class="studio-card studio-body moderation-list">${db.profiles.filter(p=>p.role!=='owner').map(p=>`<div class="moderation-row moderation-user">
      <strong>${e(p.name)}</strong><span class="submission-status ${p.banned?'returned':'approved'}">${p.banned?'已封禁':'正常'}</span>
      <button type="button" class="soft ${p.banned?'':'danger'}" data-ban="${e(p.id)}">${p.banned?'解封':'封禁'}</button>
    </div>`).join('')||'<p class="studio-status">暂无其他用户</p>'}</section>
    <dialog class="review-preview" aria-label="闪卡预览"><header><strong></strong><button type="button" class="soft tiny" data-close-review>关闭</button></header>
      <div class="viewer"><canvas aria-label="闪卡预览"></canvas></div><button type="button" class="soft" data-flip-review>翻面</button></dialog>`;
  }
  function rolesPage(){
    const profiles=db.profiles.filter(p=>p.role!=='owner');
    return `<section class="studio-card studio-body">${profiles.map(p=>`<div class="listrow profile-row">
      <span>${e(p.name)}<small>${e(p.id)}</small></span>
      <div class="profile-actions">
        <button type="button" class="soft tiny" data-user="${e(p.id)}" data-role="${p.role==='maker'?'user':'maker'}">${p.role==='maker'?'取消制卡员':'设为制卡员'}</button>
        <label class="profile-download"><input type="checkbox" data-download-user="${e(p.id)}" ${p.canDownloadCards?'checked':''} aria-label="${e(p.name)}的下载互动卡权限">下载互动卡</label>
      </div></div>`).join('')||'<p class="studio-status">暂无其他用户</p>'}</section>`;
  }
  const views={make:makePage,resources:resourcesPage,pools:poolsPage,review:reviewPage,roles:rolesPage};
  root.innerHTML=head(page.name,true)+`<div class="studio studio-layout">${views[page.id]()}</div>`;
  const panel=root.querySelector('.studio');
  const make=panel.querySelector('#make-form');
  const resource=panel.querySelector('[data-act=resource]');
  const reviewDialog=panel.querySelector('.review-preview');
  let reviewViewer;
  if(reviewDialog)reviewDialog.onclose=()=>{reviewViewer?.dispose();reviewViewer=null;};
  const subjects=[];
  const discardSubject=s=>URL.revokeObjectURL(s.src);
  let renderPreviews,closePreview=()=>{};

  if(resource){
    const {kind,ratio}=resource.elements;
    kind.onchange=()=>ratio.closest('label').hidden=kind.value==='backgrounds'||kind.value==='packs';
    kind.onchange();
  }
  if(make){
    const fields=make.elements,previews=panel.querySelector('#make-previews');
    const button=make.querySelector('button[type=submit]');
    const stage=panel.querySelector('.composition-stage'),viewport=stage.querySelector('.composition-viewport');
    const layers=stage.querySelector('.composition-layers'),layerImages=layers.querySelectorAll('[data-layer]');
    const toggle=panel.querySelector('[data-compose-toggle]'),controls=panel.querySelector('.composition-controls');
    const flip=controls.querySelector('.composition-flip'),sliders=controls.querySelectorAll('input[type=range]');
    const picker=panel.querySelector('.layer-picker'),pickerGrid=picker.querySelector('.layer-picker-grid');
    const pickerColor=picker.querySelector('.layer-picker-color'),pickerClear=picker.querySelector('[data-picker-clear]');
    const materials={back:backs,background:db.backgrounds,frame:db.frames},presets=new Set();
    let active=0,merged=false,interactive,previewTimer,pickerLayer;

    function compose(subject=subjects[active]){
      return {name:subject?.name.trim()||'',subject:subject?.src||'',ratio:fields.ratio.value,color:fields.color.value,
        frame:fields.frame.value,background:fields.background.value,back:fields.back.value,special:fields.special.checked};
    }
    function syncPreview(){
      if(!merged)return;
      clearTimeout(previewTimer);
      previewTimer=setTimeout(()=>interactive.update(compose()),100);
    }
    function syncLayers(){
      const card=compose();
      stage.style.setProperty('--ratio',CardEngine.dimensions(card.ratio));
      stage.style.setProperty('--color',card.color);
      for(const image of layerImages){
        const key=image.dataset.layer,preset=presets.has(key);
        const src=key==='back'&&preset?defaultBack.src:card[key];
        image.parentElement.toggleAttribute('data-filled',!!src||preset);
        image.hidden=!src;
        if(src&&image.getAttribute('src')!==src)image.src=src;
      }
      syncPreview();
    }
    layers.onclick=event=>{
      const layer=event.target.closest('[data-pick-layer]');
      if(!layer)return;
      pickerLayer=layer.dataset.pickLayer;
      const isBackground=pickerLayer==='background';
      const value=fields[pickerLayer].value;
      const assets=materials[pickerLayer].filter(item=>isBackground||item.ratio===fields.ratio.value);
      if(pickerLayer==='back')assets.unshift(defaultBack);
      picker.querySelector('h2').textContent='选择'+layerNames[pickerLayer];
      pickerColor.hidden=!isBackground;
      pickerClear.hidden=!value&&!presets.has(pickerLayer);
      pickerGrid.innerHTML=assets.map(item=>{
        const isDefault=item===defaultBack;
        return `<button type="button" class="tile layer-choice" data-src="${isDefault?'':e(item.src)}" aria-pressed="${isDefault?presets.has(pickerLayer):item.src===value}">
          <span class="material-art"><img src="${e('/thumb'+item.src)}" alt="" loading="lazy"></span>
          <b title="${e(item.name)}">${e(item.name)}</b>
        </button>`;
      }).join('')||'<p class="album-empty">当前比例暂无素材</p>';
      picker.showModal();
    };
    function selectLayer(src,preset){
      fields[pickerLayer].value=src;
      if(preset)presets.add(pickerLayer);
      else presets.delete(pickerLayer);
      syncLayers();
    }
    picker.onclick=event=>{
      const choice=event.target.closest('[data-src]');
      if(choice)selectLayer(choice.dataset.src,!choice.dataset.src);
      else if(event.target.closest('[data-picker-color]'))selectLayer('',true);
      else if(event.target.closest('[data-picker-clear]')){
        if(pickerLayer==='background')fields.color.value=fields.color.defaultValue;
        selectLayer('',false);
      }else if(!event.target.closest('[data-picker-close]'))return;
      picker.close();
    };
    fields.color.oninput=()=>{
      selectLayer('',true);
      pickerClear.hidden=false;
      pickerGrid.querySelector('[aria-pressed=true]')?.setAttribute('aria-pressed','false');
    };
    function setMerged(open){
      merged=open;
      stage.toggleAttribute('data-merged',open);
      toggle.setAttribute('aria-expanded',String(open));
      toggle.textContent=open?'展开分层':'合成预览';
      layers.inert=open;
      viewport.setAttribute('aria-hidden',String(!open));
      controls.hidden=!open||flip.disabled;
      clearTimeout(previewTimer);
      if(!open)return;
      if(interactive){interactive.resetPose();interactive.update(compose());return;}
      interactive=window.motion.viewer(viewport,compose(),{preview:true,
        settings:()=>[sliders[0].valueAsNumber,sliders[2].valueAsNumber/100,sliders[1].valueAsNumber],
        onReady:flat=>{
          stage.setAttribute('data-interactive','');
          flip.disabled=false;
          controls.hidden=!merged;
          for(const slider of sliders)slider.closest('label').hidden=flat;
        },
        onError:err=>{if(merged){setMerged(false);toast(err.message);}}
      });
    }
    toggle.onclick=()=>setMerged(!merged);
    flip.onclick=()=>interactive.flip();
    for(const slider of sliders){
      const output=slider.closest('label').querySelector('output');
      slider.oninput=()=>{output.value=slider.value;interactive.redraw();};
    }
    closePreview=()=>{clearTimeout(previewTimer);interactive?.dispose();};

    renderPreviews=()=>{
      if(!subjects.length){active=0;if(merged)setMerged(false);}
      button.disabled=!subjects.length;
      previews.hidden=!subjects.length;
      previews.innerHTML=subjects.map((subject,i)=>`<div class="composition-subject">
        <button type="button" class="subject-choose" data-view-index="${i}" aria-label="预览第 ${i+1} 张闪卡" aria-pressed="${i===active}"><img src="${e(subject.src)}" alt="" loading="lazy"></button>
        <input type="text" form="make-form" aria-label="第 ${i+1} 张卡片名称" data-name-index="${i}" value="${e(subject.name)}" required maxlength="18">
        <div class="subject-actions">${db.who.canDownloadCards?`<button type="button" class="soft tiny download-card" data-download-index="${i}">下载互动卡</button>`:''}<button type="button" class="soft tiny danger" data-remove-index="${i}">移除</button></div>
      </div>`).join('');
      syncLayers();
    };
    fields.items.onchange=()=>{
      const chosen=[...fields.items.files];
      const slots=200-subjects.length;
      for(const file of chosen.slice(0,slots)){
        const name=file.name.replace(/\.[^.]+$/,'').trim().slice(0,18)||'闪卡';
        subjects.push({file,name,src:URL.createObjectURL(file)});
      }
      fields.items.value='';
      if(chosen.length>slots)toast('每次最多合成 200 张');
      renderPreviews();
    };
    fields.ratio.onchange=()=>{
      for(const key of ['frame','back']){
        if(fields[key].value&&!materials[key].some(item=>item.src===fields[key].value&&item.ratio===fields.ratio.value))fields[key].value='';
      }
      syncLayers();
    };
    fields.special.onchange=syncLayers;
    fields.pool.onchange=()=>{
      const pool=db.submissionPools.find(p=>p.id===fields.pool.value);
      fields.tier.innerHTML=pool?typeOptions(pool.types):'';
      fields.tier.closest('label').hidden=!pool;
      button.textContent=pool&&pool.status!=='approved'?'保存到卡池草稿':owner?'合成闪卡':'合成并提交审核';
    };
    fields.pool.onchange();
    previews.oninput=event=>{
      const index=event.target.dataset.nameIndex;
      if(index===undefined)return;
      subjects[+index].name=event.target.value;
      if(+index===active)syncPreview();
    };
    previews.onclick=event=>{
      const choose=event.target.closest('[data-view-index]');
      if(choose){
        previews.querySelector('[aria-pressed=true]').setAttribute('aria-pressed','false');
        active=+choose.dataset.viewIndex;
        choose.setAttribute('aria-pressed','true');
        syncLayers();
        if(merged)interactive.resetPose();
        return;
      }
      const download=event.target.closest('[data-download-index]');
      if(download){
        const subject=subjects[+download.dataset.downloadIndex],card=compose(subject);
        if(!card.name){
          toast('请输入卡片名称');
          download.closest('.composition-subject').querySelector('[data-name-index]').focus();
          return;
        }
        downloadCard(download,card,subject.file);return;
      }
      const remove=event.target.closest('[data-remove-index]');
      if(!remove)return;
      const index=+remove.dataset.removeIndex;
      discardSubject(subjects.splice(index,1)[0]);
      active=Math.max(0,Math.min(active-Number(index<active),subjects.length-1));
      renderPreviews();
      (previews.querySelector('[data-remove-index="'+Math.min(index,subjects.length-1)+'"]')||fields.items).focus({preventScroll:true});
    };
    renderPreviews();
  }

  panel.addEventListener('toggle',event=>{
    const details=event.target;
    if(details.open&&details.dataset.reviewMembers&&!details.dataset.loaded){
      renderListedCards(details);
      details.dataset.loaded='true';
    }
    if(!details.open||!details.dataset.members||details.dataset.loaded)return;
    const pool=db.pools.find(p=>p.id===details.dataset.members),included=new Map(pool.entries.map(entry=>[entry.id,entry.tier]));
    const choices=db.cards.filter(c=>included.has(c.id)||canAssign(pool,c));
    details.querySelector('.studio-body').innerHTML=`<div class="member-grid">${choices.map(c=>`<label class="member" data-member="${e(c.id)}">
      <input type="checkbox" ${included.has(c.id)?'checked':''} aria-label="${e(c.name)}">
      <span class="m-face">${face(c,true)}</span><span class="m-check" aria-hidden="true">✓</span><span class="m-name">${e(c.name)}</span>
      <select aria-label="${e(c.name)}的闪卡类型" ${canAssign(pool,c)?'':'disabled'}>${typeOptions(pool.types,included.get(c.id)||(c.special?'rare':'normal'))}</select></label>`).join('')}</div>`;
    details.dataset.loaded='true';
  },true);

  function renderListedCards(details,offset=0){
    const pool=db.pools.find(p=>p.id===details.dataset.reviewMembers);
    const entries=pool.entries.filter(entry=>cardsById.get(entry.id).status==='approved');
    const next=offset+24;
    const list=details.querySelector('.moderation-members');
    list.querySelector('[data-review-more]')?.remove();
    list.insertAdjacentHTML('beforeend',entries.slice(offset,next).map(entry=>{
      const card=cardsById.get(entry.id);
      return `<div class="moderation-row moderation-card">
        <button type="button" class="moderation-card-name" data-card-preview="${e(card.id)}"><span class="review-card-thumb">${face(card,true)}</span>${e(card.name)}</button>
        ${listingBadge(entry.listed)}${listingButton(pool.id,entry.listed,card.id)}</div>`;
    }).join('')+(next<entries.length?`<button type="button" class="soft" data-review-more="${next}">加载更多卡片</button>`:
      entries.length?'':'<p class="studio-status">暂无已通过的卡片</p>'));
  }

  async function upload(file){const data=new FormData();data.append('file',file);return (await api('uploads','POST',data)).src;}
  let saving=false;
  async function act(run,refresh=true){
    if(saving)return;
    saving=true;panel.inert=true;
    const open=new Set([...panel.querySelectorAll('details[open]')].map(d=>d.dataset.key));
    const hash=location.hash,scroll=root.scrollTop;
    try{
      const message=await run();
      if(!panel.isConnected)return;
      toast(typeof message==='string'?message:'已保存');
      if(refresh){
        await route();
        if(location.hash!==hash)return;
        for(const details of root.querySelectorAll('.studio details'))details.open=open.has(details.dataset.key);
        requestAnimationFrame(()=>{if(location.hash===hash)root.scrollTop=scroll;});
      }
    }catch(err){toast(err.message);}
    finally{saving=false;panel.inert=false;}
  }
  panel.onsubmit=event=>{
    event.preventDefault();
    const form=event.target,action=form.dataset.act,v=new FormData(form),data=Object.fromEntries(v);
    act(async()=>{
      switch(action){
      case 'pool':return api('pools','POST',{name:data.name,draft:true});
      case 'rename':return api(`pools/${form.dataset.id}/name`,'POST',{name:data.name});
      case 'config':{
        const types=[...form.querySelectorAll('[data-tier]')].map(row=>({
          id:row.dataset.tier,name:row.querySelector('[name=tierName]').value,rate:Math.round(Number(row.querySelector('[name=tierRate]').value)*100)
        }));
        return api(`pools/${form.dataset.id}/config`,'POST',{types,cardsPerPack:Number(data.cardsPerPack)});
      }
      case 'pack':{
        const path=`pools/${form.dataset.id}/pack`;
        if(!data.cover.size)return api(path,'POST',{src:data.src});
        const src=await upload(data.cover);
        try{return await api(path,'POST',{upload:src});}
        catch(err){await Promise.allSettled([api('uploads/'+src.split('/').pop(),'DELETE')]);throw err;}
      }
      case 'resubmit':return api(`cards/${form.dataset.id}/resubmit`,'POST',{name:data.name});
      case 'resource':
      case 'make':{
        const uploaded=[];
        try{
          if(action==='resource'){
            const src=await upload(data.file);uploaded.push(src);
            return await api('resources','POST',{kind:data.kind,ratio:data.ratio,name:data.name,src});
          }
          const items=[];
          for(const s of subjects){
            const subject=await upload(s.file);uploaded.push(subject);
            items.push({name:s.name.trim(),subject});
          }
          const {cards}=await api('cards','POST',{ratio:data.ratio,color:data.color,frame:data.frame,background:data.background,back:data.back,pool:data.pool,tier:data.tier,special:v.has('special'),items});
          if(panel.isConnected){subjects.splice(0).forEach(discardSubject);renderPreviews();}
          const pool=db.submissionPools.find(p=>p.id===data.pool);
          return pool&&pool.status!=='approved'?`已保存 ${cards.length} 张，去卡池提交整套审核`:
            owner?`已合成 ${cards.length} 张闪卡`:`已提交 ${cards.length} 张闪卡审核`;
        }catch(err){await Promise.allSettled(uploaded.map(src=>api('uploads/'+src.split('/').pop(),'DELETE')));throw err;}
      }
      }
    },action!=='make'||!owner);
  };
  panel.onchange=event=>{
    const t=event.target;
    if(t.dataset.downloadUser){
      const enabled=t.checked;
      act(async()=>{
        try{await api(`users/${t.dataset.downloadUser}/card-file-access`,'POST',{enabled});}
        catch(err){t.checked=!enabled;throw err;}
      },false);
      return;
    }
    const member=t.closest('[data-member]');
    if(!member)return;
    const checkbox=member.querySelector('input'),choice=member.querySelector('select');
    const included=checkbox.checked,card=cardsById.get(member.dataset.member);
    if(t===choice&&!included)return;
    const details=member.closest('[data-members]'),pool=db.pools.find(p=>p.id===details.dataset.members);
    const entry=pool.entries.find(entry=>entry.id===card.id);
    act(async()=>{
      try{
        const tier=choice.value;
        const {actualRates}=await api(`pools/${pool.id}/member`,'POST',{card:card.id,included,tier});
        if(included){if(entry)entry.tier=tier;else pool.entries.push({id:card.id,tier});}
        else pool.entries=pool.entries.filter(entry=>entry.id!==card.id);
        pool.actualRates=actualRates;
        details.querySelector('.count-pill').textContent=pool.entries.length+' 张';
        details.parentElement.querySelector('[data-actual-rates]').textContent=actualRatesText(pool);
        if(!included&&!canAssign(pool,card))member.remove();
        return included?'已加入卡池':'已移出卡池';
      }
      catch(err){checkbox.checked=!!entry;if(entry)choice.value=entry.tier;throw err;}
    },false);
  };
  panel.onclick=event=>{
    const b=event.target.closest('button');
    if(!b)return;
    if(b.hasAttribute('data-add-tier')){
      b.insertAdjacentHTML('beforebegin',typeRow({id:'t-'+crypto.getRandomValues(new Uint32Array(1))[0].toString(36),name:'',rate:0}));
      b.previousElementSibling.querySelector('input').focus();
    }
    if(b.hasAttribute('data-remove-tier'))b.closest('[data-tier]').remove();
    if(b.dataset.reviewMore)renderListedCards(b.closest('details'),Number(b.dataset.reviewMore));
    if(b.dataset.listing){
      const pool=db.pools.find(p=>p.id===b.dataset.listing),card=b.dataset.listingCard;
      const item=card?pool.entries.find(entry=>entry.id===card):pool;
      const listed=!item.listed;
      act(async()=>{
        const {actualRates}=await api(`pools/${pool.id}/${card?'card-listing':'listing'}`,'POST',{listed,card});
        item.listed=listed;
        pool.actualRates=actualRates;
        b.closest('.moderation-pool').querySelector('[data-actual-rates]').textContent=actualRatesText(pool);
        b.previousElementSibling.outerHTML=listingBadge(listed);
        b.textContent=listed?'下架':'上架';
        b.classList.toggle('danger',listed);
        return b.previousElementSibling.textContent;
      },false);
    }
    if(b.dataset.ban){
      const profile=db.profiles.find(p=>p.id===b.dataset.ban),banned=!profile.banned;
      if(!banned||confirm(`封禁「${profile.name}」？该账号将无法抽卡或投稿。`))act(async()=>{
        await api(`users/${profile.id}/ban`,'POST',{banned});
        profile.banned=banned;
        const status=b.previousElementSibling;
        status.textContent=banned?'已封禁':'正常';
        status.className='submission-status '+(banned?'returned':'approved');
        b.textContent=banned?'解封':'封禁';
        b.classList.toggle('danger',!banned);
        return banned?'已封禁':'已解封';
      },false);
    }
    if(b.dataset.cardPreview){
      const card=db.cards.find(c=>c.id===b.dataset.cardPreview);
      reviewDialog.querySelector('strong').textContent=card.name;
      reviewDialog.querySelector('.viewer').innerHTML='<canvas aria-label="闪卡预览"></canvas>';
      reviewDialog.showModal();
      reviewViewer=window.motion.viewer(reviewDialog.querySelector('.viewer'),card,{onError:err=>toast(err.message)});
    }
    if(b.hasAttribute('data-close-review'))reviewDialog.close();
    if(b.hasAttribute('data-flip-review'))reviewViewer?.flip();
    if(b.dataset.poolAction){
      const pool=db.pools.find(p=>p.id===b.dataset.id),action=b.dataset.poolAction;
      if(action!=='withdraw'||pool.status!=='approved'||!pool.listed||confirm('撤回后卡池将从抽卡中心下架，需重新审核。'))
        act(async()=>{await api(`pools/${pool.id}/${action}`,'POST',{});return action==='submit'?'已提交审核':'已撤回';});
    }
    if(b.dataset.review){
      const approved=b.dataset.approved==='true';
      const reason=approved?'':prompt('退回原因（选填）');
      if(reason===null)return;
      const submission=db[b.dataset.review].find(item=>item.id===b.dataset.id);
      act(async()=>{await api(`${b.dataset.review}/${b.dataset.id}/review`,'POST',{approved,reviewKey:submission.review_key,reason});return approved?'审核通过':'已退回';});
    }
    if(b.dataset.deletePool){
      const pool=db.pools.find(p=>p.id===b.dataset.deletePool);
      if(confirm(`删除「${pool.name}」？玩家已抽到的卡会保留。`))act(()=>api('pools/'+pool.id,'DELETE'));
    }
    if(b.dataset.remove&&confirm('从素材库删除这项素材？'))act(()=>api('resources/'+b.dataset.remove,'DELETE'));
    if(b.dataset.user)act(()=>api(`users/${b.dataset.user}/role`,'POST',{role:b.dataset.role}));
  };
  return ()=>{closePreview();reviewViewer?.dispose();subjects.forEach(discardSubject);};
};
