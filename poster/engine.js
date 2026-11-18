"use strict";
// Poster engine (Boun That Luang promo). Drawn with canvas; no external libraries.
const W = 1080, H = 1080;
const FONTS = {
  NL9:  "fonts/lao900.woff2",  NL9L: "fonts/latin900.woff2",
  NL8:  "fonts/lao800.woff2",  NL8L: "fonts/latin800.woff2",
  SPF:  "fonts/pf.woff2", SGV: "fonts/gv.woff2", SCD: "fonts/cd.woff2"
};
const THEMES = {
  crimson: { bg:['#a81a3c','#8a0e32','#640822'], panel:['#7e0c2c','#580620'], deep:'#580620', head2:'#ffe14a', text2:'#6a0a26' },
  royal:   { bg:['#8a35d0','#4f1c92','#2a0d5c'], panel:['#4a1a8c','#2a0d5c'], deep:'#2a0d5c', head2:'#ffe14a', text2:'#2a0d5c' }
};
const LAO_MONTHS = ['ມັງກອນ','ກຸມພາ','ມີນາ','ເມສາ','ພຶດສະພາ','ມິຖຸນາ','ກໍລະກົດ','ສິງຫາ','ກັນຍາ','ຕຸລາ','ພະຈິກ','ທັນວາ'];

async function loadFonts(){
  for (const [k,b64] of Object.entries(FONTS)){
    const f = new FontFace(k, `url(${b64})`);
    await f.load(); document.fonts.add(f);
  }
}
const F = (w,size) => `${size}px ${w==9?'NL9,NL9L':'NL8,NL8L'}, sans-serif`;

// ---------- image helpers ----------
function loadImg(src,cors){ return new Promise((res,rej)=>{ const i=new Image(); if(cors) i.crossOrigin='anonymous'; i.onload=()=>res(i); i.onerror=()=>rej(new Error('image load failed')); i.src=src; }); }

function cutout(img, tol, fillgaps){
  const c=document.createElement('canvas'); c.width=img.naturalWidth||img.width; c.height=img.naturalHeight||img.height;
  const x=c.getContext('2d',{willReadFrequently:true}); x.drawImage(img,0,0);
  const w=c.width,h=c.height; const d=x.getImageData(0,0,w,h); const p=d.data;
  const cs=[[0,0],[w-1,0],[0,h-1],[w-1,h-1]].map(([a,b])=>{const i=(b*w+a)*4;return [p[i],p[i+1],p[i+2],p[i+3]];});
  const transparentAlready = cs.every(v=>v[3]<10); let quality = transparentAlready;
  if(!transparentAlready){
    const bg=[0,1,2].map(k=>cs.reduce((s,v)=>s+v[k],0)/4);
    const dist=(i)=>{const dr=p[i*4]-bg[0],dg=p[i*4+1]-bg[1],db=p[i*4+2]-bg[2];return Math.sqrt(dr*dr+dg*dg+db*db);};
    const seen=new Uint8Array(w*h), st=[];
    const push=(i)=>{ if(!seen[i]&&dist(i)<=tol){seen[i]=1;st.push(i);} };
    for(let a=0;a<w;a++){push(a);push((h-1)*w+a);} for(let b=0;b<h;b++){push(b*w);push(b*w+w-1);}
    while(st.length){ const i=st.pop(); const a=i%w,b=(i/w)|0;
      if(a>0)push(i-1); if(a<w-1)push(i+1); if(b>0)push(i-w); if(b<h-1)push(i+w); }
    { let rem=0,bd=0; for(let i=0;i<w*h;i++) if(seen[i]) rem++;
      for(let a=0;a<w;a++){ if(seen[a])bd++; if(seen[(h-1)*w+a])bd++; } for(let b=0;b<h;b++){ if(seen[b*w])bd++; if(seen[b*w+w-1])bd++; }
      const rf=rem/(w*h), bf=bd/(2*(w+h)); quality=(bf>=.9 && rf>=.12 && rf<=.93); }
    // optional: restore gaps inside the product (rows between leftmost and rightmost product pixel)
    if(fillgaps){
      for(let b=0;b<h;b++){ let l=-1,r=-1; for(let a=0;a<w;a++) if(!seen[b*w+a]){ if(l<0)l=a; r=a; }
        if(l>=0) for(let a=l;a<=r;a++) seen[b*w+a]=0; }
    }
    for(let i=0;i<w*h;i++) if(seen[i]) p[i*4+3]=0;
    // soften edge: pixels touching removed area fade by how close their colour is to the background
    for(let b=1;b<h-1;b++)for(let a=1;a<w-1;a++){const i=b*w+a; if(!seen[i]&&(seen[i-1]||seen[i+1]||seen[i-w]||seen[i+w])){ const k=Math.max(.35,Math.min(1,dist(i)/(tol*1.8))); p[i*4+3]=Math.round(255*k); }}
    x.putImageData(d,0,0);
  }
  // crop to content
  let x0=w,y0=h,x1=0,y1=0; const q=x.getImageData(0,0,w,h).data;
  for(let b=0;b<h;b++)for(let a=0;a<w;a++) if(q[(b*w+a)*4+3]>20){ if(a<x0)x0=a; if(a>x1)x1=a; if(b<y0)y0=b; if(b>y1)y1=b; }
  if(x1<=x0||y1<=y0){ c.cutOk=false; return c; }
  const o=document.createElement('canvas'); o.width=x1-x0+1; o.height=y1-y0+1;
  o.getContext('2d').drawImage(c,x0,y0,o.width,o.height,0,0,o.width,o.height); o.cutOk=quality; return o;
}

