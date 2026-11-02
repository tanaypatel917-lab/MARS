import { noise } from '../shaders';

/**
 * Shaders of the colonised Martian landscape under the /how stele. Everything is tinted by one fog colour (uFog), which the
 * page tweens per move: the sky gradient rises out of it, far terrain dissolves into it, the pools mirror it and the colony
 * hairlines fade into it. Colours are composed in linear light, tone-mapped and gamma-encoded, then hazed toward uFog in
 * linear light as well (three stores Color uniforms linear), and gamma-encoded last, so a fully fogged fragment is exactly the sky.
 */

/** Sky colour along a world direction: fog at the horizon, #050407 at the zenith, a dusty 3-octave breakup near the ground. */
export const skyChunk = /* glsl */`
vec3 sky(vec3 d,vec3 fog,float hz,float t,vec3 key,float stage){
 float e=d.y;
#ifdef LITE
 float n=.5+(vnoise(d*vec3(2.6,5.2,2.6)+vec3(t*.012,0.,t*.008))-.5)*.5;
#else
 float n=0.,a=.5;vec3 q=d*vec3(2.6,5.2,2.6)+vec3(t*.012,0.,t*.008);for(int i=0;i<3;i++){n+=a*vnoise(q);q=q*2.1+vec3(1.3,7.7,3.1);a*=.5;}
#endif
 float k=smoothstep(hz,hz+.26,e+(n-.44)*.05);k=pow(k,.42);
 vec3 top=vec3(.0015,.0012,.0023);
 vec3 c=mix(fog,top,k);
 c*=1.+(n-.5)*.28*(1.-k);
 /* stratified dust: thin horizontal layers drifting over the low sky, and a finer high haze that breaks the gradient up (not on the lite tier) */
#ifndef LITE
 float layers=0.;{vec3 lq=vec3(d.x*1.2+t*.006,e*26.,d.z*1.2);layers=(vnoise(lq)*.6+vnoise(lq*vec3(2.3,1.7,2.3)+vec3(5.,0.,2.))*.4-.5);}
 c*=1.+layers*.22*exp(-pow((e-hz-.05)/.12,2.));
 float cirrus=ridged(vec3(d.x*3.5+t*.004,e*9.+t*.002,d.z*3.5))-.55;
 c+=fog*max(cirrus,0.)*.16*smoothstep(hz+.05,hz+.3,e)*(1.-smoothstep(.3,.7,e));
#endif
 c+=fog*exp(-pow((e-hz)/.04,2.))*.18;
 /* the key light glows through the dust low in the sky on its side */
 float toward=max(0.,dot(normalize(vec3(d.x,0.,d.z)),normalize(vec3(key.x,0.,key.z))));
 c+=(fog*1.4+vec3(.03,.02,.012))*pow(toward,7.)*exp(-pow((e-hz-.03)/.11,2.))*.75;
 /* the settlement's light dome: a warm glow hugging the horizon that grows with the colonisation stage */
 c+=(fog*.9+vec3(.05,.025,.01))*exp(-pow(max(0.,e-hz)/.075,1.4))*(.07+.16*stage*.25)*(.8+.2*n);
 c*=1.-.4*smoothstep(hz,hz-.25,e);
 return c;}
`;

export const skyVertex = /* glsl */`
uniform mat4 uProjInv;uniform mat4 uCamWorld;varying vec3 vRay;varying vec2 vUv;
void main(){vUv=uv;vec4 v=uProjInv*vec4(position.xy,1.,1.);vRay=mat3(uCamWorld)*(v.xyz/v.w);gl_Position=vec4(position.xy,1.,1.);}
`;
export const skyFragment = /* glsl */`
precision highp float;
uniform vec3 uFog;uniform vec3 uKey;uniform float uTime;uniform float uHorizon;uniform float uStage;varying vec3 vRay;varying vec2 vUv;
${noise}
${skyChunk}
void main(){vec3 d=normalize(vRay);vec3 c=sky(d,uFog,uHorizon,uTime,uKey,uStage);
 float vignette=1.-.28*pow(length((vUv-vec2(.5,.42))*vec2(1.,.9)),1.8);c*=vignette;
 c=pow(max(c,0.),vec3(1./2.2))+(hash(vec3(gl_FragCoord.xy,floor(uTime*6.)))-.5)*.02;
 gl_FragColor=vec4(max(c,0.),1.);}
`;

