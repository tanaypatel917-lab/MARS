export const noise = /* glsl */`
float hash(vec3 p){p=fract(p*.1031);p+=dot(p,p.yzx+33.33);return fract((p.x+p.y)*p.z);}
float valueNoise(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);}
float fbm(vec3 p){float v=0.;float a=.5;for(int i=0;i<5;i++){v+=a*valueNoise(p);p=p*2.03+vec3(8.1,4.3,1.7);a*=.5;}return v;}
`;

export const planetVertex = /* glsl */`
varying vec3 vNormal;varying vec3 vPosition;varying vec3 vWorld;
void main(){vNormal=normalize(normalMatrix*normal);vPosition=position;vWorld=(modelViewMatrix*vec4(position,1)).xyz;gl_Position=projectionMatrix*vec4(vWorld,1);}
`;
export const planetFragment = /* glsl */`
uniform float uTime;uniform float uMars;varying vec3 vNormal;varying vec3 vPosition;varying vec3 vWorld;
${noise}
void main(){
 vec3 n=normalize(vNormal);vec3 eye=normalize(-vWorld);float facing=max(0.,dot(n,eye));float rim=pow(1.-facing,3.8);
 float light=max(0.,dot(n,normalize(vec3(-.7,.65,1.))));
 float terrain=fbm(normalize(vPosition)*7.);float detail=fbm(normalize(vPosition)*64.);
 vec3 rock=mix(vec3(.095,.025,.012),vec3(.34,.12,.047),smoothstep(.25,.8,terrain));
 vec3 craterPos=normalize(vPosition)*16.;vec3 cell=floor(craterPos);
 vec3 craterCenter=.25+vec3(hash(cell),hash(cell+1.23),hash(cell+2.91))*.5;
 float craterDistance=length(fract(craterPos)-craterCenter);float craterRadius=.09+hash(cell+4.5)*.15;
 float bowl=1.-smoothstep(craterRadius*.65,craterRadius,craterDistance);
 float lip=exp(-pow((craterDistance-craterRadius)/.025,2.));rock*=1.-bowl*.55+lip*.25;
 vec3 abstract=vec3(.004,.004,.013)+vec3(.012,.015,.035)*light*terrain;
 vec3 base=mix(abstract,rock*(.08+light*.8)*(.7+detail*.5),uMars);
 vec3 edge=mix(vec3(.15,.22,.9),vec3(.36,.14,.78),smoothstep(-.7,.5,n.y));
 base+=edge*rim*(.06+light*.50);float grain=(hash(vec3(gl_FragCoord.xy,floor(uTime*8.)))-.5)*.016;
 gl_FragColor=vec4(max(base+grain,0.),1.);
}
`;

export const fullscreenVertex = /* glsl */`
varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0,1);}
`;
export const atmosphereFragment = /* glsl */`
uniform vec2 uCenter;uniform float uRadius;uniform float uAspect;uniform float uOpacity;uniform float uTime;varying vec2 vUv;
float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
void main(){
 vec2 d=vUv-uCenter;d.x*=uAspect;float radius=length(d);float edge=radius-uRadius;
 if(edge<-.001||uOpacity<.001)discard;
 float breath=1.+.05*sin(uTime*.4);float tight=exp(-max(edge,0.)/.0028);
 float blue=exp(-max(edge,0.)/.022)*.37;float violet=exp(-max(edge,0.)/.065)*.15;
 float side=.22+.78*smoothstep(-.75,.75,d.y/uRadius-d.x/uRadius*.3);
 float density=(tight*.8+blue+violet)*side*breath;
 float random=h(floor(gl_FragCoord.xy/1.2)+floor(uTime*7.)*.17);
 if(density<.002||random>density)discard;
 vec3 color=mix(vec3(.17,.30,.98),vec3(.48,.22,.82),smoothstep(.008,.08,edge));
 float intensity=mix(.28,.8,tight)*side;
 gl_FragColor=vec4(color*intensity,uOpacity*.65);
}
`;

