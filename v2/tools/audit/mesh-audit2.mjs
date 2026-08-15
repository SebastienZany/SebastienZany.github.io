// Round-2 claim verification: slit components, boundary-tri altitudes, corner angle defects.
import { readFileSync } from 'node:fs';
const GLB = '/Users/work/Projects/physarum-17/.claude/worktrees/art-game-webgpu-d697c0/luyvwj-fwgyww.glb';
const buf = readFileSync(GLB);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const jsonLen = dv.getUint32(12, true);
const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
let off = 20 + jsonLen; const bin = buf.subarray(off + 8, off + 8 + dv.getUint32(off, true));
function acc(i){const a=json.accessors[i];const bv=json.bufferViews[a.bufferView];const s=(bv.byteOffset||0)+(a.byteOffset||0);const c={SCALAR:1,VEC2:2,VEC3:3}[a.type];const n=a.count*c;
if(a.componentType===5126)return new Float32Array(bin.buffer,bin.byteOffset+s,n);
if(a.componentType===5125)return new Uint32Array(bin.buffer,bin.byteOffset+s,n);
return Uint32Array.from(new Uint16Array(bin.buffer,bin.byteOffset+s,n));}
const prim=json.meshes[0].primitives[0];
const pos=acc(prim.attributes.POSITION), uv=acc(prim.attributes.TEXCOORD_0), idx=acc(prim.indices);
const triCount=idx.length/3;
const edgeMap=new Map();
for(let t=0;t<triCount;t++)for(let e=0;e<3;e++){const i0=idx[3*t+e],i1=idx[3*t+(e+1)%3];const k=i0<i1?i0+'_'+i1:i1+'_'+i0;(edgeMap.get(k)??edgeMap.set(k,[]).get(k)).push({t,i0,i1});}
const parent=new Int32Array(triCount).map((_,i)=>i);
const find=x=>{while(parent[x]!==x){parent[x]=parent[parent[x]];x=parent[x];}return x;};
const boundary=[];
for(const arr of edgeMap.values()){if(arr.length===2){const a=find(arr[0].t),b=find(arr[1].t);if(a!==b)parent[a]=b;}else if(arr.length===1)boundary.push(arr[0]);}
const chartOf=new Int32Array(triCount);const ids=new Map();
for(let t=0;t<triCount;t++){const r=find(t);if(!ids.has(r))ids.set(r,ids.size);chartOf[t]=ids.get(r);}
const Q=1e-5;const pk=i=>`${Math.round(pos[3*i]/Q)}_${Math.round(pos[3*i+1]/Q)}_${Math.round(pos[3*i+2]/Q)}`;
const pem=new Map();
for(const e of boundary){const a=pk(e.i0),b=pk(e.i1);const k=a<b?a+'|'+b:b+'|'+a;(pem.get(k)??pem.set(k,[]).get(k)).push(e);}
// slit pairs + component union-find over shared endpoints
const slitEdges=[];
for(const arr of pem.values())if(arr.length===2&&chartOf[arr[0].t]===chartOf[arr[1].t])slitEdges.push(arr);
const ep=new Map();const sp=new Int32Array(slitEdges.length).map((_,i)=>i);
const sf=x=>{while(sp[x]!==x){sp[x]=sp[sp[x]];x=sp[x];}return x;};
slitEdges.forEach((arr,i)=>{for(const e of arr)for(const v of [e.i0,e.i1]){const k=pk(v);if(ep.has(k)){const a=sf(ep.get(k)),b=sf(i);if(a!==b)sp[a]=b;}else ep.set(k,i);}});
const comp=new Set();for(let i=0;i<slitEdges.length;i++)comp.add(sf(i));
let maxComp=0;const sizes=new Map();for(let i=0;i<slitEdges.length;i++){const r=sf(i);sizes.set(r,(sizes.get(r)||0)+1);}
for(const v of sizes.values())maxComp=Math.max(maxComp,v);
console.log(`slit pairs ${slitEdges.length}  components ${comp.size}  largest ${maxComp}`);
// boundary-side adjacent-triangle UV altitude at 1536 (altitude of the opposite vertex over the boundary edge, in texels)
const N=1536;let below4=0,alts=[];
for(const arr of pem.values()){if(arr.length!==2)continue;for(const e of arr){
const t=e.t;const vs=[idx[3*t],idx[3*t+1],idx[3*t+2]];const other=vs.find(v=>v!==e.i0&&v!==e.i1);
const ax=uv[2*e.i0]*N,ay=uv[2*e.i0+1]*N,bx=uv[2*e.i1]*N,by=uv[2*e.i1+1]*N,cx=uv[2*other]*N,cy=uv[2*other+1]*N;
const len=Math.hypot(bx-ax,by-ay);if(len<1e-9)continue;
const alt=Math.abs((bx-ax)*(ay-cy)-(ax-cx)*(by-ay))/len;alts.push(alt);if(alt<4)below4++;}}
alts.sort((a,b)=>a-b);
console.log(`boundary sides ${alts.length}  altitude<4texels ${below4}  median ${alts[Math.floor(alts.length/2)].toFixed(2)}`);
// corner angle defect at multi-chart vertices (sum of incident triangle angles vs 2pi)
const vertTris=new Map();
for(let t=0;t<triCount;t++)for(let e=0;e<3;e++){const k=pk(idx[3*t+e]);(vertTris.get(k)??vertTris.set(k,[]).get(k)).push({t,v:idx[3*t+e]});}
const vertCharts=new Map();
for(let t=0;t<triCount;t++)for(let e=0;e<3;e++){const k=pk(idx[3*t+e]);(vertCharts.get(k)??vertCharts.set(k,new Set()).get(k)).add(chartOf[t]);}
let pd=0,nd=0,flat=0,multi=0;
for(const [k,s] of vertCharts){if(s.size<3)continue;multi++;
let sum=0;for(const {t,v} of vertTris.get(k)){
const vs=[idx[3*t],idx[3*t+1],idx[3*t+2]];const o=vs.filter(x=>x!==v);
const ax=pos[3*v],ay=pos[3*v+1],az=pos[3*v+2];
const u1=[pos[3*o[0]]-ax,pos[3*o[0]+1]-ay,pos[3*o[0]+2]-az];
const u2=[pos[3*o[1]]-ax,pos[3*o[1]+1]-ay,pos[3*o[1]+2]-az];
const d=(u1[0]*u2[0]+u1[1]*u2[1]+u1[2]*u2[2])/((Math.hypot(...u1)*Math.hypot(...u2))||1);
sum+=Math.acos(Math.max(-1,Math.min(1,d)));}
const defect=2*Math.PI-sum;
if(defect>0.05)pd++;else if(defect<-0.05)nd++;else flat++;}
console.log(`multi-chart(>=3) verts ${multi}  defect>+0.05rad ${pd}  <-0.05rad ${nd}  ~flat ${flat}`);
