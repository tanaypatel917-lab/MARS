/** A quiet generated drone so the sound toggle is real without shipping an audio file. */
export class Ambient {
  private context?: AudioContext;
  private gain?: GainNode;
  private analyser?: AnalyserNode;
  private readonly samples = new Float32Array(2048);
  private nodes: AudioNode[] = [];
  private sleepTimer?: ReturnType<typeof setTimeout>;
  get on() { return !!this.context && this.context.state === 'running' && (this.gain?.gain.value ?? 0) > 0; }
  async start() {
    this.context ??= new AudioContext();
    if (!this.gain) {
      this.gain = this.context.createGain();
      this.gain.gain.value = 0;
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = .6;
      this.gain.connect(this.analyser).connect(this.context.destination);
      for (const [frequency, level] of [[55, .05], [55.4, .04], [110.3, .015], [164.6, .006]]) {
        const oscillator = this.context.createOscillator();
        oscillator.type = 'sine';
        oscillator.frequency.value = frequency;
        const gain = this.context.createGain();
        gain.gain.value = level;
        oscillator.connect(gain).connect(this.gain);
        oscillator.start();
        this.nodes.push(oscillator, gain);
      }
      const seconds = 4;
      const buffer = this.context.createBuffer(1, this.context.sampleRate * seconds, this.context.sampleRate);
      const data = buffer.getChannelData(0);
      let last = 0;
      for (let i = 0; i < data.length; i++) { last = last * .985 + (Math.random() * 2 - 1) * .015; data[i] = last; }
      const noise = this.context.createBufferSource();
      noise.buffer = buffer;
      noise.loop = true;
      const filter = this.context.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 380;
      const noiseGain = this.context.createGain();
      noiseGain.gain.value = .5;
      noise.connect(filter).connect(noiseGain).connect(this.gain);
      noise.start();
      this.nodes.push(noise, filter, noiseGain);
    }
    clearTimeout(this.sleepTimer);
    await this.context.resume();
    this.gain!.gain.setTargetAtTime(.9, this.context.currentTime, 1.2);
  }
  /** Guillaume's break-click, synthesised: a stone crack (open) or a duller seal (close). Plays even when the drone is off, after a gesture. */
  crack(open: boolean) {
    const context = this.context ?? (this.context = new AudioContext());
    if (context.state !== 'running') void context.resume();
    const t = context.currentTime;
    const out = context.createGain(); out.gain.value = open ? .55 : .35; out.connect(context.destination);
    const length = Math.floor(context.sampleRate * (open ? .42 : .55));
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      const x = i / length;
      const env = open ? Math.exp(-x * 14) * (1 + (Math.random() < .004 ? 6 : 0)) : Math.exp(-(1 - x) * 9) * .8 + Math.exp(-x * 30) * .4;
      data[i] = (Math.random() * 2 - 1) * env;
    }
    const noise = context.createBufferSource(); noise.buffer = buffer;
    const band = context.createBiquadFilter(); band.type = 'bandpass'; band.frequency.value = open ? 1900 : 520; band.Q.value = open ? .7 : 1.4;
    noise.connect(band).connect(out); noise.start(t);
    const thump = context.createOscillator(); thump.type = 'sine';
    thump.frequency.setValueAtTime(open ? 140 : 90, t); thump.frequency.exponentialRampToValueAtTime(open ? 42 : 36, t + .35);
    const thumpGain = context.createGain(); thumpGain.gain.setValueAtTime(.0001, t);
    thumpGain.gain.exponentialRampToValueAtTime(open ? .9 : .5, t + .012); thumpGain.gain.exponentialRampToValueAtTime(.0001, t + (open ? .5 : .7));
    thump.connect(thumpGain).connect(out); thump.start(t); thump.stop(t + .75);
    thump.onended = () => { out.disconnect(); band.disconnect(); thumpGain.disconnect(); };
  }
  /** Time-domain samples of what is playing (silence when off); drives the button's waveform. */
  waveform(): Float32Array | undefined {
    if (!this.on || !this.analyser) return undefined;
    this.analyser.getFloatTimeDomainData(this.samples);
    return this.samples;
  }
  /** A soft click when a panel opens; silent unless the drone is on. */
  tick() {
    if (!this.on || !this.context || !this.gain) return;
    const oscillator = this.context.createOscillator();
    oscillator.type = 'triangle';
    oscillator.frequency.setValueAtTime(1320, this.context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(440, this.context.currentTime + .09);
    const gain = this.context.createGain();
    gain.gain.setValueAtTime(.05, this.context.currentTime);
    gain.gain.exponentialRampToValueAtTime(.0001, this.context.currentTime + .14);
    oscillator.connect(gain).connect(this.gain);
    oscillator.start();
    oscillator.stop(this.context.currentTime + .15);
  }
  stop() {
    if (!this.context || !this.gain) return;
    this.gain.gain.setTargetAtTime(0, this.context.currentTime, .4);
    clearTimeout(this.sleepTimer);
    this.sleepTimer = setTimeout(() => { void this.context?.suspend(); }, 2500);
  }
  dispose() {
    for (const node of this.nodes) if ('stop' in node) (node as AudioScheduledSourceNode).stop();
    void this.context?.close();
    this.context = undefined;
  }
}
