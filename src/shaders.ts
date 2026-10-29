export const noise = /* glsl */`
float hash(vec3 p){p=fract(p*.1031);p+=dot(p,p.yzx+33.33);return fract((p.x+p.y)*p.z);}
float vnoise(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);}
float fbm(vec3 p){float v=0.,a=.5;for(int i=0;i<5;i++){v+=a*vnoise(p);p=p*2.07+vec3(8.1,4.3,1.7);a*=.5;}return v;}
float ridged(vec3 p){float v=0.,a=.5;for(int i=0;i<4;i++){v+=a*(1.-abs(vnoise(p)*2.-1.));p=p*2.1+vec3(3.3,1.1,7.7);a*=.5;}return v;}
`;

export const bodyVertex = /* glsl */`
varying vec3 vNormal;varying vec3 vObject;varying vec3 vView;varying vec2 vUv;
void main(){vNormal=normalize(normalMatrix*normal);vObject=position;vUv=uv;vec4 mv=modelViewMatrix*vec4(position,1.);vView=mv.xyz;gl_Position=projectionMatrix*mv;}
`;

/** Thin sparse wireframe; back lines fade so the body still reads as a volume. */
export const wireVertex = /* glsl */`
attribute float aSeed;uniform float uReveal;varying float vFacing;varying float vShow;
void main(){vec3 n=normalize(normalMatrix*normal);vec4 mv=modelViewMatrix*vec4(position,1.);vFacing=dot(n,normalize(-mv.xyz));vShow=step(aSeed,uReveal);gl_Position=projectionMatrix*mv;}
`;
export const wireFragment = /* glsl */`
uniform float uOpacity;varying float vFacing;varying float vShow;
void main(){if(vShow<.5)discard;float a=mix(.16,1.,smoothstep(-.25,.45,vFacing));gl_FragColor=vec4(vec3(.93,.88,.80),a*uOpacity);}
`;

/** "observe": a lit checker, the uv-debug look. */
export const uvFragment = /* glsl */`
varying vec3 vNormal;varying vec3 vView;varying vec2 vUv;
void main(){vec2 g=floor(vec2(vUv.x*28.,vUv.y*14.));float checker=mod(g.x+g.y,2.);vec3 n=normalize(vNormal);
 float light=.35+.65*max(0.,dot(n,normalize(vec3(-.55,.6,.75))));float rim=pow(1.-max(0.,dot(n,normalize(-vView))),3.);
 vec3 c=mix(vec3(.13,.13,.14),vec3(.90,.86,.78),checker)*light;c=mix(c,vec3(.05),rim*.6);
 gl_FragColor=vec4(pow(c,vec3(1./2.2)),1.);}
`;

/** "evaluate": pastel normals, cooled toward blue and violet. */
export const normalFragment = /* glsl */`
varying vec3 vNormal;
void main(){vec3 n=normalize(vNormal);vec3 c=n*.5+.5;c=mix(c,vec3(.55,.62,1.),.18);c=mix(c,vec3(.78,.55,1.),smoothstep(-.3,.9,n.x)*.25);c=pow(c,vec3(.85));gl_FragColor=vec4(c,1.);}
`;

/** "refine": a violet-to-cyan transmission plate with drifting internal density. */
export const transmissionFragment = /* glsl */`
uniform float uTime;varying vec3 vNormal;varying vec3 vObject;varying vec3 vView;
${noise}
void main(){vec3 n=normalize(vNormal);float facing=max(0.,dot(n,normalize(-vView)));
 float density=fbm(vObject*2.4+vec3(0.,uTime*.05,uTime*.03));float veins=ridged(vObject*5.+density*1.5);
 vec3 magenta=vec3(.78,.14,.86),cyan=vec3(.42,.86,1.),deep=vec3(.26,.04,.42);
 vec3 c=mix(magenta,cyan,smoothstep(.35,.72,density+veins*.25));c=mix(c,deep,pow(1.-facing,1.6)*.75);
 c+=vec3(.5,.9,1.)*pow(veins,6.)*.35;gl_FragColor=vec4(c,1.);}
`;