// ---------- drawing helpers ----------
// ad-style retouch of a cut-out product: auto levels + gentle white balance + a little saturation, cleaner edge, soft rim/top light.
// Pure canvas maths (no AI). Returns a new canvas of the same size; cached on the source canvas.
function enhanceCut(src){
  if(src._enh) return src._enh;
  const w=src.width,h=src.height; const c=document.createElement('canvas'); c.width=w; c.height=h; const x=c.getContext('2d',{willReadFrequently:true}); x.drawImage(src,0,0);
  const d=x.getImageData(0,0,w,h), p=d.data; const hist=new Uint32Array(256); let n=0, sr=0,sg=0,sb=0;
  for(let i=0;i<p.length;i+=4){ if(p[i+3]<200) continue; const l=(p[i]*.299+p[i+1]*.587+p[i+2]*.114)|0; hist[l]++; n++; sr+=p[i]; sg+=p[i+1]; sb+=p[i+2]; }
  if(n<50){ src._enh=src; return src; }
  const pct=f=>{ let a=0; for(let k=0;k<256;k++){ a+=hist[k]; if(a>=n*f) return k; } return 255; };
  const lo=pct(.015), hi=pct(.985); const span=Math.max(60,hi-lo);
  const mr=sr/n, mg=sg/n, mb=sb/n, m=(mr+mg+mb)/3;
  // gray-world white balance, limited to +-2% so coloured packaging keeps its colour
  const cl=v=>Math.max(.98,Math.min(1.02,v)); const gr=cl(m/mr), gg=cl(m/mg), gb=cl(m/mb);
  const lm=(lo+hi)/2; const gam = lm<118 ? Math.max(.72,lm/118*.35+.65) : (lm>165?1.08:1);   // brighten dim photos
  const lut=new Uint8Array(256); for(let k=0;k<256;k++){ let v=(k-lo)/span; v=Math.max(0,Math.min(1,v)); v=Math.pow(v,gam); lut[k]=Math.round(6+v*246); }
  const sat=1.14;
  for(let i=0;i<p.length;i+=4){ if(p[i+3]===0) continue;
    let r=lut[Math.min(255,p[i]*gr|0)], g=lut[Math.min(255,p[i+1]*gg|0)], b=lut[Math.min(255,p[i+2]*gb|0)];
    const l=r*.299+g*.587+b*.114; r=l+(r-l)*sat; g=l+(g-l)*sat; b=l+(b-l)*sat;
    p[i]=r<0?0:r>255?255:r; p[i+1]=g<0?0:g>255?255:g; p[i+2]=b<0?0:b>255?255:b; }
  // edge clean-up: halve alpha of pixels touching transparency (removes the light fringe left by the old background)
  const a0=new Uint8Array(w*h); for(let i=0;i<w*h;i++) a0[i]=p[i*4+3];
  for(let b=1;b<h-1;b++)for(let a=1;a<w-1;a++){ const i=b*w+a; if(a0[i]>0 && (a0[i-1]<40||a0[i+1]<40||a0[i-w]<40||a0[i+w]<40)) p[i*4+3]=a0[i]>>1; }
  x.putImageData(d,0,0);
  // soft light: warm rim on the left edge, golden on the right, faint top gloss (only on product pixels)
  x.save(); x.globalCompositeOperation='source-atop';
  let g=x.createLinearGradient(0,0,w,0); g.addColorStop(0,'rgba(255,236,190,.30)'); g.addColorStop(.22,'rgba(255,236,190,0)'); g.addColorStop(.78,'rgba(255,196,120,0)'); g.addColorStop(1,'rgba(255,196,120,.22)'); x.fillStyle=g; x.fillRect(0,0,w,h);
  g=x.createLinearGradient(0,0,0,h); g.addColorStop(0,'rgba(255,255,255,.14)'); g.addColorStop(.25,'rgba(255,255,255,0)'); x.fillStyle=g; x.fillRect(0,0,w,h);
  x.restore();
  src._enh=c; return c;
}
// faint mirror image of the product on the plinth (drawn before the product itself)
function reflectionOf(img,dw,dh){
  const k=.30, rh=Math.round(dh*k); const c=document.createElement('canvas'); c.width=Math.max(1,Math.round(dw)); c.height=Math.max(1,rh); const x=c.getContext('2d');
  x.save(); x.translate(0,0); x.scale(1,-k); x.drawImage(img,0,-dh,dw,dh); x.restore();
  x.globalCompositeOperation='destination-in'; const g=x.createLinearGradient(0,0,0,rh); g.addColorStop(0,'rgba(0,0,0,.34)'); g.addColorStop(1,'rgba(0,0,0,0)'); x.fillStyle=g; x.fillRect(0,0,c.width,rh);
  return c;
}
function star(ctx,x,y,r,a=1){ ctx.save(); ctx.globalAlpha=a; ctx.translate(x,y); ctx.fillStyle='#fff6c8'; ctx.shadowColor='#ffe27a'; ctx.shadowBlur=r*1.2;
  ctx.beginPath(); for(let i=0;i<8;i++){ const rr=i%2?r*0.22:r; const an=i*Math.PI/4-Math.PI/2; ctx.lineTo(Math.cos(an)*rr,Math.sin(an)*rr);} ctx.closePath(); ctx.fill(); ctx.restore(); }