/**
 * Terrain: smooth-shaded regolith — the mesh's analytic normal (falling back to screen derivatives for solids without one) plus a
 * per-pixel bump of wind ripples, grain and scattered rubble that fades with distance; the planet's basalt→rust albedo, broken up
 * by large-scale dust/basalt streaks and pale dust pooling in the basins, lit by the key with the home page's violet wrap; fragments at or below the pool level become a flat glossy surface that mirrors the sky with a
 * Fresnel weight and takes a hard specular from the key. Distance haze is exp(-d²k) toward the sky behind the fragment.
 */
export const terrainVertex = /* glsl */`
attribute float aRelief;attribute float aBirth;uniform float uStage;varying vec3 vWorld;varying vec3 vNormal;varying float vRelief;varying float vBorn;
void main(){vec4 w=modelMatrix*vec4(position,1.);vWorld=w.xyz;vNormal=mat3(modelMatrix)*normal;vRelief=aRelief;vBorn=step(aBirth-.4,uStage);gl_Position=projectionMatrix*viewMatrix*w;}
`;
export const terrainFragment = /* glsl */`
precision highp float;
uniform vec3 uKey;uniform vec3 uCamera;uniform vec3 uFog;uniform float uTime;uniform float uPool;uniform float uFogK;uniform float uHorizon;uniform float uFogH;uniform float uBase;uniform float uStage;
varying vec3 vWorld;varying vec3 vNormal;varying float vRelief;varying float vBorn;
${noise}
${skyChunk}
/* regolith micro-relief in world xz: wind ripples across the dune direction, fine grain, and sparse rubble bumps */
float regolith(vec2 p){
 float rip=sin(p.x*1.9+p.y*.7+vnoise(vec3(p*.21,3.))*5.)*.5+.5;rip*=rip;
 float grain=vnoise(vec3(p*2.6,7.))*.5+vnoise(vec3(p*7.,11.))*.25;
 float rub=vnoise(vec3(p*1.1,19.));rub=smoothstep(.62,.8,rub);
 return rip*.35+grain*.45+rub*.22;}
void main(){
 if(vBorn<.5)discard;
 vec3 gn=normalize(cross(dFdx(vWorld),dFdy(vWorld)));if(gn.y<0.)gn=-gn;
 vec3 n=length(vNormal)>.5?normalize(vNormal):gn;
 vec3 toEye=uCamera-vWorld;float dist=length(toEye);vec3 eye=toEye/dist;vec3 key=normalize(uKey);
 /* per-pixel detail: finite-differenced regolith height into the smooth normal, strongest near, gone in the haze */
 float detail=(1.-smoothstep(15.,110.,dist))*smoothstep(uPool+.02,uPool+.5,vRelief);
#ifdef LITE
 detail=0.;
#endif
 if(detail>.001){vec2 p=vWorld.xz;float e=.12;float h0=regolith(p);float hx=regolith(p+vec2(e,0.));float hz=regolith(p+vec2(0.,e));
  n=normalize(n+vec3(h0-hx,0.,h0-hz)*(1.7*detail));}
 float lowland=smoothstep(-1.,5.,vRelief);
 /* albedo: basalt→rust by relief, broken by large dark streaks on the flanks and pale dust pooled in the basins */
#ifdef LITE
 float streak=.5,dustp=0.;
#else
 float streak=fbm(vec3(vWorld.xz*.045,1.5));float dustp=smoothstep(.45,.75,fbm(vec3(vWorld.xz*.02+7.,4.)))*(1.-smoothstep(1.5,4.5,vRelief))*n.y;
#endif
 vec3 basalt=vec3(.045,.024,.018),rust=vec3(.27,.10,.05),pale=vec3(.34,.19,.12);
 vec3 albedo=mix(basalt,rust,lowland*(.55+.9*streak));albedo=mix(albedo,pale,dustp*.6);albedo*=.32;
 float diffuse=pow(max(0.,dot(n,key)),1.4)*smoothstep(-.1,.3,dot(normalize(length(vNormal)>.5?vNormal:gn),key));
 vec3 c=albedo*(diffuse*.62*vec3(1.,.93,.84)+.004)+albedo*vec3(.07,.11,.30)*pow(max(0.,dot(n,normalize(vec3(.6,.5,.75)))),1.4)*.16;
 /* the dust-lit sky falls on upward faces, so crests take the fog's tint; a satin sheen catches the key on crests facing it */
 c+=albedo*uFog*(.35+.65*max(n.y,0.))*.9;
 c+=pow(max(0.,dot(n,normalize(key+eye))),28.)*uFog*.35*smoothstep(1.,4.,vRelief);
 /* pools: flat, mirroring the sky with a Fresnel weight, a hard key glint */
 vec3 up=vec3(0.,1.,0.);float cosE=max(0.,eye.y);float f=.04+.96*pow(1.-cosE,5.);
 vec3 mirrored=sky(reflect(-eye,up),uFog,uHorizon,uTime,key,uStage);
 vec3 h=normalize(key+eye);float spec=pow(max(0.,dot(up,h)),420.)*1.2+pow(max(0.,dot(up,h)),14.)*.012;
 vec3 pc=vec3(.0025,.002,.0035)+mix(mirrored,uFog*.55,.4)*f*1.1+spec*vec3(1.,.93,.84)*(.2+.8*f);
 float pool=1.-smoothstep(uPool+.005,uPool+.05,vRelief);
 c=mix(c,pc,pool);
 c=c/(1.+c*.25);
 /* haze toward the sky behind the fragment, so the far terrain dissolves into it wherever the horizon falls */
 float thin=exp(-max(0.,vWorld.y-uBase)/uFogH);
 float haze=1.-exp(-dist*dist*uFogK*thin);haze=mix(haze,1.,(1.-haze)*(1.-smoothstep(uPool,uPool+2.5,vRelief))*.1);
 c=mix(c,sky(-eye,uFog,uHorizon,uTime,key,uStage),haze);
 float grain=(hash(vec3(gl_FragCoord.xy,floor(uTime*6.)))-.5)*.012;
 gl_FragColor=vec4(pow(max(c,0.),vec3(1./2.2))+grain,1.);}
`;