export const beautyFragment = /* glsl */`
uniform float uTime;uniform float uFade;varying vec3 vNormal;varying vec3 vObject;varying vec3 vView;
${noise}
float craters(vec3 p,float scale,float depth){vec3 q=p*scale;vec3 cell=floor(q);float h=0.;
 for(int x=-1;x<=1;x++)for(int y=-1;y<=1;y++)for(int z=-1;z<=1;z++){vec3 c=cell+vec3(x,y,z);vec3 center=c+.5+(vec3(hash(c),hash(c+7.1),hash(c+3.7))-.5)*.7;
  float r=.18+hash(c+11.3)*.3;float d=length(q-center);if(hash(c+5.)>.55)continue;
  float bowl=smoothstep(r,r*.3,d)*depth;float rim=exp(-pow((d-r)/(r*.22),2.))*depth*.45;h+=rim-bowl;}
 return h;}
float height(vec3 p){vec3 s=normalize(p);float h=fbm(s*2.6+1.7)*.65+ridged(s*7.5)*.22+fbm(s*22.)*.06;
 h+=craters(s,3.2,.09)+craters(s,8.,.05)+craters(s,20.,.022);return h;}
void main(){vec3 n=normalize(vNormal);vec3 eye=normalize(-vView);vec3 s=normalize(vObject);
 vec3 t=normalize(cross(n,abs(n.y)<.95?vec3(0,1,0):vec3(1,0,0)));vec3 b=cross(n,t);
 float e=.004;float h0=height(s);float hx=height(normalize(s+t*e));float hy=height(normalize(s+b*e));
 vec3 pn=normalize(n-(t*(hx-h0)+b*(hy-h0))*22.);
 vec3 key=normalize(vec3(-.62,.5,.6));vec3 fill=normalize(vec3(.6,-.25,.75));
 float diffuse=max(0.,dot(pn,key));float soft=max(0.,dot(n,key));float wrap=pow(max(0.,dot(pn,fill)),1.4);
 float lowland=smoothstep(.25,.6,h0);float dust=smoothstep(.55,.95,fbm(s*4.+3.3));
 vec3 basalt=vec3(.045,.024,.018),rust=vec3(.27,.10,.05),pale=vec3(.36,.19,.12);
 vec3 albedo=mix(basalt,rust,lowland);albedo=mix(albedo,pale,dust*lowland*.45);albedo*=.8+.4*fbm(s*40.);
 float fresnel=pow(1.-max(0.,dot(n,eye)),3.2);vec3 rimColor=mix(vec3(.22,.38,1.),vec3(.52,.30,.95),smoothstep(-.6,.6,n.y));
 float terminator=smoothstep(-.08,.35,dot(n,key));vec3 c=albedo*(diffuse*terminator*1.7*vec3(1.,.93,.84)+.012)+albedo*wrap*vec3(.07,.11,.30)+rimColor*fresnel*(.12+soft*.75);
 float spec=pow(max(0.,dot(reflect(-key,pn),eye)),28.)*.08*lowland;c+=spec;
 float grain=(hash(vec3(gl_FragCoord.xy,floor(uTime*6.)))-.5)*.012;c=c/(1.+c*.25)+grain;
 gl_FragColor=vec4(pow(max(c,0.),vec3(1./2.2))*uFade,1.);}
`;

/** A slightly larger back-facing shell that gives the beauty pass its blue limb. */
export const atmosphereFragment = /* glsl */`
uniform float uFade;varying vec3 vNormal;varying vec3 vView;
void main(){vec3 n=normalize(vNormal);float inward=clamp(abs(dot(n,normalize(-vView)))/.24,0.,1.);float band=inward*inward*inward;
 vec3 c=mix(vec3(.2,.36,1.),vec3(.5,.3,.95),smoothstep(-.5,.7,n.y));float light=.12+.88*max(0.,dot(n,normalize(vec3(-.62,.5,.6))));
 gl_FragColor=vec4(c*band*light*uFade*.9,1.);}
`;