function rr(ctx,x,y,w,h,r){ ctx.beginPath(); ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r); ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath(); }

function goldGrad(ctx,y0,y1){ const g=ctx.createLinearGradient(0,y0,0,y1); g.addColorStop(0,'#fff0a0'); g.addColorStop(.45,'#f6c63a'); g.addColorStop(1,'#c8870e'); return g; }

const SEG = (typeof Intl!=='undefined' && Intl.Segmenter) ? new Intl.Segmenter('lo',{granularity:'word'}) : null;
function wrap(ctx,text,font,maxW){
  ctx.font=font; const src=text.trim();
  const toks = SEG ? [...SEG.segment(src)].map(s=>s.segment) : src.split(/(\s+)/);
  const lines=[]; let cur='';
  for(const tk of toks){ const t2=cur+tk; if(ctx.measureText(t2.trim()).width<=maxW||!cur.trim()) cur=t2; else {lines.push(cur.trim());cur=tk.trim()?tk:'';} }
  if(cur.trim()) lines.push(cur.trim()); return lines;
}
function fitBlock(ctx,text,wgt,maxW,maxH,maxSize,minSize,lhMul){
  for(let s=maxSize;s>=minSize;s-=2){
    const lines=wrap(ctx,text,F(wgt,s),maxW);
    const tooWide=lines.some(l=>ctx.measureText(l).width>maxW);
    if(!tooWide && lines.length*s*lhMul<=maxH) return {lines,size:s};
  }
  return {lines:wrap(ctx,text,F(wgt,minSize),maxW),size:minSize};
}
function textO(ctx,t,x,y,font,fill,stroke,lw,align='center',shadow){
  ctx.save(); ctx.font=font; ctx.textAlign=align; ctx.textBaseline='alphabetic'; ctx.lineJoin='round';
  if(shadow){ctx.shadowColor=shadow.c;ctx.shadowBlur=shadow.b;ctx.shadowOffsetY=shadow.y||0;}
  if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=lw;ctx.strokeText(t,x,y);} ctx.shadowColor='transparent';
  ctx.fillStyle=fill; ctx.fillText(t,x,y); ctx.restore();
}

let __chan=null;
function silk(ctx,th,pa){
  if(!__chan){
    const o=document.createElement('canvas'); o.width=W; o.height=H; const g=o.getContext('2d');
    const sp=78, r=24;
    const star=(x,y,rr,fill,stroke)=>{ g.beginPath(); const k=.26;
      g.moveTo(x,y-rr); g.lineTo(x+rr*k,y-rr*k); g.lineTo(x+rr,y); g.lineTo(x+rr*k,y+rr*k); g.lineTo(x,y+rr); g.lineTo(x-rr*k,y+rr*k); g.lineTo(x-rr,y); g.lineTo(x-rr*k,y-rr*k); g.closePath();
      if(fill){g.fillStyle=fill;g.fill();} if(stroke){g.strokeStyle=stroke;g.lineWidth=1.6;g.stroke();} };
    for(let j=-1;j*sp/2<H+sp;j++){ for(let i=-1;i*sp<W+sp;i++){
      const x=i*sp+((j&1)?sp/2:0), y=j*sp/2;
      star(x,y,r,'rgba(255,226,150,.30)','rgba(255,238,184,.55)');
      g.fillStyle='rgba(255,238,184,.7)'; g.beginPath(); g.arc(x,y,3.4,0,7); g.fill();
      star(x+sp/2,y,9,null,'rgba(255,230,160,.45)');
      g.fillStyle='rgba(255,230,160,.5)'; for(const [dx,dy] of [[0,-22],[0,22]]){ g.beginPath(); g.arc(x+sp/2,y+dy*0+ (dy<0?-0:0),0,0,7); }
    } }
    g.globalCompositeOperation='destination-in';
    const m=g.createLinearGradient(0,0,0,H); m.addColorStop(0,'rgba(0,0,0,1)'); m.addColorStop(.2,'rgba(0,0,0,.8)'); m.addColorStop(.36,'rgba(0,0,0,0)'); m.addColorStop(.86,'rgba(0,0,0,0)'); m.addColorStop(1,'rgba(0,0,0,.9)');
    g.fillStyle=m; g.fillRect(0,0,W,H);
    __chan=o;
  }
  ctx.save(); ctx.globalAlpha=pa; ctx.drawImage(__chan,0,0); ctx.restore();
}

