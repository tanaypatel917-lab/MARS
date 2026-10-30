import { noise } from '../shaders';

/**
 * Shaders of the colonised Martian landscape under the /how stele. Everything is tinted by one fog colour (uFog), which the
 * page tweens per move: the sky gradient rises out of it, far terrain dissolves into it, the pools mirror it and the colony
 * hairlines fade into it. Colours are composed in linear light, tone-mapped and gamma-encoded, then hazed toward uFog in
 * linear light as well (three stores Color uniforms linear), and gamma-encoded last, so a fully fogged fragment is exactly the sky.
 */

/** Sky colour along a world direction: fog at the horizon, #050407 at the zenith, a dusty 3-octave breakup near the ground. */
export const skyChunk = /* glsl */`
vec3 sky(vec3 d,vec3 fog,float hz,float t){
 float e=d.y;
 float n=0.,a=.5;vec3 q=d*vec3(2.6,5.2,2.6)+vec3(t*.012,0.,t*.008);for(int i=0;i<3;i++){n+=a*vnoise(q);q=q*2.1+vec3(1.3,7.7,3.1);a*=.5;}
 float k=smoothstep(hz,hz+.26,e+(n-.44)*.05);k=pow(k,.42);
 vec3 top=vec3(.0015,.0012,.0023);
 vec3 c=mix(fog,top,k);
 c*=1.+(n-.5)*.28*(1.-k);
 c+=fog*exp(-pow((e-hz)/.04,2.))*.18;
 c*=1.-.4*smoothstep(hz,hz-.25,e);
 return c;}
`;

export const skyVertex = /* glsl */`
uniform mat4 uProjInv;uniform mat4 uCamWorld;varying vec3 vRay;varying vec2 vUv;
void main(){vUv=uv;vec4 v=uProjInv*vec4(position.xy,1.,1.);vRay=mat3(uCamWorld)*(v.xyz/v.w);gl_Position=vec4(position.xy,1.,1.);}
`;
export const skyFragment = /* glsl */`
precision highp float;
uniform vec3 uFog;uniform float uTime;uniform float uHorizon;varying vec3 vRay;varying vec2 vUv;
${noise}
${skyChunk}
void main(){vec3 d=normalize(vRay);vec3 c=sky(d,uFog,uHorizon,uTime);
 float vignette=1.-.28*pow(length((vUv-vec2(.5,.42))*vec2(1.,.9)),1.8);c*=vignette;
 c=pow(max(c,0.),vec3(1./2.2))+(hash(vec3(gl_FragCoord.xy,floor(uTime*6.)))-.5)*.02;
 gl_FragColor=vec4(max(c,0.),1.);}
`;

/**
 * Terrain: flat-shaded (screen derivatives) so the dunes read low-poly; the planet's basalt→rust albedo lit by the key with the
 * home page's violet wrap; fragments at or below the pool level become a flat glossy surface that mirrors the sky with a
 * Fresnel weight and takes a hard specular from the key. Distance haze is exp(-d²k) toward the sky behind the fragment.
 */
export const terrainVertex = /* glsl */`
attribute float aRelief;varying vec3 vWorld;varying float vRelief;
void main(){vec4 w=modelMatrix*vec4(position,1.);vWorld=w.xyz;vRelief=aRelief;gl_Position=projectionMatrix*viewMatrix*w;}
`;
export const terrainFragment = /* glsl */`
precision highp float;
uniform vec3 uKey;uniform vec3 uCamera;uniform vec3 uFog;uniform float uTime;uniform float uPool;uniform float uFogK;uniform float uHorizon;
varying vec3 vWorld;varying float vRelief;
${noise}
${skyChunk}
void main(){
 vec3 n=normalize(cross(dFdx(vWorld),dFdy(vWorld)));if(n.y<0.)n=-n;
 vec3 toEye=uCamera-vWorld;float dist=length(toEye);vec3 eye=toEye/dist;vec3 key=normalize(uKey);
 float lowland=smoothstep(-1.,5.,vRelief);
 vec3 basalt=vec3(.045,.024,.018),rust=vec3(.27,.10,.05);vec3 albedo=mix(basalt,rust,lowland)*.32;
 float facet=.86+.28*hash(floor(vWorld*vec3(.41,.9,.41)+vec3(dot(n,vec3(7.3,3.1,5.7)))));
 float diffuse=pow(max(0.,dot(n,key)),1.6)*facet;
 vec3 c=albedo*(diffuse*.4*vec3(1.,.93,.84)+.005)+albedo*vec3(.07,.11,.30)*pow(max(0.,dot(n,normalize(vec3(.6,.5,.75)))),1.4)*.2;
 /* pools: flat, mirroring the sky with a Fresnel weight, a hard key glint */
 vec3 up=vec3(0.,1.,0.);float cosE=max(0.,eye.y);float f=.04+.96*pow(1.-cosE,5.);
 vec3 mirrored=sky(reflect(-eye,up),uFog,uHorizon,uTime);
 vec3 h=normalize(key+eye);float spec=pow(max(0.,dot(up,h)),420.)*1.2+pow(max(0.,dot(up,h)),14.)*.03;
 vec3 pc=vec3(.0025,.002,.0035)+mix(mirrored,uFog*.55,.4)*f*1.1+spec*vec3(1.,.93,.84)*(.2+.8*f);
 float pool=1.-smoothstep(uPool+.005,uPool+.05,vRelief);
 c=mix(c,pc,pool);
 c=c/(1.+c*.25);
 /* haze toward the sky behind the fragment, so the far terrain dissolves into it wherever the horizon falls */
 float haze=1.-exp(-dist*dist*uFogK);
 c=mix(c,sky(-eye,uFog,uHorizon,uTime),haze);
 float grain=(hash(vec3(gl_FragCoord.xy,floor(uTime*6.)))-.5)*.012;
 gl_FragColor=vec4(pow(max(c,0.),vec3(1./2.2))+grain,1.);}
`;

/** Hairline colony outlines and warm window lights, sinking into the fog with the terrain. */
export const colonyVertex = /* glsl */`
varying vec3 vWorld;uniform float uSize;
void main(){vec4 w=modelMatrix*vec4(position,1.);vWorld=w.xyz;gl_Position=projectionMatrix*viewMatrix*w;gl_PointSize=uSize;}
`;
export const colonyFragment = /* glsl */`
precision highp float;
uniform vec3 uColor;uniform vec3 uFog;uniform vec3 uCamera;uniform float uOpacity;uniform float uFogK;uniform float uPoint;uniform float uTime;uniform float uHorizon;varying vec3 vWorld;
${noise}
${skyChunk}
void main(){
 float m=1.;if(uPoint>.5){float r=length(gl_PointCoord-.5);if(r>.5)discard;m=smoothstep(.5,.15,r);}
 vec3 toEye=uCamera-vWorld;float dist=length(toEye);float haze=1.-exp(-dist*dist*uFogK);
 vec3 c=mix(uColor,sky(-toEye/dist,uFog,uHorizon,uTime)*2.2+.004,haze*.9);
 gl_FragColor=vec4(pow(c,vec3(1./2.2)),uOpacity*m*(1.-haze*.92));}
`;