export const fullscreenVertex = /* glsl */`varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}`;

/** Panel background for the beauty pass: blue hour over the horizon. */
export const duskFragment = /* glsl */`
varying vec2 vUv;uniform vec4 uRect;
void main(){vec2 p=(gl_FragCoord.xy-uRect.xy)/uRect.zw;vec3 top=vec3(.016,.012,.034),mid=vec3(.07,.09,.26),low=vec3(.32,.22,.20);
 vec3 c=mix(mid,top,smoothstep(.35,1.,p.y));c=mix(low,c,smoothstep(0.,.42,p.y));c+=vec3(.25,.35,.7)*exp(-pow((p.y-.18)/.09,2.))*.35;
 gl_FragColor=vec4(c,1.);}
`;

/** The empty page itself: near-black, a faint pointer light and live grain, after Guillaume's void shader. */
export const voidFragment = /* glsl */`
uniform vec2 uPointer;uniform float uAspect;uniform float uTime;uniform float uLight;uniform float uHorizon;uniform float uWord;uniform sampler2D tWord;varying vec2 vUv;
float h2(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
void main(){vec2 d=vUv-uPointer;d.x*=uAspect;float r=length(d);
 vec3 c=vec3(.0196,.0157,.0275);float lamp=exp(-r*r*12.);c+=vec3(.05,.055,.14)*lamp*uLight;c+=vec3(.03,.015,.05)*exp(-r*r*2.6)*uLight*.5;
 float wh=.92*uAspect/4.;vec2 wuv=(vUv-vec2(.04,.5-wh*.5))/vec2(.92,wh);
 if(uWord>.001&&wuv.x>0.&&wuv.x<1.&&wuv.y>0.&&wuv.y<1.){float word=texture2D(tWord,wuv).r;c+=vec3(.86,.80,.72)*word*uWord*(.025+exp(-r*r*7.)*.5*uLight);}
 c+=vec3(.10,.16,.40)*exp(-pow(vUv.y/.26,2.))*uHorizon*.55;c+=vec3(.26,.14,.10)*exp(-pow(vUv.y/.09,2.))*uHorizon*.35;
 float vignette=1.-.35*pow(length((vUv-.5)*vec2(1.,.8)),1.6);c*=vignette;
 c+=(h2(gl_FragCoord.xy+floor(uTime*9.)*.37)-.5)*.022;gl_FragColor=vec4(max(c,0.),1.);}
`;

export const maskFragment = /* glsl */`void main(){gl_FragColor=vec4(1.);}`;

/** Hairline silhouette from the mask, revealed by an angular sweep during the intro. */
export const outlineFragment = /* glsl */`
uniform sampler2D tMask;uniform vec2 uTexel;uniform vec2 uCenter;uniform float uReveal;uniform float uOpacity;varying vec2 vUv;
void main(){float c=texture2D(tMask,vUv).r;float mx=c,mn=c;
 for(int i=-1;i<=1;i++)for(int j=-1;j<=1;j++){float s=texture2D(tMask,vUv+vec2(i,j)*uTexel).r;mx=max(mx,s);mn=min(mn,s);}
 float edge=mx-mn;if(edge<.02)discard;
 vec2 d=vUv-uCenter;float angle=fract(atan(d.x,d.y)/6.2831853+1.);float visible=step(angle,uReveal);
 float head=smoothstep(.06,0.,uReveal-angle)*step(uReveal,.999);
 vec3 col=mix(vec3(.90,.84,.75),vec3(1.),head);gl_FragColor=vec4(col,edge*uOpacity*visible*(.85+head*.6));}
`;