function stupa(ctx,cx,by,s){
  ctx.save(); ctx.translate(cx,by); ctx.scale(s,s);
  const hg=(x0,x1)=>{ const g=ctx.createLinearGradient(x0,0,x1,0); g.addColorStop(0,'#a8680a'); g.addColorStop(.28,'#ffe48a'); g.addColorStop(.55,'#f5c43c'); g.addColorStop(1,'#9c5f08'); return g; };
  const edge='rgba(110,62,0,.55)';
  const flame=(x,y,h,w)=>{ ctx.beginPath(); ctx.moveTo(x-w,y); ctx.bezierCurveTo(x-w,y-h*.45,x-w*.35,y-h*.8,x,y-h); ctx.bezierCurveTo(x+w*.35,y-h*.8,x+w,y-h*.45,x+w,y); ctx.closePath(); ctx.fillStyle=hg(x-w,x+w); ctx.fill(); ctx.strokeStyle=edge; ctx.lineWidth=1.2; ctx.stroke(); };
  const petals=(x0,x1,y,r)=>{ const n=Math.round((x1-x0)/(r*2)); const st=(x1-x0)/n; ctx.beginPath(); for(let i=0;i<n;i++){ ctx.moveTo(x0+i*st,y); ctx.arc(x0+i*st+st/2,y,st/2,Math.PI,0); } ctx.fillStyle='#ffe9a0'; ctx.fill(); ctx.strokeStyle=edge; ctx.lineWidth=1; ctx.stroke(); };
  const tier=(hw,y0,y1,inset)=>{ ctx.beginPath(); ctx.moveTo(-hw,y0); ctx.lineTo(hw,y0); ctx.lineTo(hw-inset,y1); ctx.lineTo(-hw+inset,y1); ctx.closePath(); ctx.fillStyle=hg(-hw,hw); ctx.fill(); ctx.strokeStyle=edge; ctx.lineWidth=1.5; ctx.stroke();
    ctx.strokeStyle='rgba(120,70,0,.35)'; ctx.lineWidth=1; for(let x=-hw+16;x<hw-8;x+=22){ const k=(x/hw); ctx.beginPath(); ctx.moveTo(x,y0-2); ctx.lineTo(x-k*inset*.5,y1+2); ctx.stroke(); } };
  const smallStupa=(x,sc)=>{ ctx.save(); ctx.translate(x,-46); ctx.scale(sc,sc);
    tier(60,0,-34,8); tier(46,-34,-62,6); petals(-34,34,-62,6);
    ctx.beginPath(); ctx.moveTo(-30,-64); ctx.bezierCurveTo(-30,-110,-12,-150,0,-190); ctx.bezierCurveTo(12,-150,30,-110,30,-64); ctx.closePath(); ctx.fillStyle=hg(-30,30); ctx.fill(); ctx.strokeStyle=edge; ctx.stroke();
    ctx.strokeStyle='rgba(120,70,0,.4)'; for(let y=-80;y>-170;y-=18){ const w=26*(1-((-y-64)/130)); ctx.beginPath(); ctx.moveTo(-w,y); ctx.lineTo(w,y); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(0,-190); ctx.lineTo(0,-212); ctx.strokeStyle='#e0aa28'; ctx.lineWidth=3; ctx.stroke(); ctx.restore(); };

  ctx.shadowColor='rgba(255,214,100,.75)'; ctx.shadowBlur=42;
  // cloister wall
  ctx.beginPath(); ctx.rect(-340,-46,680,46); ctx.fillStyle=hg(-340,340); ctx.fill();
  ctx.shadowBlur=0; ctx.strokeStyle=edge; ctx.lineWidth=1.5; ctx.strokeRect(-340,-46,680,46);
  // lit arches
  for(let x=-320;x<320;x+=32){ ctx.beginPath(); ctx.moveTo(x+4,0); ctx.lineTo(x+4,-18); ctx.arc(x+16,-18,12,Math.PI,0); ctx.lineTo(x+28,0); ctx.closePath(); ctx.fillStyle='#fff6c2'; ctx.fill(); }
  // wall-top leaf spires
  ctx.shadowColor='rgba(255,214,100,.6)'; ctx.shadowBlur=14;
  for(let x=-330;x<=330;x+=22) flame(x,-46,30,8);
  // side stupas
  ctx.shadowBlur=30; smallStupa(-250,.62); smallStupa(250,.62); smallStupa(-165,.78); smallStupa(165,.78);
  // main stupa (slimmer and taller, like the real one)
  ctx.shadowBlur=36; ctx.save(); ctx.scale(.8,1.18);
  tier(150,-46,-92,10); tier(118,-92,-132,9); tier(88,-132,-166,8);
  // corner mini spires on base tiers
  for(const [x,y] of [[-140,-92],[140,-92],[-108,-132],[108,-132],[-80,-166],[80,-166]]) flame(x,y,34,8);
  petals(-70,70,-168,7);
  // lotus-bell body
  ctx.beginPath(); ctx.moveTo(-66,-170); ctx.bezierCurveTo(-72,-205,-56,-228,-46,-240); ctx.lineTo(46,-240); ctx.bezierCurveTo(56,-228,72,-205,66,-170); ctx.closePath(); ctx.fillStyle=hg(-66,66); ctx.fill(); ctx.strokeStyle=edge; ctx.lineWidth=1.5; ctx.stroke();
  // segmented tapering rings
  let y=-240, w=46; const bands=[[46,-262],[40,-284],[34,-304],[28,-322],[23,-338],[18,-352]];
  for(const [bw,by2] of bands){ ctx.beginPath(); ctx.moveTo(-w,y); ctx.lineTo(w,y); ctx.quadraticCurveTo(bw+6,(y+by2)/2,bw*0.86,by2); ctx.lineTo(-bw*0.86,by2); ctx.quadraticCurveTo(-bw-6,(y+by2)/2,-w,y); ctx.closePath(); ctx.fillStyle=hg(-bw,bw); ctx.fill(); ctx.strokeStyle=edge; ctx.lineWidth=1.3; ctx.stroke(); y=by2; w=bw*0.86; }
  // lotus-bud crown + spike
  ctx.beginPath(); ctx.moveTo(-15,-352); ctx.bezierCurveTo(-20,-380,-8,-396,0,-412); ctx.bezierCurveTo(8,-396,20,-380,15,-352); ctx.closePath(); ctx.fillStyle=hg(-15,15); ctx.fill(); ctx.strokeStyle=edge; ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0,-412); ctx.lineTo(0,-448); ctx.strokeStyle='#f2c13a'; ctx.lineWidth=3.5; ctx.stroke();
  ctx.beginPath(); ctx.arc(0,-420,4.5,0,7); ctx.arc(0,-434,3.2,0,7); ctx.fillStyle='#ffe27a'; ctx.fill();
  ctx.restore(); ctx.restore();
}

