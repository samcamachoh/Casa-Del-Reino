// Run: NODE_PATH=/path/to/jsdom/node_modules node --test tests/regression.cjs
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {JSDOM}=require('jsdom');
function page(file='index.html',options={}){
 const observers=[],media={},plays=[];
 const dom=new JSDOM(fs.readFileSync(file,'utf8'),{url:'https://example.test'+(options.path||'/'),runScripts:'dangerously',pretendToBeVisual:true,beforeParse(w){
  w.matchMedia=query=>(media[query]??={matches:query.includes('reduced')&&!!options.reduce,addEventListener(type,fn){this.change=fn;}});
  w.IntersectionObserver=class{constructor(cb){this.cb=cb;this.targets=[];observers.push(this);}observe(el){this.targets.push(el);}unobserve(){}disconnect(){}};
  w.HTMLElement.prototype.scrollIntoView=function(opts){w.lastScroll={id:this.id,opts};};
  w.HTMLMediaElement.prototype.play=function(){plays.push(this.src);this.dispatchEvent(new w.Event('playing'));return Promise.resolve();};
  w.HTMLMediaElement.prototype.pause=function(){};
  w.fetch=async()=>({ok:true,json:async()=>({live:false,items:[{id:'abcdefghijk',title:'Test',published:'2026-09-06'}]})});
  w.AbortController=AbortController;
  if(options.saveData)Object.defineProperty(w.navigator,'connection',{value:{saveData:true}});
 }});
 return {dom,w:dom.window,d:dom.window.document,observers,media,plays};
}
for(const file of ['index.html','about.html']){
 test(file+': language and mobile menu state',()=>{
  const p=page(file);try{
   const btn=p.d.querySelector('.menu-btn');btn.click();assert.equal(btn.getAttribute('aria-expanded'),'true');
   p.d.dispatchEvent(new p.w.KeyboardEvent('keydown',{key:'Escape'}));assert.equal(btn.getAttribute('aria-expanded'),'false');
   btn.click();p.media['(max-width:900px)'].change();assert.equal(p.d.body.classList.contains('nav-locked'),false);
   p.d.querySelector('[data-lang="en"]').click();assert.equal(p.d.documentElement.lang,'en');assert.equal(p.d.documentElement.dataset.activeLang,'en');
  }finally{p.w.close();}
 });
}
test('hero reserves space and source is deferred until visible',()=>{
 const p=page();try{
  const video=p.d.getElementById('hero-video');assert.equal(p.d.getElementById('hero-video-card').hidden,false);assert.equal(video.getAttribute('src'),null);
  p.observers.find(o=>o.targets.includes(p.d.getElementById('hero-video-card'))).cb([{isIntersecting:true}]);
  assert.match(video.src,/optimized.mp4$/);assert.equal(p.plays.length,1);
 }finally{p.w.close();}
});
for(const options of [{reduce:true},{saveData:true}])test('manual media loading '+JSON.stringify(options),()=>{
 const p=page('index.html',options);try{
  p.observers.find(o=>o.targets.includes(p.d.getElementById('hero-video-card'))).cb([{isIntersecting:true}]);
  assert.equal(p.d.getElementById('hero-video').getAttribute('src'),null);
  p.d.getElementById('hero-video-play').click();assert.equal(p.plays.length,1);assert.equal(p.d.getElementById('hero-video').muted,false);
 }finally{p.w.close();}
});
test('clean route links respect reduced motion',()=>{
 const p=page('index.html',{reduce:true});try{
  p.d.querySelector('a[href="/visit"]').click();assert.equal(p.w.location.pathname,'/visit');assert.equal(p.w.lastScroll.id,'visit');assert.equal(p.w.lastScroll.opts.behavior,'instant');
 }finally{p.w.close();}
});
test('sermons are deferred and player is outside the button',async()=>{
 const p=page();try{
  const grid=p.d.getElementById('sermon-grid');assert.equal(grid.getAttribute('aria-busy'),'true');
  p.observers.find(o=>o.targets.includes(grid)).cb([{isIntersecting:true}]);
  await new Promise(r=>setImmediate(r));
  assert.equal(grid.getAttribute('aria-busy'),'false');grid.querySelector('button').click();assert.ok(grid.querySelector('iframe'));assert.equal(grid.querySelector('button iframe'),null);
 }finally{p.w.close();}
});
test('API failure clears sermon loading state',async()=>{
 const p=page();try{
  p.w.fetch=async()=>{throw new Error('offline');};const grid=p.d.getElementById('sermon-grid');
  p.observers.find(o=>o.targets.includes(grid)).cb([{isIntersecting:true}]);await new Promise(r=>setImmediate(r));
  assert.equal(grid.getAttribute('aria-busy'),'false');assert.ok(grid.querySelector('.sermon-note'));
 }finally{p.w.close();}
});
for(const file of ['api/sermons.js','api/livestream.js'])test(file+': body download remains abortable',async()=>{
 let timedOut=false, cleared=false;
 const context={module:{exports:{}},AbortController,setTimeout(fn){queueMicrotask(fn);return 1;},clearTimeout(){cleared=true;},fetch:async(url,{signal})=>({ok:true,status:200,url,text:async()=>{timedOut=signal.aborted;throw new Error('body timeout');}})};
 vm.createContext(context);vm.runInContext(fs.readFileSync(file,'utf8'),context);
 await assert.rejects(context.fetchWithTimeout('https://example.test',1));assert.equal(timedOut,true);assert.equal(cleared,true);
});
test('sermons API filters live and upcoming videos',async()=>{
 const context={module:{exports:{}},process:{env:{YOUTUBE_API_KEY:'test'}},AbortController,setTimeout,clearTimeout,fetch:async url=>({ok:true,status:200,url,text:async()=>url.includes('googleapis')?JSON.stringify({items:[{id:'abcdefghijk',snippet:{liveBroadcastContent:'live'}},{id:'lmnopqrstuv',snippet:{liveBroadcastContent:'upcoming'}},{id:'12345678901',snippet:{liveBroadcastContent:'none'}}]}):['abcdefghijk','lmnopqrstuv','12345678901'].map(id=>'<entry><yt:videoId>'+id+'</yt:videoId><title>Faith &amp; Family</title><published>2026-09-06</published></entry>').join('')})};
 vm.createContext(context);vm.runInContext(fs.readFileSync('api/sermons.js','utf8'),context);
 let result;const res={setHeader(){},status(){return this;},json(d){result=d;}};await context.module.exports({query:{}},res);assert.equal(result.items.length,1);assert.equal(result.items[0].id,'12345678901');assert.equal(result.items[0].title,'Faith & Family');
});