export const particleVertex = /* glsl */`
attribute vec3 aSeed;uniform float uTime;uniform float uProgress;uniform float uPhase;uniform float uOpacity;
varying float vAlpha;varying float vHue;varying vec2 vUv;
const float TAU=6.2831853;
void main(){
 float t=aSeed.x*TAU+uTime*.055;float r=2.18+(aSeed.y-.5)*.045;
 float phase=uPhase;float spread=mix(.21,.012,smoothstep(0.,3.,phase));
 if(phase>.5&&phase<1.5)r=2.18+(floor(aSeed.y*3.)-1.)*.065;
 float theta=t;
 if(phase>1.5)theta=floor(aSeed.x*84.)/84.*TAU+uTime*.07;
 if(phase>2.5)theta=aSeed.x*TAU+uTime*.12;
 vec3 ring=vec3(cos(theta)*r,sin(theta)*r*.68,sin(theta)*r*.74);
 ring+=vec3(1.78,0.,0.);
 ring+=vec3(sin(aSeed.z*130.),cos(aSeed.z*91.),sin(aSeed.z*71.))*spread*(.3+aSeed.y);
 vec2 centered=ring.xy-vec2(1.78,0.);float turn=-.25+uTime*.008;
 ring.xy=mat2(cos(turn),sin(turn),-sin(turn),cos(turn))*centered+vec2(1.78,0.);
 vec3 diffuse=vec3((aSeed.x-.5)*14.,(aSeed.y-.5)*9.,(aSeed.z-.5)*7.);
 float travel=fract(aSeed.x+uTime*.04);vec3 trail=vec3(-2.+travel*8.,-.9+pow(travel,1.5)*2.8,sin(travel*3.)*.5);
 trail+=vec3(0.,sin(aSeed.z*90.),cos(aSeed.y*80.))*.055;
 float focus=smoothstep(.19,.37,uProgress);vec3 pos=mix(diffuse,trail,focus);
 pos=mix(pos,ring,smoothstep(.36,.43,uProgress));
 float size=.008+aSeed.z*.015;
 vec4 mv=modelViewMatrix*vec4(pos,1);mv.xy+=position.xy*size;
 gl_Position=projectionMatrix*mv;vUv=uv;vAlpha=uOpacity*(.2+.8*aSeed.y);vHue=aSeed.z;
}
`;
export const particleFragment = /* glsl */`
varying vec2 vUv;varying float vAlpha;varying float vHue;
void main(){float d=length(vUv-.5)*2.;if(d>1.)discard;float a=exp(-d*d*6.)*vAlpha;vec3 c=mix(vec3(.32,.40,1.),vec3(.72,.56,1.),vHue);gl_FragColor=vec4(c,a);}
`;

export const ringVertex = /* glsl */`
varying vec3 vPosition;varying vec3 vNormal;void main(){vPosition=position;vNormal=normal;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}
`;
export const ringFragment = /* glsl */`
varying vec3 vPosition;varying vec3 vNormal;uniform float uTime;uniform float uOpacity;uniform float uPhase;
void main(){float t=atan(vPosition.y,vPosition.x);float shimmer=.7+.3*sin(t*3.-uTime*.4);float highlight=pow(max(0.,sin(t-.6)),12.);vec3 c=mix(vec3(.19,.25,.75),vec3(.65,.46,.95),sin(t)*.5+.5);c+=highlight*.6;float section=1.;if(uPhase>1.5&&uPhase<2.5)section=.25+.75*smoothstep(.1,.3,sin(t*12.));gl_FragColor=vec4(c*shimmer,uOpacity*section);}
`;

export const skyFragment = /* glsl */`
uniform float uArrival;uniform float uTime;uniform float uAspect;varying vec2 vUv;
${noise}
void main(){vec3 color=vec3(.0196,.0157,.0392);vec2 sun=vec2(.73,.435);vec2 d=vUv-sun;d.x*=uAspect;float dist=length(d);
 vec3 dusk=vec3(.014,.008,.018);dusk+=vec3(.085,.039,.030)*exp(-abs(vUv.y-.31)*8.);
 dusk+=vec3(.07,.12,.28)*exp(-dist*dist/.065);dusk+=vec3(.19,.32,.58)*exp(-dist*dist/.004);
 dusk+=vec3(.70,.78,.98)*exp(-dist*dist/.000009);
 color=mix(color,dusk,uArrival);gl_FragColor=vec4(color,1.);}
`;

export const terrainVertex = /* glsl */`
varying vec3 vPosition;varying float vHeight;
${noise}
float height(vec2 p){float h=fbm(vec3(p*.065,2.));float ridge=pow(1.-abs(valueNoise(vec3(p*.11,4.))*2.-1.),3.);return h*5.+ridge*1.7;}
void main(){vec3 p=position;p.y=height(p.xz)-3.;vPosition=p;vHeight=p.y;gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);}
`;
export const terrainFragment = /* glsl */`
varying vec3 vPosition;varying float vHeight;uniform float uOpacity;
${noise}
void main(){vec3 n=normalize(cross(dFdx(vPosition),dFdy(vPosition)));float sun=max(0.,dot(n,normalize(vec3(.7,.3,-.7))));float detail=fbm(vPosition*1.8);
 vec3 rust=mix(vec3(.075,.027,.021),vec3(.29,.105,.045),detail);rust*=.50+sun*.75;
 float distance=-vPosition.z;float fog=1.-exp(-max(0.,distance)*.023);
 vec3 col=mix(rust,vec3(.095,.071,.095),fog*.80);col+=vec3(.04,.04,.085)*pow(sun,2.);
 gl_FragColor=vec4(col,uOpacity);}
`;

export const gradeFragment = /* glsl */`
uniform sampler2D tDiffuse;uniform float uTime;varying vec2 vUv;
float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
void main(){vec3 c=texture2D(tDiffuse,vUv).rgb;float vignette=1.-.20*pow(length((vUv-.5)*vec2(1.1,.8)),1.5);c*=vignette;float grain=(h(gl_FragCoord.xy+floor(uTime*12.))-.5)*.0035;c+=grain;gl_FragColor=vec4(max(c,0.),1.);}
`;