function ribbonCurl(ctx,x,y,len,rot){
  ctx.save(); ctx.translate(x,y); ctx.rotate(rot); ctx.lineCap='round';
  const g=ctx.createLinearGradient(0,0,len,0); g.addColorStop(0,'#fff0a0'); g.addColorStop(.5,'#e9b231'); g.addColorStop(1,'#fff0a0');
  ctx.strokeStyle=g; ctx.lineWidth=11; ctx.shadowColor='rgba(255,210,90,.6)'; ctx.shadowBlur=10;
  ctx.beginPath(); ctx.moveTo(0,0); ctx.bezierCurveTo(len*.3,-38,len*.6,38,len,-6); ctx.stroke(); ctx.restore();
}

function fmtDates(a,b){
  if(!a||!b) return '';
  const A=new Date(a+'T00:00:00'), B=new Date(b+'T00:00:00');
  const sameMonth=A.getMonth()===B.getMonth()&&A.getFullYear()===B.getFullYear();
  if(sameMonth) return `ວັນທີ ${A.getDate()} – ${B.getDate()} ${LAO_MONTHS[B.getMonth()]} ${B.getFullYear()}`;
  return `ວັນທີ ${A.getDate()} ${LAO_MONTHS[A.getMonth()]} – ${B.getDate()} ${LAO_MONTHS[B.getMonth()]} ${B.getFullYear()}`;
}