/**
 * Hairline colony outlines and warm window lights, sinking into the fog with the terrain. Vertices carry the landscapeKit
 * attributes: elements draw on as uStage passes aBirth (along aT for strokes), aRise > 0 loops the element upward as an ascending
 * ship, aPhase de-synchronises flicker and rise loops.
 */
export const colonyVertex = /* glsl */`
attribute float aBirth;attribute float aT;attribute float aRise;attribute float aPhase;attribute float aSize;
uniform float uSize;uniform float uStage;uniform float uTime;uniform float uPoint;uniform vec2 uOffset;
varying vec3 vWorld;varying float vFade;varying float vPhase;
void main(){
 vec3 p=position;float life=0.;
 if(aRise>0.){life=fract(uTime*.03*aRise+aPhase);float s=life*life;p.y+=s*90.;p.x+=s*10.*sin(aPhase*6.2832);p.z+=s*10.*cos(aPhase*6.2832);}
 vec4 w=modelMatrix*vec4(p,1.);vWorld=w.xyz;
 float grow=clamp((uStage-aBirth+1.)*1.6-aT*.6,0.,1.);grow=grow*grow*(3.-2.*grow);
 vFade=grow*(aRise>0.?smoothstep(0.,.08,life)*(1.-smoothstep(.55,.95,life)):1.);
 vPhase=aPhase;
 gl_Position=projectionMatrix*viewMatrix*w;gl_Position.xy+=uOffset*gl_Position.w;
 gl_PointSize=uSize*(uPoint>.5?max(aSize,.001)*(aRise>0.?1.6:1.):1.);
}
`;
export const colonyFragment = /* glsl */`
precision highp float;
uniform vec3 uColor;uniform vec3 uFog;uniform vec3 uKey;uniform vec3 uCamera;uniform float uOpacity;uniform float uFogK;uniform float uPoint;uniform float uTime;uniform float uHorizon;uniform float uFogH;uniform float uBase;uniform float uStage;
varying vec3 vWorld;varying float vFade;varying float vPhase;
${noise}
${skyChunk}
void main(){
 if(vFade<.002)discard;
 float m=1.;if(uPoint>.5){float r=length(gl_PointCoord-.5)*2.;if(r>1.)discard;m=(exp(-r*r*26.)*1.6+exp(-r*r*3.2)*.09)*(.82+.18*sin(uTime*(2.+vPhase*3.)+vPhase*40.));}
 vec3 toEye=uCamera-vWorld;float dist=length(toEye);float thin=exp(-max(0.,vWorld.y-uBase)/uFogH);float haze=1.-exp(-dist*dist*uFogK*thin);
 vec3 c=mix(uColor,sky(-toEye/dist,uFog,uHorizon,uTime,uKey,uStage)*2.2+.004,haze*.9);
 gl_FragColor=vec4(pow(c,vec3(1./2.2)),uOpacity*m*vFade*(1.-haze*.92));}
`;
