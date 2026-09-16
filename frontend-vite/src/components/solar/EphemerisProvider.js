export function hermite(a, b, t, h) {
  const t2=t*t, t3=t2*t;
  const h00=2*t3-3*t2+1, h10=t3-2*t2+t, h01=-2*t3+3*t2, h11=t3-t2;
  return a.map((x,i)=>h00*a[i]+h10*h*b[i+3]+h01*b[i]+h11*h*b[i+3]);
}
export function hermiteState(a,b,t,h){
  const p=hermite(a.slice(1,4),b.slice(1,4),t,h);
  const t2=t*t;
  const dh00=(6*t2-6*t)/h, dh10=3*t2-4*t+1, dh01=(-6*t2+6*t)/h, dh11=3*t2-2*t;
  const v=a.slice(1,4).map((x,i)=>dh00*x+dh10*a[i+4]+dh01*b[i+1]+dh11*b[i+4]);
  return {position:p,velocity:v};
}
export function createEphemerisProvider(data) {
  if (!data || !Array.isArray(data.states) || data.states.length < 2) return {ok:false,error:'invalid states'};
  const states=data.states;
  return { ok:true, sample(jd) {
    if (jd<states[0][0] || jd>states.at(-1)[0]) return {ok:false,error:'out_of_range'};
    let i=states.length-2; for(let j=0;j<states.length-1;j++) if(jd<=states[j+1][0]) {i=j;break;}
    const a=states[i], b=states[i+1], h=b[0]-a[0], t=(jd-a[0])/h;
    return {ok:true,...hermiteState(a,b,t,h)};
  }};
}