// ---------- main render ----------
function draw(ctx,S,o){
  const th=THEMES[o.theme]||THEMES.crimson;
  ctx.save(); ctx.scale(S,S); ctx.clearRect(0,0,W,H);
  if(o.bg){
    const iw=o.bg.width, ih=o.bg.height; const sc=Math.max(W/iw,H/ih)*(o.bgz/100); const dw=iw*sc, dh=ih*sc; ctx.drawImage(o.bg,(W-dw)*(o.bgx/100),(H-dh)*(o.bgy/100),dw,dh);
    let sg=ctx.createLinearGradient(0,0,W,0); sg.addColorStop(0,'rgba(60,0,30,.22)'); sg.addColorStop(.45,'rgba(60,0,30,.06)'); sg.addColorStop(1,'rgba(60,0,30,0)'); ctx.fillStyle=sg; ctx.fillRect(0,0,W,H);
    sg=ctx.createRadialGradient(745,590,40,745,590,330); sg.addColorStop(0,'rgba(70,0,35,.30)'); sg.addColorStop(1,'rgba(70,0,35,0)'); ctx.fillStyle=sg; ctx.fillRect(400,380,680,420);
  } else {
  let g=ctx.createLinearGradient(0,0,W*0.6,H); g.addColorStop(0,th.bg[0]); g.addColorStop(.55,th.bg[1]); g.addColorStop(1,th.bg[2]);
  ctx.fillStyle=g; ctx.fillRect(0,0,W,H);
  g=ctx.createRadialGradient(830,640,20,830,640,520); g.addColorStop(0,'rgba(255,200,140,.55)'); g.addColorStop(.5,'rgba(255,150,150,.18)'); g.addColorStop(1,'rgba(255,150,150,0)');
  ctx.fillStyle=g; ctx.fillRect(0,0,W,H);
  // haze under stupa
  g=ctx.createRadialGradient(900,830,10,900,830,300); g.addColorStop(0,'rgba(255,200,150,.40)'); g.addColorStop(1,'rgba(255,200,150,0)'); ctx.fillStyle=g; ctx.fillRect(500,520,580,560);
  stupa(ctx,900,858,.8);
  }

  silk(ctx,th,(o.pat==null?30:o.pat)/100);
  // bunting
  ctx.save(); ctx.lineWidth=3; ctx.strokeStyle='#f3cf5e';
  const bp=(t)=>[t*430, 210-Math.sin(t*Math.PI*.5)*118-(1-t)*0];
  ctx.beginPath(); for(let t=0;t<=1.001;t+=.02){const [x,y]=bp(t); t?ctx.lineTo(x,y):ctx.moveTo(x,y);} ctx.stroke();
  for(let i=0;i<5;i++){ const t=(i+.5)/5.1; const [x,y]=bp(t); const ang=-0.28; ctx.save(); ctx.translate(x,y); ctx.rotate(ang+ (i-2)*-0.03);
    const gg=ctx.createLinearGradient(0,0,0,92); gg.addColorStop(0,'#ffe566'); gg.addColorStop(1,i%2?'#e8a912':'#f6c62f'); ctx.fillStyle=gg; ctx.shadowColor='rgba(0,0,0,.25)'; ctx.shadowBlur=8;
    ctx.beginPath(); ctx.moveTo(-34,0); ctx.lineTo(34,0); ctx.lineTo(0,96); ctx.closePath(); ctx.fill(); ctx.restore(); }
  ctx.restore();
  // shop tab
  ctx.save(); ctx.shadowColor='rgba(0,0,0,.3)'; ctx.shadowBlur=14; ctx.fillStyle='#fff';
  ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(372,0); ctx.arcTo(372,98,282,98,56); ctx.lineTo(0,98); ctx.closePath(); ctx.fill(); ctx.restore();
  ctx.save(); ctx.strokeStyle='#f0c24a'; ctx.lineWidth=4; ctx.beginPath(); ctx.moveTo(0,100); ctx.lineTo(300,100); ctx.arcTo(378,100,378,30,60); ctx.lineTo(376,0); ctx.stroke(); ctx.restore();
  { const FM={pf:{fam:'SPF',max:58,base:68,w:'700 italic'},gv:{fam:'SGV',max:84,base:70,w:''},cd:{fam:'SCD',max:44,base:64,w:'700'}}[o.shopfont]||{fam:'SPF',max:58,base:68,w:'700 italic'};
    let s=FM.max; const fs=(z)=>`${FM.w?'':''}${z}px ${FM.fam}, serif`; ctx.font=fs(s); while(ctx.measureText(o.shop||'').width>290&&s>20){s-=2;ctx.font=fs(s);}
    textO(ctx,o.shop||'',176,FM.base,fs(s),th.deep,null,0);
    ctx.save(); ctx.strokeStyle='#e6b93d'; ctx.lineWidth=2.5; ctx.beginPath(); ctx.moveTo(70,84); ctx.lineTo(166,84); ctx.moveTo(186,84); ctx.lineTo(282,84); ctx.stroke();
    ctx.fillStyle='#e6b93d'; ctx.beginPath(); ctx.moveTo(176,78); ctx.lineTo(182,84); ctx.lineTo(176,90); ctx.lineTo(170,84); ctx.closePath(); ctx.fill(); ctx.restore(); }

  // headline
  textO(ctx,'ຕ້ອນຮັບ',775,196,F(9,118),'#ffffff',th.deep,10,'center',{c:'rgba(0,0,0,.35)',b:18,y:6});
  { let s=128; ctx.font=F(9,s); while(ctx.measureText('ບຸນທາດຫຼວງ').width>590&&s>60){s-=2;ctx.font=F(9,s);}
    textO(ctx,'ບຸນທາດຫຼວງ',775,326,F(9,s),th.head2,th.deep,12,'center',{c:'rgba(0,0,0,.35)',b:18,y:6}); }
  // FESTIVAL SALE ribbon
  ctx.save(); const rx=520, ry=352, rw=510, rh=64;
  const rg=ctx.createLinearGradient(0,ry,0,ry+rh); rg.addColorStop(0,'#fff0a0'); rg.addColorStop(.5,'#f2bf34'); rg.addColorStop(1,'#d79a16');
  ctx.shadowColor='rgba(0,0,0,.3)'; ctx.shadowBlur=12; ctx.fillStyle=rg;
  ctx.beginPath(); ctx.moveTo(rx+18,ry); ctx.lineTo(rx+rw-18,ry); ctx.lineTo(rx+rw,ry+rh/2); ctx.lineTo(rx+rw-18,ry+rh); ctx.lineTo(rx+18,ry+rh); ctx.lineTo(rx,ry+rh/2); ctx.closePath(); ctx.fill(); ctx.restore();
  ctx.save(); ctx.translate(775,ry+45); ctx.transform(1,0,-0.16,1,0,0); textO(ctx,'FESTIVAL SALE',0,0,F(9,46),th.text2,null,0); ctx.restore();

  // date pill
  const dt=fmtDates(o.d1,o.d2);
  if(dt){ ctx.save(); ctx.font=F(8,34); const tw=Math.min(ctx.measureText(dt).width+60,540); const px=775-tw/2;
    ctx.fillStyle='rgba(255,255,255,.18)'; rr(ctx,px,438,tw,56,28); ctx.fill(); ctx.strokeStyle='#f3cf5e'; ctx.lineWidth=3; ctx.stroke(); ctx.restore();
    let s=34; ctx.font=F(8,s); while(ctx.measureText(dt).width>tw-40&&s>20){s-=1;ctx.font=F(8,s);} textO(ctx,dt,775,478,F(8,s),'#fff',null,0); }

  // product name
  { const maxH=o.sub?140:190; const f=fitBlock(ctx,o.name||'',9,500,maxH,74,30,1.1);
    const total=f.lines.length*f.size*1.1; let y=512+ (maxH-total)/2 + f.size*0.9;
    for(const l of f.lines){ textO(ctx,l,745,y,F(9,f.size),'#ffffff',th.deep,8,'center',{c:'rgba(0,0,0,.35)',b:14,y:4}); y+=f.size*1.1; }
    if(o.sub){ ctx.save(); ctx.font=F(8,32); let s=32; while(ctx.measureText(o.sub).width>470&&s>18){s-=1;ctx.font=F(8,s);} const tw=ctx.measureText(o.sub).width+56; const px=745-tw/2;
      const pg=ctx.createLinearGradient(0,0,0,50); pg.addColorStop(0,'#fff0a0'); pg.addColorStop(1,'#f0bd30'); ctx.fillStyle=pg; rr(ctx,px,664,tw,50,25); ctx.fill(); ctx.restore();
      textO(ctx,o.sub,745,700,F(8,s),th.text2,null,0); } }

  // arch (rounded floor) + plinth inside it + product
  const ax=62,ay=352,aw=410,ah=574, RY=46, cx0=ax+aw/2, yb=ay+ah-RY;
  const archPath=(x,y,w,h,ry)=>{ const r=w/2; ctx.beginPath(); ctx.moveTo(x,y+h-ry); ctx.lineTo(x,y+r); ctx.arc(x+r,y+r,r,Math.PI,0); ctx.lineTo(x+w,y+h-ry); ctx.ellipse(x+r,y+h-ry,r,ry,0,0,Math.PI); ctx.closePath(); };
  ctx.save(); const ag=ctx.createLinearGradient(0,ay,0,ay+ah); ag.addColorStop(0,'#fff6ea'); ag.addColorStop(1,'#ffe3cf');
  ctx.shadowColor='rgba(0,0,0,.35)'; ctx.shadowBlur=26; ctx.shadowOffsetY=8; ctx.fillStyle=ag; archPath(ax,ay,aw,ah,RY); ctx.fill();
  ctx.shadowColor='transparent'; ctx.strokeStyle='#f0c24a'; ctx.lineWidth=7; ctx.stroke(); ctx.restore();
  const photoMode=(o.mode==='photo' && o.raw);
  if(!photoMode){
    // plinth: a gold-cream disc lying on the floor of the arch (same curve as the arch bottom, slightly smaller)
    ctx.save(); archPath(ax,ay,aw,ah,RY); ctx.clip();
    const rx=aw/2-20, ry=34, cy=yb+4;
    let pg2=ctx.createLinearGradient(0,cy-ry,0,cy+ry+14); pg2.addColorStop(0,'#fff8dc'); pg2.addColorStop(.6,'#f6dc98'); pg2.addColorStop(1,'#e2b25a');
    ctx.fillStyle=pg2; ctx.shadowColor='rgba(120,60,20,.35)'; ctx.shadowBlur=14; ctx.shadowOffsetY=5;
    ctx.beginPath(); ctx.ellipse(cx0,cy+8,rx,ry,0,0,Math.PI*2); ctx.fill();   // side thickness
    ctx.shadowColor='transparent';
    pg2=ctx.createLinearGradient(0,cy-ry,0,cy+ry); pg2.addColorStop(0,'#fffbe8'); pg2.addColorStop(1,'#f8e6ac');
    ctx.fillStyle=pg2; ctx.beginPath(); ctx.ellipse(cx0,cy,rx,ry,0,0,Math.PI*2); ctx.fill();   // top surface
    ctx.strokeStyle='rgba(240,194,74,.9)'; ctx.lineWidth=3; ctx.stroke();
    ctx.restore();
  }
  if(photoMode){
    // whole photo, cover-fitted and clipped inside the arch (for photos that cannot be cut out cleanly)
    const r=o.raw, iw=r.naturalWidth||r.width, ih=r.naturalHeight||r.height, pad=9;
    const bx=ax+pad, bw2=aw-2*pad, by=ay+pad, bh2=ah-2*pad;
    ctx.save(); archPath(bx,by,bw2,bh2,RY-pad); ctx.clip();
    const sc=Math.max(bw2/iw,bh2/ih), dw=iw*sc, dh=ih*sc; ctx.drawImage(r,bx+(bw2-dw)/2,by+(bh2-dh)/2,dw,dh); ctx.restore();
    ctx.save(); ctx.strokeStyle='#f0c24a'; ctx.lineWidth=7; archPath(ax,ay,aw,ah,RY); ctx.stroke(); ctx.restore();
  } else if(o.img){ const pimg=(o.enh!==false && o.mode!=='photo')?enhanceCut(o.img):o.img; const iw=o.img.width, ih=o.img.height; const bw=300, bh=470; const sc=Math.min(bw/iw,bh/ih); const dw=iw*sc, dh=ih*sc; const baseY=yb+6;
    if(o.enh!==false){   // soft warm glow behind the product + mirror reflection on the plinth, both kept inside the arch
      ctx.save(); archPath(ax,ay,aw,ah,RY); ctx.clip();
      const gl=ctx.createRadialGradient(cx0,baseY-dh*.5,10,cx0,baseY-dh*.5,Math.max(dw,dh)*.75); gl.addColorStop(0,'rgba(255,250,228,.50)'); gl.addColorStop(1,'rgba(255,250,228,0)'); ctx.fillStyle=gl; ctx.fillRect(ax,ay,aw,ah);
      ctx.drawImage(reflectionOf(pimg,dw,dh),cx0-dw/2,baseY+2,dw,Math.round(dh*.30)); ctx.restore(); }
    ctx.save(); const cs=ctx.createRadialGradient(cx0,baseY,2,cx0,baseY,dw*.5); cs.addColorStop(0,'rgba(110,50,30,.45)'); cs.addColorStop(1,'rgba(110,50,30,0)');
    ctx.translate(0,baseY); ctx.scale(1,.2); ctx.translate(0,-baseY); ctx.fillStyle=cs; ctx.beginPath(); ctx.arc(cx0,baseY,dw*.5,0,Math.PI*2); ctx.fill(); ctx.restore();   // contact shadow
    ctx.save(); ctx.shadowColor='rgba(60,20,30,.4)'; ctx.shadowBlur=22; ctx.shadowOffsetY=10; ctx.drawImage(pimg,cx0-dw/2,baseY-dh,dw,dh); ctx.restore(); }

  // price panel
  { const x=520,y=776,w=520,h=168; const pgp=ctx.createLinearGradient(0,y,0,y+h); pgp.addColorStop(0,th.panel[0]); pgp.addColorStop(1,th.panel[1]);
    const path=()=>{ ctx.beginPath(); ctx.moveTo(x+22,y); ctx.lineTo(x+w-22,y); ctx.lineTo(x+w,y+22); ctx.lineTo(x+w,y+h-22); ctx.lineTo(x+w-22,y+h); ctx.lineTo(x+22,y+h); ctx.lineTo(x,y+h-22); ctx.lineTo(x,y+22); ctx.closePath(); };
    ctx.save(); ctx.shadowColor='rgba(0,0,0,.4)'; ctx.shadowBlur=24; ctx.shadowOffsetY=8; ctx.fillStyle=pgp; path(); ctx.fill(); ctx.restore();
    ctx.save(); ctx.strokeStyle='#f6d36a'; ctx.lineWidth=6; path(); ctx.stroke(); ctx.restore();
    const bolt=(bx,by,sg)=>{ ctx.save(); ctx.translate(bx,by); ctx.scale(sg,1); ctx.fillStyle='#ffe21a'; ctx.shadowColor='rgba(255,226,26,.7)'; ctx.shadowBlur=14;
      ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(44,0); ctx.lineTo(26,50); ctx.lineTo(56,50); ctx.lineTo(-6,126); ctx.lineTo(8,66); ctx.lineTo(-14,66); ctx.closePath(); ctx.fill(); ctx.restore(); };
    bolt(x+34,y-40,1); bolt(x+w-34,y-40,-1);
    textO(ctx,'ລາຄາພິເສດ',x+w/2,y+62,F(9,50),'#fff',null,0);
    const price=Number(o.price||0).toLocaleString('en-US'); let ps=112; ctx.font=F(9,ps); let unitW=100;
    while(ctx.measureText(price).width+unitW+20>w-60&&ps>50){ps-=2;ctx.font=F(9,ps);}
    const pw=ctx.measureText(price).width; const startX=x+w/2-(pw+unitW+16)/2;
    const pgc=ctx.createLinearGradient(0,y+90,0,y+170); pgc.addColorStop(0,'#fff27a'); pgc.addColorStop(1,'#ffd400');
    textO(ctx,price,startX,y+h-24,F(9,ps),pgc,th.deep,10,'left',{c:'rgba(0,0,0,.35)',b:10,y:4});
    textO(ctx,'ກີບ',startX+pw+16,y+h-30,F(9,52),'#ffe14a',null,0,'left'); }

  // CTA
  { const cx=540,cy=1008; ctx.save(); ctx.font=F(9,56); const tw=ctx.measureText(o.cta||'').width+130; const x=cx-tw/2;
    const cg=ctx.createLinearGradient(0,cy-44,0,cy+44); cg.addColorStop(0,'#fff0a0'); cg.addColorStop(.5,'#f4c53a'); cg.addColorStop(1,'#e3a21a');
    ctx.shadowColor='rgba(0,0,0,.35)'; ctx.shadowBlur=18; ctx.shadowOffsetY=6; ctx.fillStyle=cg; rr(ctx,x,cy-40,tw,80,40); ctx.fill(); ctx.restore();
    textO(ctx,o.cta||'',cx,cy+19,F(9,56),th.deep,null,0);
    ctx.save(); ctx.strokeStyle='#f3cf5e'; ctx.lineWidth=3; ctx.beginPath(); ctx.moveTo(56,cy); ctx.lineTo(x-26,cy); ctx.moveTo(x+tw+26,cy); ctx.lineTo(W-56,cy); ctx.stroke(); ctx.restore(); }

  // ribbons + sparkles
  ribbonCurl(ctx,40,338,95,-.9); ribbonCurl(ctx,985,560,90,-2.2); ribbonCurl(ctx,1000,985,90,-2.6);
  star(ctx,565,140,34); star(ctx,135,300,26); star(ctx,1075*0.97,150,16,.9); star(ctx,462,235,13,.8); star(ctx,1050,700,12,.8); star(ctx,40,880,12,.8); star(ctx,1040,372,10,.7);
  ctx.restore();
}

